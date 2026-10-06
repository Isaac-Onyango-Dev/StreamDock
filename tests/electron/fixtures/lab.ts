// Role: a local media lab for testing detection and downloading end to end.
//
// Two loopback servers give two origins: `page` serves what a user would paste,
// `cdn` serves the media and the embedded players. Every stream is cut from one
// synthetic 10-second clip made with the bundled ffmpeg, so a download can be
// compared frame by frame with what was served. Page scripts assemble their
// stream URLs at runtime, the way real players do, so yt-dlp's generic
// extractor cannot simply find them in the HTML.
import { spawn, spawnSync } from 'child_process';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { extname, join, normalize, sep } from 'path';

/** The AES-128 key the encrypted fixture is made with, so its output can be checked. */
export const TEST_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
export const CLIP_SECONDS = 10;

export interface LabRequest {
  server: 'page' | 'cdn';
  path: string;
  referer?: string;
  cookie?: string;
  status: number;
}

export interface Lab {
  page: string;
  cdn: string;
  /** The clip every fixture is cut from. */
  source: string;
  requests: LabRequest[];
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.bin': 'application/octet-stream',
  '.html': 'text/html; charset=utf-8',
};

function ffmpegRun(ffmpeg: string, args: string[], cwd?: string): void {
  const run = spawnSync(ffmpeg, ['-v', 'error', '-y', ...args], { encoding: 'utf-8', cwd });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${run.stderr}`);
}

/** Make the clip and every stream cut from it. Reused when already present. */
function buildMedia(dir: string, ffmpeg: string): void {
  const done = join(dir, '.complete');
  if (existsSync(done)) return;
  for (const sub of ['hls', 'aes', 'dash']) mkdirSync(join(dir, sub), { recursive: true });

  ffmpegRun(ffmpeg, [
    '-f', 'lavfi', '-i', `testsrc2=duration=${CLIP_SECONDS}:size=320x240:rate=25`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}`,
    // A keyframe every 2s, so stream-copied segments start cleanly.
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '50', '-c:a', 'aac', '-shortest',
    join(dir, 'source.mp4'),
  ]);

  const hls = ['-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod'];
  ffmpegRun(ffmpeg, ['-i', join(dir, 'source.mp4'), ...hls,
    '-hls_segment_filename', join(dir, 'hls', 'seg%03d.ts'), join(dir, 'hls', 'index.m3u8')]);
  writeFileSync(join(dir, 'hls', 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x240\nindex.m3u8\n');

  // Standard HLS AES-128: the key URI is in the playlist, as the spec intends.
  writeFileSync(join(dir, 'aes', 'key.bin'), TEST_KEY);
  writeFileSync(join(dir, 'aes', 'keyinfo'), `key.bin\n${join(dir, 'aes', 'key.bin')}\n`);
  ffmpegRun(ffmpeg, ['-i', join(dir, 'source.mp4'), ...hls, '-hls_key_info_file', join(dir, 'aes', 'keyinfo'),
    '-hls_segment_filename', join(dir, 'aes', 'seg%03d.ts'), join(dir, 'aes', 'index.m3u8')]);

  // Run inside the folder: on Windows the dash muxer resolves its segment
  // paths against the working directory, not the manifest's.
  ffmpegRun(ffmpeg, ['-i', join(dir, 'source.mp4'), '-c', 'copy', '-f', 'dash', '-seg_duration', '2',
    'manifest.mpd'], join(dir, 'dash'));

  writeFileSync(done, '');
}

/**
 * The decoded video frames of `input`, as a count and one hash over all of
 * them. Two files with the same answer show the same pictures, whatever their
 * container. Asynchronous on purpose: the input is often served by the lab
 * itself, and a blocking spawn would stop the server answering it.
 */
export function frameHash(ffmpeg: string, input: string): Promise<{ frames: number; hash: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-v', 'error', '-i', input, '-map', '0:v:0', '-f', 'framemd5', '-']);
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d; });
    child.stderr.on('data', (d: Buffer) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg framemd5 ${input}: ${err.trim()}`));
      const sums = out.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop()!.trim());
      resolve({ frames: sums.length, hash: createHash('md5').update(sums.join('\n')).digest('hex') });
    });
  });
}

/** A page whose script requests `parts.join('/')` after `delayMs`, like a player would. */
function playerPage(title: string, parts: string[], delayMs = 0): string {
  return `<!doctype html><title>${title}</title><h1>${title}</h1><video></video><script>
setTimeout(() => { fetch(${JSON.stringify(parts)}.join('/')).catch(() => {}); }, ${delayMs});
</script>`;
}

function iframePage(title: string, src: string): string {
  return `<!doctype html><title>${title}</title><h1>${title}</h1><iframe src="${src}" width="640" height="360"></iframe>`;
}

export async function startLab(dir: string, ffmpeg: string): Promise<Lab> {
  mkdirSync(dir, { recursive: true });
  buildMedia(dir, ffmpeg);
  const requests: LabRequest[] = [];
  const page = createServer();
  const cdn = createServer();
  await Promise.all([page, cdn].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', r))));
  const origin = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const P = origin(page);
  const C = origin(cdn);

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers });
    res.end(body);
  };
  const html = (res: ServerResponse, body: string, headers: Record<string, string> = {}) => send(res, 200, TYPES['.html'], body, headers);
  /** A file from the media folder; never outside it. */
  const file = (res: ServerResponse, rel: string) => {
    const path = normalize(join(dir, rel));
    if (!path.startsWith(normalize(dir) + sep) || !existsSync(path)) return send(res, 404, 'text/plain', 'not found');
    send(res, 200, TYPES[extname(path)] ?? 'application/octet-stream', readFileSync(path));
  };

  const pages: Record<string, () => string> = {
    '/html5.html': () => `<!doctype html><title>HTML5 video page</title><video src="${C}/media/source.mp4" controls></video>`,
    '/js-hls.html': () => playerPage('JS player page', [C, 'media', 'hls', 'master.m3u8'], 1500),
    '/dash.html': () => playerPage('DASH player page', [C, 'media', 'dash', 'manifest.mpd']),
    '/iframe-gated.html': () => iframePage('Embedded player page', `${C}/embed/gated.html`),
    '/iframe-cookie.html': () => iframePage('Cookie player page', `${C}/embed/cookie.html`),
    '/redirect.html': () => playerPage('Redirect player page', [P, 'go', 'stream']),
    '/extless.html': () => playerPage('Extensionless player page', [C, 'api', 'stream?id=1']),
    '/aes.html': () => playerPage('AES player page', [C, 'media', 'aes', 'index.m3u8']),
    '/opaque.html': () => playerPage('Opaque player page', [C, 'opaque', 'master.m3u8']),
    '/drm-hls.html': () => playerPage('DRM HLS page', [C, 'drm', 'master.m3u8']),
    '/drm-dash.html': () => playerPage('DRM DASH page', [C, 'drm', 'manifest.mpd']),
    '/novideo.html': () => '<!doctype html><title>Text only</title><p>No video here.</p>',
  };

  page.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    const log = (status: number) => requests.push({ server: 'page', path: req.url ?? '', referer: req.headers.referer, cookie: req.headers.cookie, status });
    if (path === '/go/stream') {
      log(302);
      res.writeHead(302, { Location: `${C}/media/hls/master.m3u8`, 'Access-Control-Allow-Origin': '*' });
      return res.end();
    }
    const make = pages[path];
    log(make ? 200 : 404);
    if (make) return html(res, make());
    send(res, 404, 'text/plain', 'not found');
  });

  const opaque = (() => {
    // The master playlist, AES-256-CBC encrypted with a key nobody is given.
    const cipher = createCipheriv('aes-256-cbc', randomBytes(32), randomBytes(16));
    const plain = readFileSync(join(dir, 'hls', 'master.m3u8'));
    return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
  })();

  cdn.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', C);
    const path = url.pathname;
    let status = 200;
    const deny = () => { status = 403; send(res, 403, 'text/plain', 'forbidden'); };
    try {
      if (path.startsWith('/media/')) file(res, path.slice('/media/'.length));
      else if (path.startsWith('/gated/')) {
        // A CDN that serves only its own player, as measured on real embeds.
        if (!(req.headers.referer ?? '').startsWith(`${C}/`)) deny();
        else file(res, path.slice('/gated/'.length));
      } else if (path.startsWith('/cookie/')) {
        if (!(req.headers.cookie ?? '').includes('lab_session=granted')) deny();
        else file(res, path.slice('/cookie/'.length));
      } else if (path === '/embed/gated.html') {
        html(res, playerPage('Gated embed', [C, 'gated', 'hls', 'master.m3u8']));
      } else if (path === '/embed/cookie.html') {
        html(res, playerPage('Cookie embed', [C, 'cookie', 'hls', 'master.m3u8']), { 'Set-Cookie': 'lab_session=granted; Path=/' });
      } else if (path === '/api/stream') {
        // A playlist at a URL with no extension; only its Content-Type says what it is.
        const media = readFileSync(join(dir, 'hls', 'index.m3u8'), 'utf-8').replace(/^(seg\d+\.ts)$/gm, `${C}/media/hls/$1`);
        send(res, 200, TYPES['.m3u8'], media);
      } else if (path === '/opaque/master.m3u8') {
        send(res, 200, TYPES['.m3u8'], opaque);
      } else if (path === '/drm/master.m3u8') {
        send(res, 200, TYPES['.m3u8'], '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nindex.m3u8\n');
      } else if (path === '/drm/index.m3u8') {
        // FairPlay signalling. The segments behind it are the plain ones; only
        // the declaration matters to a downloader.
        const media = readFileSync(join(dir, 'hls', 'index.m3u8'), 'utf-8')
          .replace('#EXTINF', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://lab-key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n#EXTINF')
          .replace(/^(seg\d+\.ts)$/gm, `${C}/media/hls/$1`);
        send(res, 200, TYPES['.m3u8'], media);
      } else if (path === '/drm/manifest.mpd') {
        // Widevine signalling on every adaptation set.
        const mpd = readFileSync(join(dir, 'dash', 'manifest.mpd'), 'utf-8')
          .replace(/<AdaptationSet([^>]*)>/g, '<AdaptationSet$1><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>')
          .replace(/<MPD /, `<MPD xmlns:cenc="urn:mpeg:cenc:2013" `)
          .replace(/(initialization|media)="/g, `$1="${C}/media/dash/`);
        send(res, 200, TYPES['.mpd'], mpd);
      } else if (path === '/fake.mp4') {
        // Labelled as video, but it is a web page.
        send(res, 200, 'video/mp4', '<!doctype html><html><body>This is not a video.</body></html>');
      } else {
        status = 404;
        send(res, 404, 'text/plain', 'not found');
      }
    } catch {
      status = 500;
      send(res, 500, 'text/plain', 'error');
    }
    requests.push({ server: 'cdn', path: req.url ?? '', referer: req.headers.referer, cookie: req.headers.cookie, status: status === 200 ? res.statusCode : status });
  });

  const close = (s: Server) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  return { page: P, cdn: C, source: join(dir, 'source.mp4'), requests, close: async () => { await Promise.all([close(page), close(cdn)]); } };
}
