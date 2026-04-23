// Miruro stream tap — headless Chromium via Playwright, port of the
// Electron-based BrowserWindow tap in the desktop app
// (src/main/providers/headless/miruro.ts).
//
// Strategy: open the /watch page, intercept every request, accept the
// first one that looks like an HLS manifest or MP4. Miruro's player
// rotates upstream providers (kiwi, arc, etc.) — whatever the page
// picks is what we use. 25-second budget so the page has time to run
// its full resolve flow.
//
// Context reuse: Playwright "browsers" are expensive to boot (~3s);
// "contexts" are cheap (<100ms). We keep one browser singleton for the
// whole process and spawn a fresh context per resolve so cookies and
// localStorage don't leak across users.

import { chromium } from 'playwright-chromium';

const MIRURO_BASE = 'https://www.miruro.to';
// Desktop Safari UA — same one the Electron tap uses. Using a mobile UA
// makes miruro serve a different player bundle that doesn't follow the
// same m3u8-request pattern our intercept relies on.
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const PAGE_BUDGET_MS = 25_000;

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      // Reduce surface area — we don't need audio, don't need GPU, and
      // --no-sandbox is required on Railway's containerized Linux since
      // userns isn't available.
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--mute-audio',
        '--no-zygote',
      ],
    }).catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

function looksLikeHls(url) {
  const u = url.toLowerCase();
  return u.includes('.m3u8') || u.includes('/m3u8/');
}
function looksLikeMp4(url) {
  return /\.mp4(\?|$)/i.test(url);
}

export async function resolveMiruro({ anilistId, ep, dub }) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: DESKTOP_UA,
    serviceWorkers: 'block',
  });
  const page = await ctx.newPage();

  let captured = null;

  const accept = (url, headers) => {
    // Reject the junk categories we know don't play.
    if (/thumbnail|preview|sprite/i.test(url)) return;
    // Miruro probes empty `u=` signatures during provider rotation —
    // skip those; accept only the real signed one.
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('u') && !parsed.searchParams.get('u')) return;
    } catch { /* malformed — fall through */ }
    if (captured) return;
    captured = { url, referer: headers['referer'] ?? headers['Referer'] ?? `${MIRURO_BASE}/` };
  };

  // Block only the heaviest non-essential resources. Images and fonts
  // are pure weight. Everything else (scripts, xhr, media manifests,
  // stylesheets) must go through for the player to function.
  //
  // NOTE: Playwright's page.route fires BEFORE page.on('request'), and
  // an aborted request doesn't emit 'request' — so the resource-block
  // is also a request filter. Keep the image/font list tight.
  await page.route('**/*', async (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font') return route.abort().catch(() => {});
    return route.continue().catch(() => {});
  });

  page.on('request', (req) => {
    const url = req.url();
    if (process.env.DEBUG_SCRAPER) {
      console.log('[miruro-req]', req.method(), req.resourceType(), url.slice(0, 200));
    }
    if (looksLikeHls(url) || looksLikeMp4(url)) {
      accept(url, req.headers());
    }
  });
  if (process.env.DEBUG_SCRAPER) {
    page.on('response', (res) => {
      if (res.status() >= 400) console.log('[miruro-res]', res.status(), res.url().slice(0, 200));
    });
    page.on('pageerror', (err) => console.log('[miruro-pageerror]', err.message));
    page.on('console', (msg) => {
      if (['error', 'warning'].includes(msg.type())) console.log('[miruro-console]', msg.type(), msg.text().slice(0, 300));
    });
    page.on('requestfailed', (req) => console.log('[miruro-reqfail]', req.url().slice(0, 200), req.failure()?.errorText));
  }

  const watchUrl = `${MIRURO_BASE}/watch?id=${anilistId}&ep=${ep}${dub ? '&type=dub' : ''}`;

  try {
    // Kick off navigation but don't await — we race against PAGE_BUDGET_MS
    // or captured, whichever comes first.
    page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_BUDGET_MS })
      .catch((err) => {
        if (process.env.DEBUG_SCRAPER) console.log('[miruro-goto-err]', err.message);
      });
    const start = Date.now();
    while (!captured && Date.now() - start < PAGE_BUDGET_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  return captured;
}

/**
 * Graceful shutdown — called when Railway sends SIGTERM. Closing the
 * browser cleanly prevents ~50MB of zombie Chromium on restart.
 */
export async function shutdownMiruro() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch { /* ignore */ }
  browserPromise = null;
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, async () => { await shutdownMiruro(); process.exit(0); });
}
