// Oppa Noppa resolver — a thin HTTP service that:
//
//   1. Wraps the miruro.to stream tap (scraper) so the PWA never has to
//      run Chromium itself. Playwright does the browser work here.
//   2. Proxies AniList queries (search, detail, schedule) for the PWA
//      so we can cache responses at the edge and control rate limits.
//   3. Relays the AniList OAuth code exchange because the client secret
//      must not live in the PWA bundle.
//   4. Serves a stream proxy (`/stream/:token`) that injects the
//      miruro Referer header — Safari forbids setting it from JS, so
//      we do it server-side.
//
// Why Fastify: fast cold starts (matters on Railway free-tier), tiny
// dep tree, built-in CORS + rate limit plugins, no surprises.

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import crypto from 'node:crypto';
import { resolveMiruro } from './scrapers/miruro.js';
import { fetchAniList } from './anilist.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
// Allowed Origin(s) for the PWA. Set in Railway env. Default only
// accepts local dev — production deploy sets ALLOWED_ORIGINS to the
// app.oppanoppa.com host.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// Secret used to HMAC-sign stream tokens. Set in Railway env; any
// random 32+ char string. Rotating it invalidates all issued tokens.
const SIGNING_SECRET = process.env.SIGNING_SECRET
  ?? (process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('SIGNING_SECRET env var is required in production'); })()
    : 'dev-secret-do-not-use-in-prod');

const TOKEN_TTL_SEC = 60 * 10; // 10 min — covers reasonable episode watch time

// maxParamLength defaults to 100 and silently 404s longer path params.
// Our stream tokens are ~400 chars (base64url + HMAC), so bump the cap.
// 4096 is well over any reasonable token length and well under any
// router-tree memory concerns.
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024, maxParamLength: 4096 });

await app.register(cors, {
  origin: (origin, cb) => {
    // Same-origin / curl / no origin → allow (healthcheck, server-to-server).
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`origin not allowed: ${origin}`), false);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
});

await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  allowList: (req) => req.url === '/health',
});

/**
 * Health check — Railway pings this. Must stay cheap and dependency-free;
 * don't touch the scraper or AniList from here.
 */
app.get('/health', async () => ({ ok: true, ts: Date.now() }));

/**
 * Signed stream-URL generator. Response body is JSON with `url` that the
 * player can hand directly to <video>. The URL points at our own
 * `/stream/:token` proxy so Safari gets the right Referer injected.
 */
app.get('/resolve', async (req, reply) => {
  const q = req.query;
  const anilistId = Number(q.anilistId);
  const ep = Number(q.ep);
  const dub = String(q.dub) === 'true';
  if (!Number.isInteger(anilistId) || anilistId <= 0) {
    return reply.code(400).send({ error: 'bad anilistId' });
  }
  if (!Number.isInteger(ep) || ep <= 0) {
    return reply.code(400).send({ error: 'bad ep' });
  }

  try {
    const tapped = await resolveMiruro({ anilistId, ep, dub });
    if (!tapped) return reply.code(404).send({ error: 'no playable source' });
    const token = signStreamToken({ url: tapped.url, referer: tapped.referer ?? '' });
    // Absolute URL back to our own /stream proxy. The PWA doesn't need
    // to know the upstream host — it just plays this.
    const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    const proxyUrl = `${proto}://${host}/stream/${token}`;
    return { url: proxyUrl, expiresAt: Date.now() + TOKEN_TTL_SEC * 1000 };
  } catch (err) {
    req.log.error({ err: err.message }, 'resolve failed');
    return reply.code(502).send({ error: 'upstream failed', detail: err.message });
  }
});

/**
 * Stream proxy. The token encodes the real upstream URL and the Referer
 * miruro's CDN expects. We forward the request body-less, stream the
 * response back. Signed with HMAC so arbitrary URLs can't be injected.
 */
app.get('/stream/:token', async (req, reply) => {
  const tok = verifyStreamToken(req.params.token);
  if (!tok) return reply.code(403).send('bad token');

  // Honor Range so <video> seeking works.
  const forwardHeaders = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    Referer: tok.referer || 'https://www.miruro.to/',
  };
  if (req.headers.range) forwardHeaders.Range = req.headers.range;

  const upstream = await fetch(tok.url, { headers: forwardHeaders, redirect: 'follow' });
  const ct = upstream.headers.get('content-type') ?? 'application/octet-stream';
  reply.code(upstream.status);

  // HLS manifest? Rewrite every inner URL (segments, keys, subtitle
  // tracks) to point back through our /stream proxy so downstream
  // fetches also get the Referer header injected. Without this, Safari
  // fires direct requests to pro.ultracloud.cc and gets 403s.
  const isManifest = /application\/(vnd\.apple\.mpegurl|x-mpegurl)/i.test(ct) ||
    /\.m3u8(\?|$)/i.test(tok.url);
  if (isManifest) {
    const body = await upstream.text();
    const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    const selfBase = `${proto}://${host}`;
    const rewritten = rewriteHlsManifest(body, tok.url, tok.referer, selfBase);
    reply.header('content-type', 'application/vnd.apple.mpegurl');
    reply.header('cache-control', 'public, max-age=30');
    return reply.send(rewritten);
  }

  reply.header('content-type', ct);
  const passthrough = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];
  for (const h of passthrough) {
    const v = upstream.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.header('cache-control', 'public, max-age=60');
  return reply.send(upstream.body);
});

/**
 * Rewrite an HLS manifest so every inner URL (segments, AES keys,
 * subtitle playlists, nested variant manifests) routes back through
 * our /stream proxy. This preserves the same signed-token semantics
 * — each rewritten URL gets its own short-lived token binding the
 * inner URL + the right Referer.
 *
 * We re-sign because the client never sees the upstream URLs, which
 * is what we want (no direct hits to the CDN from Safari). The Referer
 * is the same one the parent manifest was fetched with, so all inner
 * requests arrive at the CDN with the header it expects.
 */
function rewriteHlsManifest(body, parentUrl, referer, selfBase) {
  const parent = new URL(parentUrl);
  const resolveInner = (raw) => {
    try {
      // Handle relative URIs by resolving against the parent manifest.
      const absolute = new URL(raw, parent).toString();
      const token = signStreamToken({ url: absolute, referer });
      return `${selfBase}/stream/${token}`;
    } catch {
      return raw;
    }
  };

  const lines = body.split(/\r?\n/);
  return lines.map((line) => {
    // Blank lines pass through.
    if (!line) return line;
    // Any tag that embeds a URI=... inline: rewrite the quoted URI.
    // Covers #EXT-X-KEY, #EXT-X-MEDIA, #EXT-X-I-FRAME-STREAM-INF, etc.
    if (line.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${resolveInner(uri)}"`);
    }
    // Non-tag lines are segment/playlist URIs.
    return resolveInner(line);
  }).join('\n');
}

/**
 * AniList passthrough. Lets the PWA hit us (same-origin through CF) for
 * search/detail/schedule without re-registering as an AniList client.
 * We do not cache these; AniList's TTL is fine.
 */
app.post('/anilist', async (req, reply) => {
  const { query, variables } = req.body ?? {};
  if (typeof query !== 'string') return reply.code(400).send({ error: 'missing query' });
  try {
    const data = await fetchAniList(query, variables ?? {});
    return data;
  } catch (err) {
    return reply.code(502).send({ error: err.message });
  }
});

/**
 * AniList OAuth code exchange. The PWA sends the `code` it got after the
 * user approved, we swap it for an access token using our client secret,
 * and hand the token back. Secret never reaches the device.
 */
app.post('/auth/anilist/exchange', async (req, reply) => {
  const { code, redirectUri } = req.body ?? {};
  if (!code) return reply.code(400).send({ error: 'missing code' });
  const clientId = process.env.ANILIST_MOBILE_CLIENT_ID;
  const clientSecret = process.env.ANILIST_MOBILE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return reply.code(503).send({ error: 'OAuth not configured' });
  }
  try {
    const res = await fetch('https://anilist.co/api/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });
    const body = await res.json();
    if (!res.ok) return reply.code(res.status).send(body);
    return body;
  } catch (err) {
    return reply.code(502).send({ error: err.message });
  }
});

/* ---- helpers ---- */

function signStreamToken({ url, referer }) {
  const payload = { u: url, r: referer, e: Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC };
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', SIGNING_SECRET).update(b64).digest('base64url');
  return `${b64}.${mac}`;
}

function verifyStreamToken(token) {
  const [b64, mac] = String(token).split('.');
  if (!b64 || !mac) return null;
  const expected = crypto.createHmac('sha256', SIGNING_SECRET).update(b64).digest('base64url');
  // Constant-time compare so a malicious client can't time-side-channel
  // the HMAC byte-by-byte. Buffer lengths must match.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (typeof payload.e !== 'number' || payload.e * 1000 < Date.now()) return null;
    return { url: payload.u, referer: payload.r };
  } catch {
    return null;
  }
}

app.listen({ port: PORT, host: HOST })
  .then(() => app.log.info(`resolver up on ${HOST}:${PORT}`))
  .catch((err) => { app.log.error(err); process.exit(1); });
