// anime.nexus scraper. Pure HTTP — no Playwright needed. Their
// `api.anime.nexus` is a public JSON API (CORS-locked for browsers, but
// server-to-server requests go through fine). Miruro uses a headless
// browser because the player tokenises m3u8 URLs client-side; anime.nexus
// hands the tokenised URL back directly from the JSON endpoint.
//
// Flow for a single playback:
//   1. searchShow(title)            → [{id, name, name_alt, release_date, ...}]
//   2. match against AniList title  → showUuid (cached per-anilistId)
//   3. listEpisodes(showUuid)       → [{id, number, video_meta:{audio_languages}}]
//   4. pick the row where number === ep; if dub requested, confirm
//      `audio_languages` contains an English entry
//   5. resolveStream(episodeUuid)   → { hls, audio_languages, subtitles }
//
// Dub note: anime.nexus bundles both languages into ONE HLS manifest as
// EXT-X-MEDIA TYPE=AUDIO alternate renditions. There is no separate dub
// URL. Client-side hls.js selects the English track when dub=true.
//
// Availability note: `audio_languages` comes back in two vocabularies
// across endpoints — the stream endpoint returns full words
// ("english","japanese") and the episodes endpoint returns ISO codes
// ("eng","jpn"). We accept either.

import crypto from 'node:crypto';
import { lookupTitle } from '../title-lookup.js';

const API = 'https://api.anime.nexus';
const APP_ORIGIN = 'https://anime.nexus';
// Realistic browser UA. Cloudflare fronts this API and doesn't reject
// generic Node fetches on the discovery endpoints, but `/episode/stream`
// is guarded harder — we need to mimic the fingerprint + client-hint
// header set the web player sends, plus hold a session cookie.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

// Per-process fingerprint UUID. The web player generates one on first
// load and reuses it for every x-client-fingerprint / x-fingerprint
// header. A stable value also makes anti-abuse rate limiting behave
// predictably instead of treating every request as a fresh "new client".
const CLIENT_FINGERPRINT = crypto.randomUUID();

// Minimal cookie jar. anime.nexus sets `anime_nexus_session` on the
// first API call and the stream endpoint rejects requests without it.
// We only care about request-name=value pairs; expiry/domain rules are
// not relevant since every call goes to api.anime.nexus within this
// process lifetime.
const cookieJar = new Map();
function absorbSetCookies(res) {
  // Node's Headers.get('set-cookie') folds multiple cookies into one
  // comma-joined string, which is ambiguous. getSetCookie() is the
  // newer API (Node 20+) that returns an array.
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (() => {
        const raw = res.headers.get('set-cookie');
        return raw ? [raw] : [];
      })();
  for (const line of list) {
    const first = line.split(';', 1)[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    cookieJar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
}
function cookieHeader() {
  if (cookieJar.size === 0) return null;
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Stream endpoint refuses requests without a session cookie. Do a
// lightweight warmup against a permissive endpoint (any 200 sets the
// cookie). We only warm up once per process.
let warmedPromise = null;
async function warmSession() {
  if (!warmedPromise) {
    warmedPromise = (async () => {
      const u = new URL('/api/anime/shows', API);
      u.searchParams.set('search', 'a');
      u.searchParams.set('page', '1');
      u.searchParams.set('hasVideos', '1');
      const res = await fetch(u.toString(), { headers: browserHeaders() });
      absorbSetCookies(res);
      // Drain body so the connection is returned to the pool.
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`anime.nexus warmup failed: ${res.status}`);
    })().catch((err) => { warmedPromise = null; throw err; });
  }
  return warmedPromise;
}

function browserHeaders() {
  return {
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': APP_ORIGIN,
    'Referer': APP_ORIGIN + '/',
    'x-client-fingerprint': CLIENT_FINGERPRINT,
    'x-fingerprint': CLIENT_FINGERPRINT,
    'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
}

/** Normalise a title to a match key: strip diacritics, punctuation, case, collapse whitespace. */
function normTitle(s) {
  return (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function getJson(url, { skipWarmup = false } = {}) {
  if (!skipWarmup) await warmSession();
  const hdrs = browserHeaders();
  const ck = cookieHeader();
  if (ck) hdrs.cookie = ck;
  const res = await fetch(url, { headers: hdrs });
  absorbSetCookies(res);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Cloudflare challenge responses include "Just a moment..." or the
    // cf-ray header. OctoberCMS "Page error" on /episode/stream means
    // we've been flagged as a bot — likely stale/missing fingerprint
    // or cookie. If that trips, we need a different bypass than
    // plain fetch (e.g. rotate UA or fall back to Playwright).
    if ((res.status === 403 || res.status === 503) && /cloudflare|just a moment|attention required|cdn-cgi|page error/i.test(body)) {
      throw new Error(`anime.nexus bot-wall (${res.status}) — scraper blocked; fingerprint/cookie may be missing`);
    }
    throw new Error(`anime.nexus ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Raw search. Returns the unfiltered array of show entries. */
export async function searchShow(query) {
  const u = new URL('/api/anime/shows', API);
  u.searchParams.set('search', query);
  u.searchParams.set('sortBy', 'name asc');
  u.searchParams.set('page', '1');
  u.searchParams.append('includes[]', 'poster');
  u.searchParams.append('includes[]', 'genres');
  u.searchParams.set('hasVideos', '1');
  const data = await getJson(u.toString());
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * List every episode for a show. Pages until `meta.last_page` is hit.
 * The bigger `perPage`, the fewer round-trips; they accept 50 comfortably.
 */
export async function listEpisodes(showUuid, { perPage = 50, maxPages = 20 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL('/api/anime/details/episodes', API);
    u.searchParams.set('id', showUuid);
    u.searchParams.set('page', String(page));
    u.searchParams.set('perPage', String(perPage));
    u.searchParams.set('order', 'asc');
    u.searchParams.set('fillers', 'true');
    u.searchParams.set('recaps', 'true');
    const data = await getJson(u.toString());
    for (const ep of (data?.data ?? [])) out.push(ep);
    const meta = data?.meta;
    if (!meta || meta.current_page >= meta.last_page) break;
  }
  return out;
}

/** Resolve an episode UUID to its stream manifest + audio/subtitle metadata. */
export async function resolveStream(episodeUuid) {
  const u = new URL('/api/anime/details/episode/stream', API);
  u.searchParams.set('id', episodeUuid);
  u.searchParams.set('fillers', 'true');
  u.searchParams.set('recaps', 'true');
  const data = await getJson(u.toString());
  const d = data?.data;
  if (!d?.hls) throw new Error('anime.nexus: stream response missing hls URL');
  return {
    url: d.hls,
    audioLanguages: d.video_meta?.audio_languages ?? [],
    subtitles: d.subtitles ?? [],
    duration: d.video_meta?.duration,
    qualities: d.video_meta?.qualities,
    thumbnails: d.thumbnails,
  };
}

/** True iff the episode's audio_languages list includes any English entry. */
export function hasEnglishAudio(audioLanguages) {
  return (audioLanguages ?? [])
    .map((s) => String(s).toLowerCase())
    .some((a) => a === 'eng' || a === 'english' || a.startsWith('en-'));
}

/** Score how well an anime.nexus show matches the AniList media. 0..1.2. */
function matchScore(entry, { english, romaji }, year) {
  const targetKeys = [english, romaji].filter(Boolean).map(normTitle);
  const entryKeys = [entry.name, entry.name_alt].filter(Boolean).map(normTitle);
  let titleScore = 0;
  for (const t of targetKeys) {
    for (const c of entryKeys) {
      if (!c) continue;
      if (c === t) titleScore = Math.max(titleScore, 1);
      else if (c.includes(t) || t.includes(c)) titleScore = Math.max(titleScore, 0.75);
    }
  }
  if (titleScore === 0) return 0;
  // Year bonus/penalty. anime.nexus release_date is "YYYY-MM-DD". Use
  // the year to separate sequels/seasons ("Hunter x Hunter" 1999 vs 2011,
  // "Fullmetal Alchemist" 2003 vs 2009).
  if (year && entry.release_date) {
    const entryYear = Number(String(entry.release_date).slice(0, 4));
    if (Number.isFinite(entryYear)) {
      const diff = Math.abs(entryYear - year);
      if (diff === 0) return titleScore + 0.2;
      if (diff === 1) return titleScore; // spring/winter cross-year
      if (diff === 2) return titleScore * 0.7;
      return 0; // too far off — probably a different adaptation
    }
  }
  return titleScore;
}

/** Cache anilistId → showUuid so we only hit `/api/anime/shows` once per show. */
const showCache = new Map();
const SHOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Resolve an AniList ID to a specific anime.nexus showUuid via search + match. */
export async function findShowUuidForAnilist(anilistId) {
  const cached = showCache.get(anilistId);
  if (cached && cached.expiresAt > Date.now()) return cached.showUuid;
  // title-lookup handles the AniList→Kitsu fallback + disk cache; our
  // showUuid cache above handles the (anilistId → anime.nexus id) leg.
  const meta = await lookupTitle(anilistId);
  const queries = [meta.romaji, meta.english].filter(Boolean);
  // De-dupe queries when romaji ≈ english (common for English-originated titles).
  const seen = new Set();
  let bestOverall = { score: 0, id: null };
  for (const q of queries) {
    const key = normTitle(q);
    if (seen.has(key)) continue;
    seen.add(key);
    const results = await searchShow(q);
    for (const r of results) {
      const s = matchScore(r, { english: meta.english, romaji: meta.romaji }, meta.year);
      if (s > bestOverall.score) bestOverall = { score: s, id: r.id };
    }
    // Exact title + year match is as good as it gets — short-circuit.
    if (bestOverall.score >= 1.2) break;
  }
  if (!bestOverall.id || bestOverall.score < 0.75) return null;
  showCache.set(anilistId, { showUuid: bestOverall.id, expiresAt: Date.now() + SHOW_CACHE_TTL_MS });
  return bestOverall.id;
}

/**
 * Top-level: given AniList media + ep + dub, resolve to a playable stream
 * or return null (caller should fall back to another scraper). Returns
 * the same shape as the miruro tap plus metadata we use for the dub
 * probe and the multi-audio player config.
 */
export async function resolveFromAnilist({ anilistId, ep, dub }) {
  const showUuid = await findShowUuidForAnilist(anilistId);
  if (!showUuid) return null;
  const episodes = await listEpisodes(showUuid);
  const epMeta = episodes.find((e) => e.number === ep);
  if (!epMeta) return null;
  if (dub && !hasEnglishAudio(epMeta.video_meta?.audio_languages)) return null;
  const stream = await resolveStream(epMeta.id);
  return {
    url: stream.url,
    referer: APP_ORIGIN + '/',
    audioLanguages: stream.audioLanguages,
    subtitles: stream.subtitles,
    duration: stream.duration,
    qualities: stream.qualities,
    thumbnails: stream.thumbnails,
    showUuid,
    episodeUuid: epMeta.id,
    provider: 'animenexus',
  };
}

/** Light availability probe: (anilistId, ep) → which langs exist. */
export async function probeAvailability({ anilistId, ep }) {
  const showUuid = await findShowUuidForAnilist(anilistId);
  if (!showUuid) return { hasSub: false, hasDub: false };
  const episodes = await listEpisodes(showUuid);
  const epMeta = episodes.find((e) => e.number === ep);
  if (!epMeta) return { hasSub: false, hasDub: false };
  const langs = (epMeta.video_meta?.audio_languages ?? []).map((s) => String(s).toLowerCase());
  return {
    hasSub: langs.some((a) => a === 'jpn' || a === 'japanese' || a.startsWith('ja')),
    hasDub: hasEnglishAudio(langs),
  };
}

// Tiny CLI so we can sanity-check end-to-end without booting the server:
//   node src/scrapers/animenexus.js <anilistId> <ep> [dub]
// e.g.  node src/scrapers/animenexus.js 11061 1 dub
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const anilistId = Number(process.argv[2] ?? 11061);
  const ep = Number(process.argv[3] ?? 1);
  const dub = process.argv[4] === 'dub';
  console.log(`probe anilistId=${anilistId} ep=${ep} dub=${dub}`);
  try {
    const result = await resolveFromAnilist({ anilistId, ep, dub });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
  }
}
