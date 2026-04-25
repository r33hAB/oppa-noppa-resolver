// AniList → Kitsu fallback shim. Recognises specific GraphQL queries
// the mobile PWA sends and answers them from Kitsu when AniList is
// unavailable. Used by the /anilist passthrough in server.js as the
// last layer before "no cached response, give up".
//
// Coverage targets the mobile PWA's home/search/detail pages:
//   - getTrending  (TRENDING_DESC sort)
//   - getSeasonal  (status: RELEASING, sort: POPULARITY_DESC)
//   - getAnimeDetail (Media(id: $id))
//   - searchAnime  (media(search:, type: ANIME))
//   - per-id batch (media(id_in: $ids)) — used by continue-watching
//
// Out of scope (these will still error during AniList outages):
//   - getAiringSchedule (Kitsu has no airing-schedule API)
//   - getLibrary       (requires AniList OAuth, not cacheable per user)
//
// Response shape MUST match what the PWA's `anilistQueries.ts` reads
// out of `data.Page.media` / `data.Media` etc — keeping that contract
// is the whole point of the shim.

const KITSU = 'https://kitsu.io/api/edge';
const KITSU_HEADERS = { Accept: 'application/vnd.api+json' };

/** Translate Kitsu's subtype → AniList's format. */
function kitsuSubtypeToFormat(subtype) {
  switch ((subtype || '').toUpperCase()) {
    case 'TV': return 'TV';
    case 'MOVIE': return 'MOVIE';
    case 'OVA': return 'OVA';
    case 'ONA': return 'ONA';
    case 'SPECIAL': return 'SPECIAL';
    case 'MUSIC': return 'MUSIC';
    default: return null;
  }
}

/** Build the AniList ID lookup from Kitsu's `?include=mappings` payload. */
function buildKitsuIdMaps(included) {
  // mappingId → {externalSite, externalId}
  const mappings = new Map();
  for (const mp of included ?? []) {
    if (mp.type !== 'mappings') continue;
    mappings.set(mp.id, {
      externalSite: mp.attributes?.externalSite,
      externalId: mp.attributes?.externalId,
    });
  }
  return mappings;
}

/** Pull AniList ID + MAL ID for a single Kitsu anime row. */
function externalIdsFor(item, mappingsById) {
  const refs = item.relationships?.mappings?.data ?? [];
  let anilistId = null;
  let malId = null;
  for (const ref of refs) {
    const m = mappingsById.get(ref.id);
    if (!m) continue;
    if (!anilistId && m.externalSite === 'anilist/anime' && m.externalId) {
      anilistId = Number(m.externalId);
    } else if (!malId && m.externalSite === 'myanimelist/anime' && m.externalId) {
      malId = Number(m.externalId);
    }
  }
  return { anilistId, malId };
}

/** Convert one Kitsu anime entry → AniList Media shape. */
function kitsuItemToMedia(item, mappingsById) {
  const a = item.attributes ?? {};
  const { anilistId, malId } = externalIdsFor(item, mappingsById);
  if (!anilistId) return null; // Drop entries we can't key into the AniList catalog.
  const yrStr = a.startDate ? String(a.startDate).slice(0, 4) : '';
  const year = /^\d{4}$/.test(yrStr) ? Number(yrStr) : null;
  // Kitsu's averageRating is a 0-100 decimal string like "84.51".
  const averageScore = a.averageRating != null
    ? Math.round(Number(a.averageRating))
    : null;
  return {
    id: anilistId,
    idMal: malId,
    title: {
      english: a.titles?.en ?? a.canonicalTitle ?? null,
      romaji: a.titles?.en_jp ?? null,
      native: a.titles?.ja_jp ?? null,
    },
    coverImage: {
      large: a.posterImage?.original ?? a.posterImage?.large ?? a.posterImage?.small ?? null,
    },
    format: kitsuSubtypeToFormat(a.subtype),
    episodes: typeof a.episodeCount === 'number' ? a.episodeCount : null,
    season: null,        // Kitsu doesn't expose AniList-style WINTER/SPRING/SUMMER/FALL directly here.
    seasonYear: year,
    averageScore,
    status: kitsuStatusToAniList(a.status),
    bannerImage: a.coverImage?.original ?? a.coverImage?.large ?? null,
    description: a.synopsis ?? null,
    genres: [],          // Would need ?include=genres + a second pass; skipped for now.
    nextAiringEpisode: null,
    startDate: { year },
  };
}

function kitsuStatusToAniList(s) {
  switch ((s || '').toLowerCase()) {
    case 'current': return 'RELEASING';
    case 'finished': return 'FINISHED';
    case 'tba': return 'NOT_YET_RELEASED';
    case 'unreleased': return 'NOT_YET_RELEASED';
    case 'upcoming': return 'NOT_YET_RELEASED';
    default: return null;
  }
}

async function kitsuList(path, params) {
  const u = new URL(KITSU + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const r = await fetch(u.toString(), { headers: KITSU_HEADERS });
  if (!r.ok) throw new Error(`kitsu ${u.pathname} HTTP ${r.status}`);
  return r.json();
}

// ---- Per-pattern handlers. Each takes `variables` and returns an
// AniList-shaped `data` object, or null if the pattern doesn't match. ----

async function asTrending(variables) {
  const perPage = Math.min(Math.max(Number(variables?.perPage ?? 24), 1), 40);
  const j = await kitsuList('/anime', {
    'sort': '-userCount',
    'page[limit]': perPage,
    'include': 'mappings',
  });
  const mappings = buildKitsuIdMaps(j.included);
  const media = (j.data ?? []).map((it) => kitsuItemToMedia(it, mappings)).filter(Boolean);
  return { Page: { media } };
}

async function asSeasonal() {
  // PWA's getSeasonal asks for "currently airing, sorted by popularity".
  // Kitsu's `filter[status]=current&sort=popularityRank` is the closest.
  const j = await kitsuList('/anime', {
    'filter[status]': 'current',
    'sort': 'popularityRank',
    'page[limit]': 30,
    'include': 'mappings',
  });
  const mappings = buildKitsuIdMaps(j.included);
  const media = (j.data ?? []).map((it) => kitsuItemToMedia(it, mappings)).filter(Boolean);
  return { Page: { media } };
}

async function asMediaById(variables) {
  const id = Number(variables?.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  // /mappings?...&include=item gives us the Kitsu anime in `included`.
  const j = await kitsuList('/mappings', {
    'filter[externalSite]': 'anilist/anime',
    'filter[externalId]': String(id),
    'include': 'item',
  });
  const anime = (j.included ?? []).find((x) => x.type === 'anime');
  if (!anime) return { Media: null };
  // Normalise to the include-mappings shape so kitsuItemToMedia works.
  // We don't have the mapping refs back from the anime here, but we
  // can build a synthetic mappings map from the input.
  const synth = new Map();
  // Stamp this single anime with a fake AniList mapping ref so
  // externalIdsFor finds it.
  synth.set('al', { externalSite: 'anilist/anime', externalId: String(id) });
  const itemWithRefs = {
    ...anime,
    relationships: { ...anime.relationships, mappings: { data: [{ id: 'al' }] } },
  };
  return { Media: kitsuItemToMedia(itemWithRefs, synth) };
}

async function asMediaByIds(variables) {
  const ids = (variables?.ids ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return { Page: { media: [] } };
  // Kitsu has no batched-mappings endpoint; fan out one per id. Kept
  // small (<=12) by the PWA's continue-watching cap.
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const r = await asMediaById({ id });
      return r?.Media ?? null;
    } catch { return null; }
  }));
  return { Page: { media: results.filter(Boolean) } };
}

async function asSearch(variables) {
  const q = String(variables?.q ?? '').trim();
  const perPage = Math.min(Math.max(Number(variables?.perPage ?? 24), 1), 40);
  if (q.length === 0) return { Page: { media: [] } };
  const j = await kitsuList('/anime', {
    'filter[text]': q,
    'sort': 'popularityRank',
    'page[limit]': perPage,
    'include': 'mappings',
  });
  const mappings = buildKitsuIdMaps(j.included);
  const media = (j.data ?? []).map((it) => kitsuItemToMedia(it, mappings)).filter(Boolean);
  return { Page: { media } };
}

/** Detect which fallback handler (if any) applies to a GraphQL query. */
function classify(query) {
  const q = (query ?? '').replace(/\s+/g, ' ').trim();
  if (/sort:\s*TRENDING_DESC/i.test(q)) return 'trending';
  if (/status:\s*RELEASING.*sort:\s*POPULARITY_DESC/i.test(q)) return 'seasonal';
  if (/media\(\s*id_in:/i.test(q)) return 'idsBatch';
  if (/media\(\s*search:/i.test(q)) return 'search';
  if (/Media\(\s*id:/i.test(q)) return 'detail';
  return null;
}

/**
 * Try to satisfy a GraphQL query from Kitsu. Returns AniList-shaped
 * `data` or null if we don't have a fallback for this query type.
 */
export async function tryKitsuFallback(query, variables) {
  const kind = classify(query);
  if (!kind) return null;
  switch (kind) {
    case 'trending': return await asTrending(variables);
    case 'seasonal': return await asSeasonal();
    case 'detail':   return await asMediaById(variables);
    case 'idsBatch': return await asMediaByIds(variables);
    case 'search':   return await asSearch(variables);
    default: return null;
  }
}
