// Subtitle delivery for streams whose subtitles the player loads beside the
// manifest. Fetch and ffmpeg are faked here; the mux itself was checked against
// the bundled ffmpeg by hand (see the commit that added this file).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetches: Array<{ url: string; headers?: Record<string, string> }> = [];
let serve: { status: number; body: string | null } = { status: 200, body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n' };
const muxes: string[][] = [];
let muxExit = 0;

vi.mock('./probe-support', () => ({
  fetchWithDeadline: vi.fn(async (url: string, options: { headers?: Record<string, string> }) => {
    fetches.push({ url, headers: options.headers });
    return { ...serve, setCookies: [] };
  }),
  runProbeChild: vi.fn(async (_command: string, args: string[]) => {
    muxes.push(args);
    // ffmpeg writes its output file last on the command line.
    if (muxExit === 0) writeFileSync(args[args.length - 1], 'video+subs');
    return { code: muxExit, stdout: '', stderr: muxExit ? 'Invalid data' : '' };
  }),
}));

const { attachSubtitles, subtitleCodecFor } = await import('./subtitle-attach');

const TRACK = { url: 'https://cdn.example/subs/eng.vtt?t=1', referer: 'https://megaplay.buzz/' };
let dir = '';
let staging = '';
let video = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'streamdock-subs-'));
  staging = join(dir, '.streamdock-incomplete', 'job');
  video = join(dir, 'One Piece - Episode 1.mp4');
  writeFileSync(video, 'video');
  fetches.length = 0;
  muxes.length = 0;
  muxExit = 0;
  serve = { status: 200, body: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n' };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const beside = () => readdirSync(dir).filter((n) => !n.startsWith('.')).sort();

describe('attachSubtitles', () => {
  it('embeds into the video with the player\'s referer and leaves no loose file', async () => {
    expect(await attachSubtitles(video, [TRACK], 'embed', 'ffmpeg', staging)).toBe(1);

    expect(fetches[0]).toEqual({ url: TRACK.url, headers: { Referer: TRACK.referer } });
    expect(muxes[0]).toEqual(expect.arrayContaining(['-c', 'copy', '-c:s', 'mov_text']));
    expect(readFileSync(video, 'utf-8')).toBe('video+subs');
    expect(beside()).toEqual(['One Piece - Episode 1.mp4']);
  });

  it('writes a sidecar named after the video, without touching the video', async () => {
    await attachSubtitles(video, [TRACK], 'sidecar', 'ffmpeg', staging);
    expect(beside()).toEqual(['One Piece - Episode 1.mp4', 'One Piece - Episode 1.vtt']);
    expect(muxes).toHaveLength(0);
    expect(readFileSync(video, 'utf-8')).toBe('video');
  });

  it('does both when asked for both', async () => {
    await attachSubtitles(video, [TRACK], 'both', 'ffmpeg', staging);
    expect(beside()).toEqual(['One Piece - Episode 1.mp4', 'One Piece - Episode 1.vtt']);
    expect(readFileSync(video, 'utf-8')).toBe('video+subs');
  });

  it('keeps the subtitles as a file when embedding fails, and the video intact', async () => {
    muxExit = 1;
    expect(await attachSubtitles(video, [TRACK], 'embed', 'ffmpeg', staging)).toBe(1);
    expect(beside()).toEqual(['One Piece - Episode 1.mp4', 'One Piece - Episode 1.vtt']);
    expect(readFileSync(video, 'utf-8')).toBe('video');
    expect(existsSync(join(staging, 'subtitled.mp4'))).toBe(false);
  });

  it('delivers nothing from an error page served as 200', async () => {
    serve = { status: 200, body: '<html>Just a moment...</html>' };
    expect(await attachSubtitles(video, [TRACK], 'sidecar', 'ffmpeg', staging)).toBe(0);
    expect(beside()).toEqual(['One Piece - Episode 1.mp4']);
  });

  it('does nothing at all for "none"', async () => {
    mkdirSync(staging, { recursive: true });
    expect(await attachSubtitles(video, [TRACK], 'none', 'ffmpeg', staging)).toBe(0);
    expect(fetches).toHaveLength(0);
  });
});

describe('subtitleCodecFor', () => {
  it('picks the one text codec each container accepts', () => {
    expect(subtitleCodecFor('a.mp4')).toBe('mov_text');
    expect(subtitleCodecFor('a.webm')).toBe('webvtt');
    expect(subtitleCodecFor('a.mkv')).toBe('srt');
  });
});
