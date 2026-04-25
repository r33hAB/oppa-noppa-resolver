// Scraper chain. Tries miruro first, falls back to anime.nexus.
//
// Miruro is primary because anime.nexus playback is currently unreliable
// for our mobile client; miruro works end-to-end via the ffmpeg remux
// session flow. anime.nexus stays in the chain as a fallback so shows
// miruro can't resolve still get a shot at playing.
//
// Tradeoff: miruro requires the ffmpeg-session flow (HE-AACv2 → LC-AAC
// remux for Chrome/Firefox MSE), so this is heavier on the server than
// anime.nexus's direct-manifest path. Acceptable for now given the
// reliability win.

import { resolveFromAnilist as nexusResolve, probeAvailability as nexusProbe } from './scrapers/animenexus.js';

// Miruro imports playwright-chromium which is a ~200MB dep we don't
// want to force-load during CLI testing of the chain (or when
// anime.nexus serves the stream so miruro never runs). Lazy-import
// keeps that cost gated behind actual fallback needs.
let _miruro = null;
async function getMiruro() {
  if (!_miruro) _miruro = await import('./scrapers/miruro.js');
  return _miruro;
}

/**
 * Resolve (anilistId, ep, dub) → a playable source description.
 *
 * Returns one of:
 *   { provider: 'animenexus', needsTranscode: false, directUrl, ...meta }
 *   { provider: 'miruro',     needsTranscode: true,  upstreamUrl, referer }
 *   null (no provider had the stream)
 *
 * Errors from individual scrapers are swallowed — a provider that
 * throws is treated as "no coverage" so the chain can still try the
 * next one. We log them so outages show up in Railway logs.
 */
export async function resolveChain({ anilistId, ep, dub, log = console }) {
  try {
    const { resolveMiruro } = await getMiruro();
    const mir = await resolveMiruro({ anilistId, ep, dub });
    if (mir) {
      return {
        provider: 'miruro',
        needsTranscode: true,
        upstreamUrl: mir.url,
        referer: mir.referer ?? 'https://www.miruro.to/',
      };
    }
  } catch (err) {
    log.warn?.({ err: err.message, anilistId, ep, dub }, '[chain] miruro threw; trying animenexus');
  }

  try {
    const nexus = await nexusResolve({ anilistId, ep, dub });
    if (nexus) {
      return {
        provider: 'animenexus',
        needsTranscode: false,
        directUrl: nexus.url,
        referer: nexus.referer,
        audioLanguages: nexus.audioLanguages,
        subtitles: nexus.subtitles,
        qualities: nexus.qualities,
        thumbnails: nexus.thumbnails,
      };
    }
  } catch (err) {
    log.warn?.({ err: err.message, anilistId, ep, dub }, '[chain] animenexus threw');
  }

  return null;
}

/**
 * Availability probe for the mobile UI's SUB/DUB toggle. Only anime.nexus
 * exposes reliable per-episode audio-language metadata; miruro doesn't
 * advertise dub availability until you try to tap the stream (and even
 * then it silently falls back to sub when a dub doesn't exist). So we
 * treat anime.nexus's answer as authoritative when we have it, and
 * return a generous default ("probably has both") when it's unreachable
 * so we don't nag the user with false "no dub" messages during outages.
 */
export async function probeAvailability({ anilistId, ep, log = console }) {
  try {
    const a = await nexusProbe({ anilistId, ep });
    return { hasSub: a.hasSub, hasDub: a.hasDub, source: 'animenexus' };
  } catch (err) {
    log.warn?.({ err: err.message, anilistId, ep }, '[chain] probe failed, defaulting to both-available');
    return { hasSub: true, hasDub: true, source: 'unknown' };
  }
}
