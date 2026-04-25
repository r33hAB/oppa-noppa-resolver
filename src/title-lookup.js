// Resilient title lookup for an AniList anime ID.
//
// Fallback chain per ID-lookup call:
//   1. In-memory cache (per-process)
//   2. Disk cache at $TITLE_CACHE_FILE if set (survives restarts)
//   3. AniList GraphQL (canonical source)
//   4. Kitsu mappings API → Kitsu anime (when AniList is down)
//   5. Stale cache entry (if we have one and everything else failed)
//
// Scope is deliberately narrow: just title strings + startDate.year. If
// the UI needs richer metadata during an outage, write a dedicated
// helper — don't bloat this.
//
// Motivated by the 2026-04-24 AniList outage ("temporarily disabled due
// to severe stability issues") — every scraper that does AniList-id →
// title lookup broke, which in turn broke the whole chain.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchAniList } from './anilist.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE = process.env.TITLE_CACHE_FILE ?? null;

const mem = new Map();
let diskLoaded = false;
let saveQueued = false;

async function loadDisk() {
  if (diskLoaded) return;
  diskLoaded = true;
  if (!CACHE_FILE) return;
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    for (const [k, v] of Object.entries(obj)) mem.set(Number(k), v);
  } catch { /* no file yet */ }
}

function scheduleSave() {
  if (saveQueued || !CACHE_FILE) return;
  saveQueued = true;
  // Debounce ~1s so a burst of searches doesn't hammer the disk.
  setTimeout(async () => {
    saveQueued = false;
    try {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(mem)), 'utf8');
    } catch { /* best-effort */ }
  }, 1000);
}

const AL_DETAIL_GQL = /* GraphQL */ `
  query ($id: Int) {
    Media(id: $id, type: ANIME) {
      title { english romaji native }
      startDate { year }
      coverImage { large }
      episodes
      nextAiringEpisode { episode }
    }
  }
`;

const AL_SEARCH_GQL = /* GraphQL */ `
  query ($q: String, $page: Int) {
    Page(page: $page, perPage: 20) {
      media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
        id
        title { english romaji native }
        startDate { year }
        coverImage { large }
        episodes
      }
    }
  }
`;

function airedEpisodeCount(media) {
  // AniList's `episodes` is null for ongoing shows. Use nextAiringEpisode-1
  // as a floor if available, so ongoing shows render real counts.
  if (media.episodes != null) return media.episodes;
  const next = media.nextAiringEpisode?.episode;
  return next ? Math.max(0, next - 1) : null;
}

async function tryAniListDetail(id) {
  const d = await fetchAniList(AL_DETAIL_GQL, { id });
  const m = d?.Media;
  if (!m) throw new Error('anilist: media not found');
  return {
    english: m.title?.english ?? null,
    romaji: m.title?.romaji ?? null,
    native: m.title?.native ?? null,
    year: m.startDate?.year ?? null,
    posterUrl: m.coverImage?.large ?? null,
    totalEpisodes: airedEpisodeCount(m),
    source: 'anilist',
    fetchedAt: Date.now(),
  };
}

async function tryKitsuById(id) {
  const u = `https://kitsu.io/api/edge/mappings?filter[externalSite]=anilist/anime&filter[externalId]=${id}&include=item`;
  const r = await fetch(u, { headers: { Accept: 'application/vnd.api+json' } });
  if (!r.ok) throw new Error(`kitsu mappings HTTP ${r.status}`);
  const j = await r.json();
  const anime = j.included?.find((x) => x.type === 'anime');
  if (!anime) throw new Error('kitsu: no anime mapping');
  const a = anime.attributes || {};
  const yrStr = a.startDate ? String(a.startDate).slice(0, 4) : '';
  const year = /^\d{4}$/.test(yrStr) ? Number(yrStr) : null;
  return {
    english: a.titles?.en ?? a.canonicalTitle ?? null,
    romaji: a.titles?.en_jp ?? null,
    native: a.titles?.ja_jp ?? null,
    year,
    // Kitsu posters are hosted at media.kitsu.app; `original` is the full
    // quality asset. Fall back to large/small if original is missing.
    posterUrl: a.posterImage?.original ?? a.posterImage?.large ?? a.posterImage?.small ?? null,
    totalEpisodes: typeof a.episodeCount === 'number' ? a.episodeCount : null,
    source: 'kitsu',
    fetchedAt: Date.now(),
  };
}

/**
 * Resolve an AniList ID to title+year. Throws only if every source
 * AND the cache comes up empty.
 */
export async function lookupTitle(anilistId) {
  await loadDisk();
  const cached = mem.get(anilistId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const errs = [];
  for (const fn of [tryAniListDetail, tryKitsuById]) {
    try {
      const v = await fn(anilistId);
      mem.set(anilistId, v);
      scheduleSave();
      return v;
    } catch (e) {
      errs.push(`${fn.name}: ${e.message}`);
    }
  }
  if (cached) return { ...cached, stale: true };
  throw new Error(`title-lookup failed for anilistId ${anilistId}: ${errs.join('; ')}`);
}

/**
 * Text-based search — returns candidates with AniList IDs. AniList
 * first; Kitsu fallback when AniList is down. Returned anilistId is
 * guaranteed for both paths (Kitsu provides the reverse mapping via
 * its `mappings` relation).
 */
export async function searchTitle(query, { perPage = 20 } = {}) {
  // Try AniList first.
  try {
    const d = await fetchAniList(AL_SEARCH_GQL, { q: query, page: 1 });
    const list = d?.Page?.media ?? [];
    // Warm the per-ID cache so follow-up lookupTitle() hits.
    for (const m of list) {
      mem.set(m.id, {
        english: m.title?.english ?? null,
        romaji: m.title?.romaji ?? null,
        native: m.title?.native ?? null,
        year: m.startDate?.year ?? null,
        posterUrl: m.coverImage?.large ?? null,
        totalEpisodes: m.episodes ?? null,
        source: 'anilist',
        fetchedAt: Date.now(),
      });
    }
    scheduleSave();
    return list.map((m) => ({
      anilistId: m.id,
      title: m.title?.english ?? m.title?.romaji ?? m.title?.native ?? '',
      year: m.startDate?.year ?? null,
      posterUrl: m.coverImage?.large ?? null,
      totalEpisodes: m.episodes ?? null,
      source: 'anilist',
    }));
  } catch {
    // Fall through to Kitsu.
  }

  // Kitsu's default ranking for filter[text] weights exact-prefix matches
  // on title tokens over popularity, which buries HxH/Demon Slayer/etc.
  // when the query is a short common word. Sorting by popularityRank
  // (asc — rank 1 = most popular) puts the shows users actually look
  // for on top at the cost of including some synopsis-text false
  // positives further down (acceptable for search UX).
  const u = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(query)}&sort=popularityRank&page[limit]=${perPage}&include=mappings`;
  const r = await fetch(u, { headers: { Accept: 'application/vnd.api+json' } });
  if (!r.ok) return [];
  const j = await r.json();
  const items = j.data ?? [];
  // Build: mappingId → {externalSite, externalId}. The item
  // relationship on a mapping entry doesn't carry a data back-reference
  // in the search response (unlike /mappings?include=item), so we walk
  // the other direction: each anime has relationships.mappings.data[] →
  // list of mapping id refs → look them up here.
  const mappings = new Map();
  for (const mp of j.included ?? []) {
    if (mp.type !== 'mappings') continue;
    mappings.set(mp.id, {
      externalSite: mp.attributes?.externalSite,
      externalId: mp.attributes?.externalId,
    });
  }
  const out = [];
  for (const item of items) {
    const refs = item.relationships?.mappings?.data ?? [];
    let anilistId = null;
    for (const ref of refs) {
      const m = mappings.get(ref.id);
      if (m && m.externalSite === 'anilist/anime' && m.externalId) {
        anilistId = Number(m.externalId);
        break;
      }
    }
    if (!anilistId) continue;
    const a = item.attributes || {};
    const yrStr = a.startDate ? String(a.startDate).slice(0, 4) : '';
    const year = /^\d{4}$/.test(yrStr) ? Number(yrStr) : null;
    const posterUrl = a.posterImage?.original ?? a.posterImage?.large ?? a.posterImage?.small ?? null;
    const totalEpisodes = typeof a.episodeCount === 'number' ? a.episodeCount : null;
    out.push({
      anilistId,
      title: a.titles?.en ?? a.canonicalTitle ?? a.titles?.en_jp ?? '',
      year,
      posterUrl,
      totalEpisodes,
      source: 'kitsu',
    });
    // Also warm the id-cache.
    mem.set(anilistId, {
      english: a.titles?.en ?? a.canonicalTitle ?? null,
      romaji: a.titles?.en_jp ?? null,
      native: a.titles?.ja_jp ?? null,
      year,
      posterUrl,
      totalEpisodes,
      source: 'kitsu',
      fetchedAt: Date.now(),
    });
  }
  scheduleSave();
  return out;
}
