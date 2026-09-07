import { useState, type CSSProperties } from 'react';
import { RefreshCw, CheckCircle2, Image as ImageIcon, MousePointerClick } from 'lucide-react';
import type { Settings } from '../../lib/types';
import { ALL_BACKGROUND_THEMES, SITE_GRADIENT_THEME } from '../../lib/backgroundThemes';

const PRESET_COLORS = [
  '#1a2a4a', '#0f1923', '#2d3748', '#4a4a4a', '#f5f5f0',
  '#ffffff', '#1e4d2b', '#7c2d12', '#78350f', '#3b0764'
];

interface BackgroundSettingsProps {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
}

/**
 * "Advanced Background" — the single place background is configured.
 *
 * Deliberately styled as a sibling of `YtDlpSettings` (same card, same heading
 * + description + `border-t` divider, same one-column width) so the two read as
 * a matched pair sitting side by side rather than two design systems.
 */
export function BackgroundSettings({ settings, onSettingsChange }: BackgroundSettingsProps) {
  const mode = settings.backgroundMode || 'gradient';
  const bgColor = settings.solidColorBg || '#1a2a4a';
  const intervalHrs = settings.bingRefreshInterval ? settings.bingRefreshInterval / 60 : 24;
  const previewUrl = settings.backgroundImageUrl || null;
  const [savedTick, setSavedTick] = useState(false);
  const [isFetching, setIsFetching] = useState(false);

  const saveSettings = async (updates: Partial<Settings>, sync = true) => {
    if (window.streamDock) {
      const next = await window.streamDock.updateSettings(updates);
      if (sync) onSettingsChange(next);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
      return next;
    }
    return null;
  };

  const handleColorChange = (hex: string) => {
    void saveSettings({ backgroundMode: 'solid', solidColorBg: hex });
  };

  /**
   * The site gradient is its own mode rather than a `theme` variant (it is the
   * app default), but the grid presents both uniformly — the user shouldn't
   * have to know which is which.
   */
  const handleThemeSelect = (themeId: string) => {
    if (themeId === SITE_GRADIENT_THEME.id) {
      void saveSettings({ backgroundMode: 'gradient' });
      return;
    }
    void saveSettings({ backgroundMode: 'theme', backgroundTheme: themeId });
  };

  const isThemeActive = (themeId: string) =>
    themeId === SITE_GRADIENT_THEME.id
      ? mode === 'gradient'
      : mode === 'theme' && settings.backgroundTheme === themeId;

  const syncLatestSettings = async () => {
    const next = await window.streamDock?.getSettings();
    if (next) onSettingsChange(next);
  };

  const handleModeSelect = async (newMode: 'bing' | 'picsum') => {
    if (previewUrl) {
      await saveSettings({ backgroundMode: newMode, bingRefreshInterval: intervalHrs * 60 });
      return;
    }

    if (!window.streamDock?.rotateNow) {
      await saveSettings({ backgroundMode: newMode, bingRefreshInterval: intervalHrs * 60 });
      return;
    }

    setIsFetching(true);
    await saveSettings({ backgroundMode: newMode, bingRefreshInterval: intervalHrs * 60 }, false);
    const url = await window.streamDock.rotateNow().finally(() => setIsFetching(false));

    if (url) {
      await saveSettings({ backgroundMode: newMode, backgroundImageUrl: url });
    } else {
      // Fetching failed — fall back to the app default rather than stranding
      // the user on a wallpaper mode with no wallpaper.
      await saveSettings({ backgroundMode: 'gradient' });
    }
  };

  const handleIntervalChange = (hrs: number) => {
    void saveSettings({ bingRefreshInterval: hrs * 60 });
  };

  const handleFetchNext = async () => {
    if (mode !== 'bing' && mode !== 'picsum') return;
    setIsFetching(true);
    const url = await window.streamDock?.rotateNow().finally(() => setIsFetching(false));
    if (url) {
      await saveSettings({ backgroundMode: mode, backgroundImageUrl: url });
    } else {
      await syncLatestSettings();
    }
  };

  const handleApplyPreview = () => {
    if (!previewUrl) {
      void handleModeSelect('picsum');
      return;
    }
    const wallpaperMode = mode === 'bing' || mode === 'picsum' ? mode : 'picsum';
    void saveSettings({ backgroundMode: wallpaperMode, backgroundImageUrl: previewUrl });
  };

  const isWallpaperMode = mode === 'bing' || mode === 'picsum';

  return (
    <section className="card card-pad">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-text-primary">Advanced Background</h3>
          <p className="mt-0.5 mb-4 text-xs text-text-secondary">
            Ambient themes, live wallpapers, and solid colors.
          </p>
        </div>
        {savedTick && (
          <span className="flex shrink-0 items-center text-[11px] text-success animate-fade-in">
            <CheckCircle2 className="mr-1 h-3 w-3" /> applied
          </span>
        )}
      </div>

      <div className="space-y-4 border-t border-border-subtle pt-3">
        {/* 1. Ambient themes */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Ambient theme</label>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {ALL_BACKGROUND_THEMES.map((theme) => {
              const isActive = isThemeActive(theme.id);
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => handleThemeSelect(theme.id)}
                  title={theme.hint}
                  aria-pressed={isActive}
                  className={`group overflow-hidden rounded-md border text-left transition-colors ${
                    isActive
                      ? 'border-accent ring-1 ring-accent'
                      : 'border-border-subtle hover:border-border'
                  }`}
                >
                  {/* The swatch shares its CSS rule with the live background, so
                      what is previewed here is literally what gets applied. */}
                  <span className={`theme-swatch block h-10 w-full ${theme.swatchClass}`} aria-hidden />
                  <span
                    className={`block truncate px-1.5 py-1 text-[10px] font-medium ${
                      isActive ? 'text-accent' : 'text-text-secondary group-hover:text-text-primary'
                    }`}
                  >
                    {theme.label}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-text-secondary">
            {SITE_GRADIENT_THEME.label} is the default and matches the StreamDock website.
          </p>
        </div>

        {/* 2. Live wallpaper */}
        <div className="border-t border-border-subtle pt-3">
          <label className="mb-2 block text-sm font-medium text-text-primary">Live wallpaper</label>

          <div className="mb-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => void handleModeSelect('bing')}
              className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${
                mode === 'bing'
                  ? 'border-accent bg-accent text-white'
                  : 'border-border-subtle bg-surface-3 text-text-secondary hover:bg-surface-4'
              }`}
            >
              Bing Daily
            </button>
            <button
              type="button"
              onClick={() => void handleModeSelect('picsum')}
              className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${
                mode === 'picsum'
                  ? 'border-accent bg-accent text-white'
                  : 'border-border-subtle bg-surface-3 text-text-secondary hover:bg-surface-4'
              }`}
            >
              Random Photo
            </button>
          </div>

          <div
            className={`group relative h-[140px] w-full overflow-hidden rounded-md border bg-surface-3 transition-all duration-200 ${
              isWallpaperMode ? 'border-accent ring-1 ring-accent' : 'border-border-subtle'
            }`}
          >
            {previewUrl ? (
              <div
                className="relative h-full w-full cursor-pointer"
                onClick={handleApplyPreview}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleApplyPreview();
                  }
                }}
              >
                <img
                  src={previewUrl}
                  alt="Wallpaper preview"
                  // Chromium's native image-drag gesture otherwise swallows the
                  // click before it reaches the handler.
                  draggable={false}
                  className="block h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  style={{ WebkitUserDrag: 'none' } as CSSProperties}
                />
                <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-300 group-hover:bg-black/30">
                  <div className="flex items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-medium text-white opacity-0 backdrop-blur-md transition-opacity duration-300 group-hover:opacity-100">
                    <MousePointerClick className="h-3.5 w-3.5" />
                    Set as Background
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleApplyPreview}
                disabled={isFetching}
                className="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-3 text-text-secondary transition-colors hover:bg-surface-4 disabled:cursor-wait disabled:opacity-70"
              >
                <ImageIcon className="h-7 w-7 text-text-disabled opacity-50" />
                <span className="text-xs font-medium">
                  {isFetching ? 'Fetching…' : 'Get Random Photo'}
                </span>
              </button>
            )}
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-secondary">Refresh every:</span>
              <select
                value={intervalHrs}
                onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10))}
                className="select-field h-7 w-[104px] px-2 py-0 text-[11px]"
                aria-label="Wallpaper refresh interval"
              >
                <option value={1}>1 hour</option>
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>

            <button
              type="button"
              onClick={() => void handleFetchNext()}
              className="btn-secondary h-7 px-2.5 text-xs"
              disabled={isFetching || !isWallpaperMode}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              Fetch Next
            </button>
          </div>
        </div>

        {/* 3. Solid color */}
        <div className="border-t border-border-subtle pt-3">
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-text-primary">Solid color</label>
            <span className="font-mono text-[11px] text-text-secondary">{bgColor.toUpperCase()}</span>
          </div>

          <div
            className={`mb-2.5 h-6 w-full rounded-md border shadow-inner transition-colors duration-150 ${
              mode === 'solid' ? 'border-accent' : 'border-border-subtle'
            }`}
            style={{ backgroundColor: bgColor }}
          />

          <div className="flex flex-wrap items-center gap-2">
            {PRESET_COLORS.map((color) => {
              const isActive = mode === 'solid' && color.toLowerCase() === bgColor.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => handleColorChange(color)}
                  className={`h-[22px] w-[22px] shrink-0 cursor-pointer rounded-full transition-transform duration-150 hover:scale-110 active:scale-95 ${
                    isActive
                      ? 'border border-text-primary shadow-[inset_0_0_0_2px_#fff,0_0_0_1px_var(--color-bg)]'
                      : 'border-2 border-transparent'
                  }`}
                  style={{
                    backgroundColor: color,
                    ...(color === '#ffffff' && !isActive ? { border: '1px solid var(--color-border-subtle)' } : {})
                  }}
                  title={color}
                  aria-label={`Select color ${color}`}
                  aria-pressed={isActive}
                />
              );
            })}

            <div className="mx-0.5 h-[20px] w-px bg-border-subtle" />

            <label
              className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 transition-colors ${
                mode === 'solid' && !PRESET_COLORS.includes(bgColor.toLowerCase())
                  ? 'border-accent bg-surface-4'
                  : 'border-border-subtle bg-surface-3 hover:bg-surface-4'
              }`}
            >
              <div
                className="relative h-[18px] w-[18px] shrink-0 overflow-hidden rounded-full border border-border-subtle"
                style={{ backgroundColor: bgColor }}
              >
                <input
                  type="color"
                  value={bgColor}
                  onInput={(e) => handleColorChange((e.target as HTMLInputElement).value)}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  aria-label="Custom color picker"
                />
              </div>
              <span className="text-[11px] text-text-secondary">Custom</span>
            </label>
          </div>
        </div>
      </div>
    </section>
  );
}
