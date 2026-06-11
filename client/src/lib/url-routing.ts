// Role: renderer URL hints for choosing Video vs Live Stream mode.
import type { CaptureMode } from './types';

function matchHost(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const STREAM_HOSTS = ['twitch.tv', 'kick.com', 'trovo.live', 'afreecatv.com'];

export function inferModeFromText(value: string): CaptureMode {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const path = parsed.pathname.toLowerCase();

    if (path.includes('.m3u8') || path.includes('.mpd')) return 'stream';
    if (matchHost(host, STREAM_HOSTS)) return 'stream';
    if ((host === 'youtube.com' || host.endsWith('.youtube.com')) && path.includes('/live')) return 'stream';
    return 'video';
  } catch {
    return 'video';
  }
}
