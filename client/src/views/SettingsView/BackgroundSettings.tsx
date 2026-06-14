import { useState, useEffect, useRef } from 'react';
import { RefreshCw, CheckCircle2, AlertCircle, Image as ImageIcon, MousePointerClick } from 'lucide-react';

const PRESET_COLORS = [
  '#1a2a4a', '#0f1923', '#2d3748', '#4a4a4a', '#f5f5f0',
  '#ffffff', '#1e4d2b', '#7c2d12', '#78350f', '#3b0764'
];

export function BackgroundSettings() {
  const [bgColor, setBgColor] = useState('#1a2a4a');
  const [intervalHrs, setIntervalHrs] = useState(24);
  const [savedTick, setSavedTick] = useState(false);
  const [nextRefreshMsg, setNextRefreshMsg] = useState('');
  const [fetchErrorState, setFetchErrorState] = useState(false);
  
  // RESTORED: State variable to track active background mode for visual states
  const [backgroundMode, setBackgroundMode] = useState<'solid' | 'bing'>('solid');

  // RESTORED: Watch for DOM mode changes to keep state synced without altering color logic
  useEffect(() => {
    const appBg = document.querySelector('.app-background');
    if (!appBg) return;
    
    if (appBg.getAttribute('data-bg-mode') === 'bing') {
      setBackgroundMode('bing');
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.attributeName === 'data-bg-mode') {
          setBackgroundMode(appBg.getAttribute('data-bg-mode') === 'bing' ? 'bing' : 'solid');
        }
      });
    });
    
    observer.observe(appBg, { attributes: true });
    return () => observer.disconnect();
  }, []);
  
  const [bingImage, setBingImage] = useState<{ url: string, title: string } | null>(null);
  const [bingLoading, setBingLoading] = useState(true);
  const [bingError, setBingError] = useState(false);

  const timerARef = useRef<NodeJS.Timeout | null>(null);
  const timerBRef = useRef<NodeJS.Timeout | null>(null);
  
  const NEXT_REFRESH_KEY = 'bing_next_refresh_ts';
  const INTERVAL_KEY = 'bing_widget_interval';
  
  useEffect(() => {
    const savedColor = localStorage.getItem('bing_widget_bg_color') || '#1a2a4a';
    const savedInterval = parseInt(localStorage.getItem(INTERVAL_KEY) || '24', 10);
    
    setBgColor(savedColor);
    setIntervalHrs(savedInterval);
    
    // FIX: Apply the saved color visually to the DOM on mount, 
    // but ONLY if the app is not in Bing mode, to prevent conflicting with Bing's mount behavior.
    const appBg = document.querySelector('.app-background') as HTMLElement;
    if (appBg && appBg.getAttribute('data-bg-mode') !== 'bing') {
      appBg.style.setProperty('--bg-solid-color', savedColor);
      appBg.setAttribute('data-bg-mode', 'solid');
    }
    
    const savedTs = parseInt(localStorage.getItem(NEXT_REFRESH_KEY) || '0', 10);
    const intervalMs = savedInterval * 3600000;
    
    if (savedTs && savedTs > Date.now()) {
      const savedUrl = localStorage.getItem('bing_last_image_url');
      if (savedUrl) {
        setBingImage({ url: savedUrl, title: 'Bing Daily Wallpaper' });
        setBingLoading(false);
      } else {
        void runFetchCycle(intervalMs);
      }
      startTimers(intervalMs, savedTs);
    } else {
      void runFetchCycle(intervalMs);
    }

    return () => clearBothTimers();
  }, []);

  const clearBothTimers = () => {
    if (timerARef.current) clearInterval(timerARef.current);
    if (timerBRef.current) clearInterval(timerBRef.current);
  };

  const fetchBingImage = async (): Promise<string | null> => {
    try {
      const res = await fetch('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=en-US');
      const data = await res.json();
      const path = data?.images?.[0]?.url;
      if (!path) return null;
      return `https://www.bing.com${path}`;
    } catch {
      return null;
    }
  };

  const runFetchCycle = async (intervalMs: number) => {
    clearBothTimers();
    setNextRefreshMsg('Refreshing wallpaper...');
    setBingLoading(true);
    setFetchErrorState(false);
    
    const newUrl = await fetchBingImage();
    const now = Date.now();
    let nextTs: number;
    
    if (newUrl === null) {
      console.warn('Bing fetch failed silently');
      setFetchErrorState(true);
      setNextRefreshMsg('Refresh failed — retrying in 30min');
      nextTs = now + (intervalMs / 2); // Retry at half interval
    } else {
      const savedUrl = localStorage.getItem('bing_last_image_url');
      if (newUrl !== savedUrl) {
        localStorage.setItem('bing_last_image_url', newUrl);
        setBingImage({ url: newUrl, title: 'Bing Daily Wallpaper' });
        
        const appBg = document.querySelector('.app-background') as HTMLElement;
        if (appBg && appBg.getAttribute('data-bg-mode') === 'bing') {
          appBg.style.setProperty('--bg-bing-image', `url("${newUrl}")`);
          void window.streamDock?.updateSettings({ backgroundImageUrl: newUrl });
        }
      } else {
        if (!bingImage) {
           setBingImage({ url: newUrl, title: 'Bing Daily Wallpaper' });
        }
      }
      nextTs = now + intervalMs;
    }
    
    setBingLoading(false);
    localStorage.setItem(NEXT_REFRESH_KEY, nextTs.toString());
    startTimers(intervalMs, nextTs);
  };

  const applyColorToDOM = (hex: string) => {
    // We also must ensure backgroundMode is solid so App.tsx hides the bing image CSS
    void window.streamDock?.updateSettings({ backgroundMode: 'solid', solidColorBg: hex });
    
    // FIX: Target the exact same element as Bing and use the CSS variable instead of backgroundColor
    const appBg = document.querySelector('.app-background') as HTMLElement;
    if (appBg) {
      appBg.style.setProperty('--bg-solid-color', hex);
      appBg.setAttribute('data-bg-mode', 'solid'); // Ensures Bing overlay is hidden
    }
  };

  const handleColorChange = (hex: string) => {
    setBgColor(hex);
    applyColorToDOM(hex);
    localStorage.setItem('bing_widget_bg_color', hex);
  };

  const applyBingAsBackground = () => {
    if (!bingImage) return;
    
    // RESTORED: Set local mode state for active styling
    setBackgroundMode('bing');

    void window.streamDock?.updateSettings({ 
      backgroundMode: 'bing', 
      backgroundImageUrl: bingImage.url 
    });

    // RESTORED: Direct DOM mutation to apply Bing image without waiting for App.tsx React state
    const appBg = document.querySelector('.app-background') as HTMLElement;
    if (appBg) {
      appBg.style.setProperty('--bg-bing-image', `url("${bingImage.url}")`);
      appBg.setAttribute('data-bg-mode', 'bing');
      appBg.parentElement?.setAttribute('data-bg-mode', 'bing');
    }
  };

  const startTimers = (intervalMs: number, resumeTs?: number) => {
    clearBothTimers();
    const now = Date.now();
    const targetTs = resumeTs || (now + intervalMs);
    
    if (targetTs <= now) {
      void runFetchCycle(intervalMs);
      return;
    }
    
    const updateLabel = () => {
      const storedTs = parseInt(localStorage.getItem(NEXT_REFRESH_KEY) || '0', 10);
      const remaining = storedTs - Date.now();
      
      if (remaining <= 0) {
        void runFetchCycle(intervalMs);
        return;
      }
      
      if (fetchErrorState) {
        return; // Keep error message until next retry
      }
      
      const totalSecs = Math.floor(remaining / 1000);
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = totalSecs % 60;
      
      if (h > 0) setNextRefreshMsg(`${h}h ${m.toString().padStart(2, '0')}min`);
      else if (m > 0) setNextRefreshMsg(`${m.toString().padStart(2, '0')}min ${s.toString().padStart(2, '0')}s`);
      else setNextRefreshMsg(`${s}s`);
    };

    updateLabel();
    
    // Timer A: Ticks every 1 second
    timerARef.current = setInterval(updateLabel, 1000);
    
    // Timer B: Ticks every intervalMs
    timerBRef.current = setInterval(() => {
      void runFetchCycle(intervalMs);
    }, intervalMs);
  };

  const handleIntervalChange = (val: number) => {
    setIntervalHrs(val);
    localStorage.setItem(INTERVAL_KEY, val.toString());
    
    const intervalMs = val * 3600000;
    const newTs = Date.now() + intervalMs;
    localStorage.setItem(NEXT_REFRESH_KEY, newTs.toString());
    
    setFetchErrorState(false);
    startTimers(intervalMs, newTs);
    
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 1500);
  };

  return (
    <section className="card card-pad md:col-span-2">
      <div className="flex flex-col gap-4">
        
        {/* 1. Bing Image Area */}
        <div className={`w-full h-[200px] rounded-lg overflow-hidden relative bg-surface-1 group transition-all duration-200 ${
          backgroundMode === 'bing' 
            ? 'border-[3px] border-text-primary shadow-[0_0_0_2px_var(--color-bg)]' 
            : 'border border-border-subtle'
        }`}>
          {bingLoading ? (
            <div className="w-full h-full bg-surface-2 animate-pulse flex items-center justify-center">
              <ImageIcon className="h-8 w-8 text-text-disabled opacity-50" />
            </div>
          ) : bingError ? (
            <div className="w-full h-full flex flex-col items-center justify-center bg-surface-2 gap-2">
              <AlertCircle className="h-6 w-6 text-text-secondary" />
              <span className="text-xs text-text-secondary">Failed to load Bing image</span>
              <button type="button" onClick={() => void runFetchCycle(intervalHrs * 3600000)} className="btn-secondary text-xs px-3 py-1">Retry</button>
            </div>
          ) : bingImage ? (
            <div 
              className="w-full h-full relative cursor-pointer"
              onClick={applyBingAsBackground}
              role="button"
              tabIndex={0}
              aria-label="Set Bing wallpaper as background"
            >
              <img src={bingImage.url} alt={bingImage.title} className="w-full h-full object-cover block transition-transform duration-500 group-hover:scale-105" />
              <div className="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/30 flex items-center justify-center">
                <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-center gap-2 bg-black/70 text-white px-4 py-2 rounded-full text-sm font-medium backdrop-blur-md">
                  <MousePointerClick className="h-4 w-4" />
                  Set as Background
                </div>
              </div>
              <div className="absolute bottom-0 left-0 right-0 p-3.5 bg-gradient-to-t from-black/80 via-black/40 to-transparent flex justify-between items-end pointer-events-none">
                <span className="text-white text-xs opacity-90 font-medium drop-shadow-md">{bingImage.title}</span>
                <span className="bg-black/40 border border-white/20 text-white text-[11px] px-2 py-1 rounded shadow-sm backdrop-blur-md flex items-center gap-1.5">
                  <RefreshCw className="h-3 w-3" />
                  Next in {nextRefreshMsg}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="h-px bg-border-subtle" />

        {/* 2. Background Color Section */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.07em]">Background color</span>
            <span className="text-[11px] text-text-tertiary font-mono">{bgColor.toUpperCase()}</span>
          </div>
          
          <div 
            className="w-full h-8 rounded-lg mb-3 transition-colors duration-150 border border-border-subtle shadow-inner"
            style={{ backgroundColor: bgColor }}
          />

          <div className="flex items-center gap-2.5 flex-wrap">
            {PRESET_COLORS.map((color) => {
              const isActive = color.toLowerCase() === bgColor.toLowerCase();
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
            
            <label className="flex items-center gap-1.5 bg-surface-2 border border-border-subtle rounded-md px-2 py-1 cursor-pointer hover:bg-surface-3 transition-colors">
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

        <div className="h-px bg-border-subtle" />

        {/* 3. Refresh Interval Section */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-[11px] font-medium text-text-secondary uppercase tracking-[0.07em]">Wallpaper refresh interval</span>
            {savedTick && (
              <span className="text-[11px] text-success flex items-center animate-fade-in">
                <CheckCircle2 className="h-3 w-3 mr-1" /> saved
              </span>
            )}
          </div>
          
          <div className="flex items-center">
            <select
              value={intervalHrs}
              onChange={(e) => handleIntervalChange(parseInt(e.target.value, 10))}
              className="flex-1 input-field h-[34px] text-[13px] py-1.5 px-2.5"
              aria-label="Refresh interval"
            >
              <option value={1}>Every 1 hour</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Every 24 hours (daily)</option>
              <option value={48}>Every 48 hours</option>
            </select>
          </div>
          
          <div className="mt-2.5 text-[11px] text-text-tertiary flex items-center gap-1.5">
            <RefreshCw className="h-3 w-3" />
            <span>Next wallpaper refresh in {nextRefreshMsg}</span>
          </div>
        </div>

      </div>
    </section>
  );
}
