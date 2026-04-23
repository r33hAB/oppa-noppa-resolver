// One long-running ffmpeg per viewer session. ffmpeg pulls the upstream
// HLS (with Referer so the CDN serves us), transcodes audio from
// HE-AACv2 to LC-AAC (browsers and Chromecast both choke on the former),
// stream-copies video, and writes a fresh local HLS playlist to a temp
// dir. We serve that directory statically under /session/:id/*.
//
// Why one-long-running (not per-segment): per-segment ffmpeg calls
// desync A/V because AAC priming delay repeats on every spawn. This is
// the same lesson the desktop cast path learned.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// Path to the ffmpeg binary. The Playwright base image does NOT ship
// ffmpeg; we `apt-get install ffmpeg` in the Dockerfile. Override via
// env for local dev if your system has ffmpeg at a non-standard path.
const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';

// Sessions age out after this long with no read. Prevents a client who
// closed the tab from leaking ffmpeg forever.
const SESSION_IDLE_MS = 5 * 60 * 1000;

// Headers ffmpeg sends upstream. Miruro's CDN 403s without the Referer.
const UPSTREAM_HEADERS = {
  Referer: 'https://www.miruro.to/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
};

/**
 * Internal map of session ID → { proc, outDir, lastRead, stop }.
 * Cleanup runs every minute. Keeping this in-process is fine because
 * Railway gives us one instance; if we ever scale horizontally we'd
 * move to a real session store.
 */
const sessions = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastRead > SESSION_IDLE_MS) {
      s.stop('idle');
    }
  }
}, 60_000).unref();

export async function startSession({ upstreamUrl }) {
  const id = randomBytes(8).toString('hex');
  const outDir = await mkdtemp(join(tmpdir(), `oap-${id}-`));
  const playlistPath = join(outDir, 'index.m3u8');
  const segmentPattern = join(outDir, 'seg%05d.ts');

  // -headers is CRLF-delimited; one header per line, terminated with
  // \r\n each. Miss this and ffmpeg sends them all as a single line.
  const headerBlob = Object.entries(UPSTREAM_HEADERS)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-headers', headerBlob,
    '-i', upstreamUrl,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',            // LC-AAC — the universally-supported profile
    '-ac', '2',               // downmix to stereo
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '6',
    '-hls_list_size', '0',    // keep all segments (growing VOD)
    '-hls_playlist_type', 'event',
    '-hls_segment_filename', segmentPattern,
    '-hls_flags', 'independent_segments',
    '-start_number', '0',
    playlistPath,
  ];

  const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep stderr accessible for debugging via `railway logs`.
  proc.stderr?.on('data', (chunk) => {
    const line = chunk.toString('utf8').trimEnd();
    if (line) console.log(`[ffmpeg:${id}]`, line);
  });

  const state = {
    id,
    proc,
    outDir,
    lastRead: Date.now(),
    stop: (reason) => {
      if (!sessions.has(id)) return;
      sessions.delete(id);
      console.log(`[session:${id}] stopping (${reason})`);
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      // Temp dir cleanup is best-effort — OS will GC /tmp eventually.
    },
  };
  sessions.set(id, state);

  proc.on('exit', (code) => {
    console.log(`[session:${id}] ffmpeg exited code=${code}`);
    sessions.delete(id);
  });

  // Wait for the first segment to land before returning so the client's
  // first playlist fetch isn't a 404. 45s budget matches the desktop
  // cast path.
  const firstSegment = join(outDir, 'seg00000.ts');
  const start = Date.now();
  while (Date.now() - start < 45_000) {
    try {
      await access(firstSegment, fsc.R_OK);
      return state;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  state.stop('startup timeout');
  throw new Error('ffmpeg did not produce a first segment within 45s');
}

export async function readPlaylist(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastRead = Date.now();
  try {
    return await readFile(join(s.outDir, 'index.m3u8'), 'utf8');
  } catch {
    return null;
  }
}

export function getSegmentPath(sessionId, segmentName) {
  const s = sessions.get(sessionId);
  if (!s) return null;
  s.lastRead = Date.now();
  // Hard restriction: only files matching `seg<digits>.ts` inside outDir.
  // Prevents path traversal via `../`.
  if (!/^seg\d{1,6}\.ts$/.test(segmentName)) return null;
  return join(s.outDir, segmentName);
}

export function stopSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) s.stop('manual');
}

// Graceful shutdown on SIGTERM (Railway redeploy). Without this, ffmpeg
// zombies linger in the dying container and the new one can't clean up.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    for (const [id, s] of sessions) s.stop(`shutdown (${sig})`);
  });
}

/** Probe ffmpeg version on boot so the healthcheck can report it. */
export async function ffmpegVersion() {
  try {
    const { stdout } = await execFileP(FFMPEG_PATH, ['-version']);
    return stdout.split('\n')[0];
  } catch (err) {
    return `ffmpeg unavailable: ${err.message}`;
  }
}
