import { useState, type CSSProperties } from 'react';
import { RefreshCw, CheckCircle2, Image as ImageIcon, MousePointerClick } from 'lucide-react';
import type { Settings } from '../../lib/types';

const PRESET_COLORS = [
  '#1a2a4a', '#0f1923', '#2d3748', '#4a4a4a', '#f5f5f0',
  '#ffffff', '#1e4d2b', '#7c2d12', '#78350f', '#3b0764'
];

interface BackgroundSettingsProps {
  settings: Settings;
  onSettingsChange: (s: Settings) => void;
}

export function BackgroundSettings({ settings, onSettingsChange }: BackgroundSettingsProps) {
  const mode = settings.backgroundMode || 'solid';
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
      await saveSettings({ backgroundMode: 'solid' });
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

  return (
    <section className="card card-pad md:col-span-2">
      <div className="flex flex-col gap-4">
        
        {/* 1. Dynamic Wallpaper Section */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.07em]">Dynamic Wallpaper</span>
            {savedTick && (
              <span className="text-[11px] text-success flex items-center animate-fade-in">
                <CheckCircle2 className="h-3 w-3 mr-1" /> saved
              </span>
            )}
          </div>
          
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => void handleModeSelect('bing')}
              className={`flex-1 py-2 rounded-md border text-sm font-medium transition-colors ${
                mode === 'bing' 
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface-2 border-border-subtle text-text-secondary hover:bg-surface-3'
              }`}
            >
              Bing Daily
            </button>
            <button
              onClick={() => void handleModeSelect('picsum')}
              className={`flex-1 py-2 rounded-md border text-sm font-medium transition-colors ${
                mode === 'picsum' 
                  ? 'bg-accent border-accent text-white'
                  : 'bg-surface-2 border-border-subtle text-text-secondary hover:bg-surface-3'
              }`}
            >
              Random Photo
            </button>
          </div>

          <div className={`w-full h-[200px] rounded-lg overflow-hidden relative bg-surface-1 transition-all duration-200 border border-border-subtle group ${
            (mode === 'bing' || mode === 'picsum') ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''
          }`}>
            {previewUrl ? (
              <div 
                className="w-full h-full relative cursor-pointer"
                onClick={handleApplyPreview}
                role="button"
                tabIndex={0}
              >
                <img
                  src={previewUrl}
                  alt="Wallpaper preview"
                  draggable={false}
                  className="w-full h-full object-cover block transition-transform duration-500 group-hover:scale-105"
                  style={{ WebkitUserDrag: 'none' } as CSSProperties}
                />
                <div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/30 flex items-center justify-center">
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center gap-2 bg-black/70 text-white px-4 py-2 rounded-full text-sm font-medium backdrop-blur-md">
                    <MousePointerClick className="h-4 w-4" />
                    Set as Background
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleApplyPreview}
                disabled={isFetching}
                className="w-full h-full bg-surface-2 flex flex-col items-center justify-center gap-2 text-text-secondary transition-colors hover:bg-surface-3 disabled:cursor-wait disabled:opacity-70"
              >
                <ImageIcon className="h-8 w-8 text-text-disabled opacity-50" />
                <span className="text-xs font-medium">
                  {isFetching ? 'Fetching...' : 'Get Random Photo'}
                </span>
              </button>
            )}
          </div>

          <div className="mt-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-text-secondary">Refresh every:</span>
              <select
                value={intervalHrs}
                onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10))}
                className="input-field h-[28px] text-[12px] py-1 px-2 w-[120px]"
              >
                <option value={1}>1 hour</option>
                <option value={6}>6 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
              </select>
            </div>
            
            <button 
              onClick={() => void handleFetchNext()}
              className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
              disabled={isFetching || (mode !== 'bing' && mode !== 'picsum')}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              Fetch Next
            </button>
          </div>
        </div>

        <div className="h-px bg-border-subtle my-2" />

        {/* 2. Background Color Section */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.07em]">Solid Color</span>
            <span className="flex items-center gap-2">
              {/* Applying a colour used to produce no visible change anywhere
                  (see the chrome/overlay fixes in index.css), so there was no
                  way to tell a click had registered. */}
              {savedTick && mode === 'solid' && (
                <span className="text-[11px] text-success flex items-center animate-fade-in">
                  <CheckCircle2 className="h-3 w-3 mr-1" /> applied
                </span>
              )}
              <span className="text-[11px] text-text-secondary font-mono">{bgColor.toUpperCase()}</span>
            </span>
          </div>
          
          <div 
            className="w-full h-8 rounded-lg mb-3 transition-colors duration-150 border border-border-subtle shadow-inner"
            style={{ backgroundColor: bgColor }}
          />

          <div className="flex items-center gap-2.5 flex-wrap">
            {PRESET_COLORS.map((color) => {
              const isActive = mode === 'solid' && color.toLowerCase() === bgColor.toLowerCase();
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => handleColorChange(color)}
                  className={`h-[26px] w-[26px] rounded-full cursor-pointer shrink-0 transition-transform duration-150 hover:scale-110 active:scale-95 ${
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
                />
              );
            })}
            
            <div className="w-[1px] h-[22px] bg-border-subtle mx-0.5" />
            
            <label className={`flex items-center gap-1.5 border rounded-md px-2 py-1 cursor-pointer transition-colors ${
              mode === 'solid' && !PRESET_COLORS.includes(bgColor.toLowerCase())
                ? 'bg-surface-3 border-accent'
                : 'bg-surface-2 border-border-subtle hover:bg-surface-3'
            }`}>
              <div className="relative h-[22px] w-[22px] shrink-0 rounded-full overflow-hidden border border-border-subtle" style={{ backgroundColor: bgColor }}>
                <input
                  type="color"
                  value={bgColor}
                  onInput={(e) => handleColorChange((e.target as HTMLInputElement).value)}
                  className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                  aria-label="Custom color picker"
                />
              </div>
              <span className="text-[11px] text-text-secondary mr-1">Custom</span>
            </label>
          </div>
        </div>

      </div>
    </section>
  );
}
