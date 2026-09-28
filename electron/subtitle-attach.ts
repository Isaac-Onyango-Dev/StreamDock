// Role: deliver the subtitle tracks a web player loaded beside the stream —
// as a file next to the video, a track inside it, or both.
//
// yt-dlp is handed only the manifest. anikoto's Sub stream carries its English
// subtitles as a separate .vtt the player fetches next to it, which yt-dlp never
// sees: every Sub episode arrived as Japanese audio with no subtitles
// ("[EmbedSubtitle] There aren't any subtitles to embed" in Isaac's log), and the
// subtitle setting had nothing to act on for the sites he uses most.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, extname, join } from 'path';
import log from 'electron-log';
import type { SubtitleMode } from '../shared/subtitle-args';
import type { CapturedSubtitle } from './manifest-extractor';
import { fetchWithDeadline, runProbeChild } from './probe-support';

const FETCH_TIMEOUT_MS = 20_000;
/** A stream copy of a full episode takes seconds; this is only a backstop. */
const MUX_TIMEOUT_MS = 10 * 60_000;

/** The text codec a container can carry. mp4 takes only mov_text; webm only WebVTT. */
export function subtitleCodecFor(videoPath: string): string {
  const ext = extname(videoPath).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') return 'mov_text';
  if (ext === '.webm') return 'webvtt';
  return 'srt';
}

/** `Episode.mp4` → `Episode.vtt`; several tracks are told apart by language or number. */
export function sidecarPath(videoPath: string, track: CapturedSubtitle, index: number, count: number): string {
  const stem = videoPath.slice(0, videoPath.length - extname(videoPath).length);
  let ext = '.vtt';
  try { ext = extname(new URL(track.url).pathname).toLowerCase() || ext; } catch { /* keep .vtt */ }
  const tag = track.language ?? (count > 1 ? String(index + 1) : '');
  return `${stem}${tag ? `.${tag}` : ''}${ext}`;
}

/**
 * Fetch the tracks and apply the subtitle mode to the finished video.
 *
 * Embedding goes through a temp file in `workDir` (the job's staging folder,
 * swept at startup) and a rename, so an interrupted mux never damages the video.
 * If embedding fails the fetched files stay beside the video: the subtitles are
 * still delivered, as files, and the log says why.
 *
 * @returns how many tracks were delivered.
 */
export async function attachSubtitles(
  videoPath: string,
  tracks: CapturedSubtitle[],
  mode: SubtitleMode,
  ffmpeg: string,
  workDir: string,
): Promise<number> {
  if (mode === 'none' || tracks.length === 0) return 0;
  const keepFiles = mode === 'sidecar' || mode === 'both';
  mkdirSync(workDir, { recursive: true });

  const fetched: Array<{ file: string; track: CapturedSubtitle; index: number }> = [];
  for (const [index, track] of tracks.entries()) {
    const res = await fetchWithDeadline(track.url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      headers: track.referer ? { Referer: track.referer } : {},
    });
    // An HTML error page served with 200 is not a subtitle file.
    if (res.status < 200 || res.status >= 300 || !res.body || /^\s*</.test(res.body)) {
      log.warn(`[subtitles] Could not fetch ${track.url} (HTTP ${res.status || 'no answer'})`);
      continue;
    }
    const beside = sidecarPath(videoPath, track, index, tracks.length);
    const file = keepFiles ? beside : join(workDir, basename(beside));
    writeFileSync(file, res.body, 'utf-8');
    fetched.push({ file, track, index });
  }
  if (fetched.length === 0) return 0;

  const files = fetched.map((f) => f.file);
  if (mode === 'both') await embed(videoPath, files, ffmpeg, workDir);
  if (mode === 'embed' && !(await embed(videoPath, files, ffmpeg, workDir))) {
    // Embedding failed: move the tracks beside the video rather than lose them.
    for (const { file, track, index } of fetched) {
      try { renameSync(file, sidecarPath(videoPath, track, index, tracks.length)); } catch { /* swept with staging */ }
    }
  }
  return fetched.length;
}

async function embed(videoPath: string, files: string[], ffmpeg: string, workDir: string): Promise<boolean> {
  const ext = extname(videoPath);
  const tmp = join(workDir, `subtitled${ext}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath];
  for (const file of files) args.push('-i', file);
  args.push('-map', '0');
  files.forEach((_, i) => args.push('-map', String(i + 1)));
  args.push('-c', 'copy', '-c:s', subtitleCodecFor(videoPath), tmp);

  const result = await runProbeChild(ffmpeg, args, { timeoutMs: MUX_TIMEOUT_MS });
  if (result.code !== 0) {
    log.warn(`[subtitles] Embedding into ${basename(videoPath)} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 500)}`);
    rmSync(tmp, { force: true });
    return false;
  }
  renameSync(tmp, videoPath);
  log.info(`[subtitles] Embedded ${files.length} track(s) into ${basename(videoPath)}`);
  return true;
}
