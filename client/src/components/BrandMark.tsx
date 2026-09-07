/**
 * The StreamDock app mark.
 *
 * Transcribed from `assets/icon.svg`, the canonical brand asset shared with the
 * installer icon and the website's nav mark, so the in-app logo is the same
 * shape users see everywhere else. It is inlined rather than loaded as a file
 * because the renderer is bundled and `assets/` is packaged for the main
 * process, and because an inline SVG inherits the crispness of the surrounding
 * UI at any size.
 *
 * The gradient id is suffixed per instance: two of these on one page with the
 * same id would make the second reference the first's gradient, and any later
 * unmount would strip the fill from whichever remained.
 */
interface BrandMarkProps {
  className?: string;
  /** Unique suffix for the gradient id. Only needed if several are rendered. */
  idSuffix?: string;
}

export function BrandMark({ className, idSuffix = 'default' }: BrandMarkProps) {
  const gradientId = `streamdock-mark-${idSuffix}`;

  return (
    <svg
      viewBox="0 0 256 256"
      className={className}
      role="img"
      aria-label="StreamDock"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset=".55" stopColor="#EC4899" />
          <stop offset="1" stopColor="#FBBF24" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="64" fill={`url(#${gradientId})`} />
      <path d="M100 80 L176 128 L100 176 Z" fill="#0A0716" />
      <circle cx="200" cy="56" r="16" fill="#fff" />
    </svg>
  );
}
