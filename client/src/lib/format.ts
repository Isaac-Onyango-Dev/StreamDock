// Role: formatting helpers for bytes, speed, and timestamps.

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

export function formatTime(value: string): string {
  if (!value) return 'Calculating';
  const m = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(\d+)s$/i);
  if (m) {
    const parts: string[] = [];
    if (m[1]) parts.push(`${m[1]}h`);
    if (m[2]) parts.push(`${m[2]}m`);
    if (m[3]) parts.push(`${m[3]}s`);
    return parts.join(' ') || '0s';
  }
  if (/^[\d:.]+$/.test(value)) return `${value}s`;
  return value;
}

export function shortDate(value: string): string {
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
