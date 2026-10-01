// Role: turn what yt-dlp saved from a player's HLS stream into a playable MP4,
// and refuse to call a download finished when it is not one.
//
// On 1 Oct 2026 anikoto moved to new CDN servers (megap.*) whose playlists
// point at "images" on an ad CDN: every segment is a real 70-byte PNG, then
// a short MPEG-TS packet, then the episode's 188-byte TS packets. yt-dlp
// concatenates the segments as they are, so the saved file starts with a PNG
// and ffmpeg reads the whole thing as a picture: its metadata step rewrote 230
// MB of episode as a 1x1 PNG "video", and the row said Completed.
//
// The repair keeps every 188-byte packet and drops the wrappers, then remuxes
// the clean transport stream into MP4 with the bundled ffmpeg. A stream that
// was never wrapped passes through the same path unchanged, so this is the one
// owner of "make the manifest download an MP4" (yt-dlp's own ffmpeg steps are
// switched off for these downloads; see the engine).

import { createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync } from 'fs';
import { basename, dirname, extname, join } from 'path';
import log from 'electron-log';
import { runProbeChild } from './probe-support';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TS_PACKET = 188;
const SYNC = 0x47;
const MUX_TIMEOUT_MS = 10 * 60_000;
/** Codecs that are pictures, not video: a file whose only "video" is one of these did not download a stream. */
const IMAGE_CODECS = new Set(['png', 'mjpeg', 'bmp', 'gif', 'webp', 'tiff']);

export type StreamKind = 'png-wrapped' | 'mpegts' | 'mp4' | 'other';

export function detectStreamKind(head: Buffer): StreamKind {
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) return 'png-wrapped';
  if (head.length >= 1 && head[0] === SYNC) return 'mpegts';
  if (head.length >= 8 && head.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return 'other';
}

/**
 * Keep the transport stream's packets and drop everything else: the PNG each
 * segment is wrapped in, and the stray short packet behind it.
 *
 * A pure transform over a buffer that may end mid-structure: it returns the
 * packets it could emit and how many bytes it consumed, so a caller streaming
 * a file feeds the rest back in with the next chunk.
 */
export function extractPackets(buf: Buffer, final: boolean): { packets: Buffer[]; consumed: number } {
  const packets: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (buf.length - pos >= 8 && buf.subarray(pos, pos + 8).equals(PNG_SIG)) {
      // Skip the PNG chunk by chunk, up to and including IEND.
      let q = pos + 8;
      let ended = false;
      while (q + 8 <= buf.length) {
        const len = buf.readUInt32BE(q);
        const type = buf.toString('ascii', q + 4, q + 8);
        if (q + 12 + len > buf.length) break;
        q += 12 + len;
        if (type === 'IEND') { ended = true; break; }
      }
      if (!ended) {
        if (final) return { packets, consumed: buf.length };
        return { packets, consumed: pos };
      }
      pos = q;
      continue;
    }
    if (buf[pos] === SYNC) {
      // A packet counts only when the next one (or the next segment's PNG)
      // starts exactly a packet-length later. A lone 0x47 inside a wrapper or
      // inside the short packet behind it does not.
      const next = pos + TS_PACKET;
      const rest = buf.length - next;
      if (rest < 0) return { packets, consumed: final ? buf.length : pos };
      if (rest === 0) {
        if (!final) return { packets, consumed: pos };
        packets.push(buf.subarray(pos, next));
        return { packets, consumed: buf.length };
      }
      // A PNG signature may be split across two chunks; wait for the rest.
      if (rest < 8 && buf[next] !== SYNC && !final) return { packets, consumed: pos };
      if (buf[next] === SYNC || (rest >= 8 && buf.subarray(next, next + 8).equals(PNG_SIG))) {
        packets.push(buf.subarray(pos, next));
        pos = next;
        continue;
      }
    }
    pos += 1;
  }
  return { packets, consumed: pos };
}

/** Stream `input` through extractPackets into `output`. */
async function unwrapFile(input: string, output: string): Promise<number> {
  const out = createWriteStream(output);
  let carry = Buffer.alloc(0);
  let written = 0;
  const write = (data: Buffer) => new Promise<void>((resolve, reject) => {
    out.write(data, (err) => (err ? reject(err) : resolve()));
  });
  try {
    for await (const chunk of createReadStream(input, { highWaterMark: 4 * 1024 * 1024 })) {
      const buf = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
      const { packets, consumed } = extractPackets(buf, false);
      if (packets.length) {
        const data = Buffer.concat(packets);
        written += data.length;
        await write(data);
      }
      carry = Buffer.from(buf.subarray(consumed));
    }
    const { packets } = extractPackets(carry, true);
    if (packets.length) {
      const data = Buffer.concat(packets);
      written += data.length;
      await write(data);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return written;
}

function readHead(file: string): Buffer {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    const n = readSync(fd, head, 0, 16, 0);
    return head.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function ffprobeFor(ffmpeg: string): string {
  return join(dirname(ffmpeg), basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
}

/** True when the file holds a real video or audio stream, not just a picture. */
export async function hasPlayableStream(file: string, ffmpeg: string): Promise<boolean> {
  const probe = ffprobeFor(ffmpeg);
  if (!existsSync(probe)) return true; // cannot check; do not fail a download on a missing tool
  const r = await runProbeChild(probe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', file], { timeoutMs: 60_000 });
  if (r.code !== 0) return false;
  return r.stdout.split(/\r?\n/).some((line) => {
    const [codec, type] = line.trim().split(',');
    return (type === 'video' && !IMAGE_CODECS.has(codec)) || type === 'audio';
  });
}

/**
 * Make a downloaded player stream a playable MP4, in place.
 *
 * @returns false when the result still holds no playable stream — the caller
 *   must fail the download rather than report it finished.
 */
export async function repairStreamDownload(file: string, ffmpeg: string, workDir: string): Promise<boolean> {
  const kind = detectStreamKind(readHead(file));
  if (kind === 'png-wrapped' || kind === 'mpegts') {
    mkdirSync(workDir, { recursive: true });
    const clean = join(workDir, 'clean.ts');
    const fixed = join(workDir, `remuxed${extname(file) || '.mp4'}`);
    try {
      if (kind === 'png-wrapped') {
        const bytes = await unwrapFile(file, clean);
        log.info(`[stream-repair] Unwrapped ${basename(file)}: kept ${(bytes / 1048576).toFixed(1)} MB of video packets`);
      }
      const source = kind === 'png-wrapped' ? clean : file;
      const r = await runProbeChild(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-map', '0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', fixed,
      ], { timeoutMs: MUX_TIMEOUT_MS });
      if (r.code !== 0) {
        log.warn(`[stream-repair] Remux of ${basename(file)} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
        return false;
      }
      renameSync(fixed, file);
    } finally {
      rmSync(clean, { force: true });
      rmSync(fixed, { force: true });
    }
  }
  return hasPlayableStream(file, ffmpeg);
}
