// Role: the settings shape both processes speak — the one definition.
//
// It was written out three times (persistence, preload, renderer) and had
// drifted: the preload's copy had no ytdlpOptions or engineConfirmedLatest at
// all. Fields nothing read were carried in every copy too — useCookies (read
// by nothing since browser cookies were disabled), scheduledStartTime (read by
// nothing, ever) and hasOnboarded (written only by an IPC nothing called).
import type { SubtitleMode } from './subtitle-args';

/**
 * 'gradient' is the install site's own gradient and the app default;
 * 'theme' selects one of the ambient themes named by `backgroundTheme`.
 */
export type BackgroundMode = 'solid' | 'bing' | 'picsum' | 'gradient' | 'theme';

/**
 * What closing the window does while downloads still have work to do.
 *
 * It used to be hard-wired to "hide to the tray", with no setting and — on
 * macOS and Linux — no word to the user that anything was still running.
 */
export type CloseBehavior = 'tray-when-active' | 'quit' | 'ask';

export interface AppSettings {
  downloadDir: string;
  maxConcurrent?: number;
  densityMode?: 'comfortable' | 'compact';
  backgroundMode?: BackgroundMode;
  backgroundImageUrl?: string;
  solidColorBg?: string;
  /** Ambient theme id, used when backgroundMode is 'theme'. */
  backgroundTheme?: string;
  bingRefreshInterval?: number;
  clipboardWatcher?: boolean;
  /** Defaults to 'tray-when-active' (Isaac's decision, session 22). */
  closeBehavior?: CloseBehavior;
  /** Whether the "still downloading in the background" hint has been shown once. */
  trayHintShown?: boolean;
  ytdlpOptions?: {
    /**
     * Subtitles for a download in its original language (Sub): the starting
     * value of the per-download picker, never an override of it.
     *
     * Replaces `embedSubs`, which was a global override applied *after* the
     * per-download choice — so "None" still embedded.
     */
    subtitleMode?: SubtitleMode;
    /**
     * Subtitles for a dubbed download. A dub is usually watched without them,
     * so this defaults to none; Sub keeps `subtitleMode`.
     */
    subtitleModeForDub?: SubtitleMode;
    /** @deprecated Migrated to `subtitleMode` on read. Kept so old files still parse. */
    embedSubs?: boolean;
    embedMetadata?: boolean;
    sponsorBlock?: boolean;
    customArgs?: string;
  };
  /**
   * The yt-dlp version that `-U` last confirmed was the newest release
   * available. Age alone cannot tell whether a newer release exists — yt-dlp's
   * gaps between stable releases have reached 84 days — so the mild staleness
   * banner is suppressed for exactly the version yt-dlp itself called current.
   * The severe (90-day) warning is never suppressed.
   */
  engineConfirmedLatest?: string;
}
