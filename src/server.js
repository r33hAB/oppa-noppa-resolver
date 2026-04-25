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
import { createReadStream } from 'node:fs';
import { resolveChain, probeAvailability } from './chain.js';
import { fetchAniList } from './anilist.js';
import { tryKitsuFallback } from './anilist-kitsu-shim.js';
import { startSession, readPlaylist, getSegmentPath, stopSession, ffmpegVersion } from './transcoder.js';

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
app.get('/health', async () => ({ ok: true, ts: Date.now(), ffmpeg: await ffmpegVersion() }));

/**
 * Signed stream-URL generator. Response body is JSON with `url` that the
 * player can hand directly to <video> or hls.js. Behaviour now depends
 * on which provider the chain picked:
 *   - anime.nexus (primary) returns a direct manifest URL. The client
 *     plays it natively — no proxy hop, no transcode.
 *   - miruro (fallback) still routes through `/stream/:token` so we can
 *     inject the Referer header Safari can't set from JS.
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
    const resolved = await resolveChain({ anilistId, ep, dub, log: req.log });
    if (!resolved) return reply.code(404).send({ error: 'no playable source' });

    const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;

    if (resolved.provider === 'animenexus') {
      // We previously returned the bare api.anime.nexus URL here, but
      // anime.nexus doesn't send Access-Control-Allow-Origin for our
      // PWA origin (their CORS only allows https://anime.nexus). The
      // browser blocks the manifest fetch. Route through our signed
      // /stream proxy instead — same path miruro takes — so the
      // anime.nexus origin never sees the browser at all.
      const ANIMENEXUS_REFERER = 'https://anime.nexus/';
      const selfBase = `${proto}://${host}`;
      const token = signStreamToken({ url: resolved.directUrl, referer: ANIMENEXUS_REFERER });
      return {
        url: `${selfBase}/stream/${token}`,
        provider: 'animenexus',
        audioLanguages: resolved.audioLanguages,
        subtitles: wrapSubtitles(resolved.subtitles, ANIMENEXUS_REFERER, selfBase),
        expiresAt: Date.now() + TOKEN_TTL_SEC * 1000,
      };
    }

    // Miruro — sign and serve through our Referer-injecting proxy.
    const token = signStreamToken({ url: resolved.upstreamUrl, referer: resolved.referer ?? '' });
    return {
      url: `${proto}://${host}/stream/${token}`,
      provider: 'miruro',
      expiresAt: Date.now() + TOKEN_TTL_SEC * 1000,
    };
  } catch (err) {
    req.log.error({ err: err.message }, 'resolve failed');
    return reply.code(502).send({ error: 'upstream failed', detail: err.message });
  }
});

/**
 * Availability probe for the AnimePage DUB toggle. The mobile client
 * calls this on load so it can disable DUB for shows/episodes that have
 * no English audio, preventing the "click DUB, get sub-fallback" trap.
 *
 * Uses anime.nexus's per-episode `audio_languages` metadata. If nexus
 * is unreachable, we default to both-available (optimistic) rather than
 * breaking the toggle during provider outages.
 */
app.get('/availability', async (req, reply) => {
  const anilistId = Number(req.query.anilistId);
  const ep = Number(req.query.ep);
  if (!Number.isInteger(anilistId) || anilistId <= 0) return reply.code(400).send({ error: 'bad anilistId' });
  if (!Number.isInteger(ep) || ep <= 0) return reply.code(400).send({ error: 'bad ep' });
  const a = await probeAvailability({ anilistId, ep, log: req.log });
  return a;
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
 * Transcoded-session flow. Use this instead of /resolve for browser
 * playback — the upstream HLS uses HE-AACv2 audio which Chrome + Firefox
 * MSE can't decode. This endpoint spawns a long-running ffmpeg that
 * re-muxes audio to LC-AAC; returns a playlist URL the PWA hands to
 * hls.js or <video src>.
 *
 * Flow:
 *   1. POST /session/start?anilistId=&ep=&dub= → resolves upstream m3u8
 *      via Playwright, spawns ffmpeg, waits for first segment, returns
 *      { sessionId, playlistUrl }.
 *   2. GET /session/:id/playlist.m3u8 → ffmpeg's own output, served
 *      straight from disk. Never cached at the edge (growing VOD).
 *   3. GET /session/:id/seg<N>.ts → segments ffmpeg has written so far.
 *      Range-supported by createReadStream's native Fastify adapter.
 *   4. POST /session/:id/stop → best-effort early teardown. Otherwise
 *      the idle reaper kills it after 5 minutes of no reads.
 */
app.post('/session/start', async (req, reply) => {
  const q = req.query;
  const anilistId = Number(q.anilistId);
  const ep = Number(q.ep);
  const dub = String(q.dub) === 'true';
  if (!Number.isInteger(anilistId) || anilistId <= 0) return reply.code(400).send({ error: 'bad anilistId' });
  if (!Number.isInteger(ep) || ep <= 0) return reply.code(400).send({ error: 'bad ep' });

  let resolved;
  try {
    resolved = await resolveChain({ anilistId, ep, dub, log: req.log });
  } catch (err) {
    req.log.error({ err: err.message }, 'chain failed');
    return reply.code(502).send({ error: 'chain failed', detail: err.message });
  }
  if (!resolved) return reply.code(404).send({ error: 'no playable source' });

  // anime.nexus serves Opus-in-fMP4 that the browser can play directly;
  // no ffmpeg session needed. BUT we can't hand back the bare
  // api.anime.nexus URL — they don't send Access-Control-Allow-Origin
  // for our PWA origin and the manifest fetch gets CORS-blocked.
  // Route the manifest through our /stream signed proxy (same path
  // miruro takes); the rewriter will re-sign every inner segment +
  // subtitle URI so the browser only ever talks to us. Empty
  // sessionId still means "no ffmpeg teardown needed".
  if (!resolved.needsTranscode) {
    const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    const selfBase = `${proto}://${host}`;
    const ANIMENEXUS_REFERER = 'https://anime.nexus/';
    const token = signStreamToken({ url: resolved.directUrl, referer: ANIMENEXUS_REFERER });
    return {
      sessionId: '',
      playlistUrl: `${selfBase}/stream/${token}`,
      provider: resolved.provider,
      audioLanguages: resolved.audioLanguages,
      subtitles: wrapSubtitles(resolved.subtitles, ANIMENEXUS_REFERER, selfBase),
    };
  }

  // Miruro path — remux HE-AACv2 → LC-AAC via ffmpeg so Chrome/Firefox
  // MSE can decode the audio.
  let session;
  try {
    session = await startSession({ upstreamUrl: resolved.upstreamUrl });
  } catch (err) {
    req.log.error({ err: err.message }, 'session start failed');
    return reply.code(502).send({ error: 'transcoder failed', detail: err.message });
  }

  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return {
    sessionId: session.id,
    playlistUrl: `${proto}://${host}/session/${session.id}/playlist.m3u8`,
    provider: resolved.provider,
  };
});

app.get('/session/:id/playlist.m3u8', async (req, reply) => {
  const body = await readPlaylist(req.params.id);
  if (body == null) return reply.code(404).send('no such session');
  reply.header('content-type', 'application/vnd.apple.mpegurl');
  // Don't cache — playlist grows segment-by-segment while ffmpeg runs.
  reply.header('cache-control', 'no-store');
  return reply.send(body);
});

app.get('/session/:id/:segment', async (req, reply) => {
  const { id, segment } = req.params;
  const path = getSegmentPath(id, segment);
  if (!path) return reply.code(404).send('no such session or segment');
  try {
    reply.header('content-type', 'video/mp2t');
    reply.header('accept-ranges', 'bytes');
    reply.header('cache-control', 'public, max-age=3600');
    return reply.send(createReadStream(path));
  } catch (err) {
    req.log.error({ err: err.message }, 'segment read failed');
    return reply.code(502).send({ error: 'segment read failed' });
  }
});

app.post('/session/:id/stop', async (req, reply) => {
  stopSession(req.params.id);
  return reply.send({ ok: true });
});

/**
 * AniList passthrough. Lets the PWA hit us (same-origin through CF) for
 * search/detail/schedule without re-registering as an AniList client.
 *
 * Each successful response is cached in-memory keyed by the {query,
 * variables} pair. When AniList itself is down (e.g. the 2026-04
 * outage), we serve the last-known-good payload as a stale response so
 * the PWA's home/search/library pages stay loadable instead of erroring.
 * Stale responses include `_stale: true` so the client can choose to
 * surface a banner if it cares. No persistence — Railway redeploys clear
 * the cache, which is fine; the next cold call rewarms from AniList.
 */
const anilistCache = new Map(); // key: JSON({query, variables}) → { data, fetchedAt }
const ANILIST_CACHE_MAX = 500;

function anilistCacheKey(query, variables) {
  // Normalise query whitespace so equivalent calls share a cache slot.
  return JSON.stringify({ q: query.replace(/\s+/g, ' ').trim(), v: variables ?? {} });
}

app.post('/anilist', async (req, reply) => {
  const { query, variables } = req.body ?? {};
  if (typeof query !== 'string') return reply.code(400).send({ error: 'missing query' });
  const key = anilistCacheKey(query, variables);
  try {
    const data = await fetchAniList(query, variables ?? {});
    anilistCache.set(key, { data, fetchedAt: Date.now() });
    // Crude bounded-size eviction: drop the oldest insertion when we
    // exceed the cap. Map preserves insertion order, so the first key
    // is the oldest. Keeps memory predictable; we don't need true LRU.
    if (anilistCache.size > ANILIST_CACHE_MAX) {
      const oldest = anilistCache.keys().next().value;
      if (oldest != null) anilistCache.delete(oldest);
    }
    return data;
  } catch (err) {
    // Layer 1: stale cache (most relevant data when AniList was last up).
    const cached = anilistCache.get(key);
    if (cached) {
      req.log.warn({ err: err.message, ageSec: Math.round((Date.now() - cached.fetchedAt) / 1000) }, 'anilist failed; serving stale cache');
      return { ...cached.data, _stale: true, _staleAgeSec: Math.round((Date.now() - cached.fetchedAt) / 1000) };
    }
    // Layer 2: Kitsu shim (when cache is cold but the query type is one
    // we know how to translate — trending, seasonal, detail, search, batch).
    try {
      const fallback = await tryKitsuFallback(query, variables);
      if (fallback) {
        req.log.warn({ err: err.message }, 'anilist failed; serving Kitsu fallback');
        // Cache the fallback under the same key so subsequent identical
        // calls during the outage don't re-fan-out to Kitsu either.
        anilistCache.set(key, { data: fallback, fetchedAt: Date.now() });
        return { ...fallback, _stale: true, _fallback: 'kitsu' };
      }
    } catch (fbErr) {
      req.log.warn({ err: fbErr.message }, 'kitsu fallback also failed');
    }
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

/**
 * Take whatever shape the scraper handed us for subtitles (either an
 * array of plain URL strings or `{url, language, name}` objects) and
 * rewrite each track's URL through our signed /stream proxy so the
 * browser doesn't blow up on CORS when fetching the .vtt/.ass file
 * directly from assets.anime.nexus.
 */
function wrapSubtitles(subs, referer, selfBase) {
  if (!Array.isArray(subs)) return [];
  return subs.map((s) => {
    const url = typeof s === 'string' ? s : s?.url;
    if (!url) return s;
    const token = signStreamToken({ url, referer });
    const proxied = `${selfBase}/stream/${token}`;
    return typeof s === 'string'
      ? proxied
      : { ...s, url: proxied };
  });
}

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
