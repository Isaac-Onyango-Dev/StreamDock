import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Download, Minus, Settings, Square, Link2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Tab } from '../../lib/types';

interface AppChromeProps {
  currentTab: Tab;
  activeCount: number;
  onTabChange: (tab: Tab) => void;
  children: ReactNode;
}

interface NavItem {
  tab: Tab;
  label: string;
  icon: LucideIcon;
}

const navItems: NavItem[] = [
  { tab: 'capture', label: 'Capture', icon: Link2 },
  { tab: 'transfers', label: 'Downloads', icon: Download },
  { tab: 'settings', label: 'Settings', icon: Settings },
];

const pageCopy: Record<Tab, { title: string; description: string }> = {
  capture: {
    title: 'Capture',
    description: 'Paste a URL to download video or capture a live stream.',
  },
  transfers: {
    title: 'Downloads',
    description: 'Track progress and manage your download queue.',
  },
  settings: {
    title: 'Settings',
    description: 'Save location, engine binaries, and preferences.',
  },
};

export function AppChrome({ currentTab, activeCount, onTabChange, children }: AppChromeProps) {
  const [isFocused, setIsFocused] = useState(true);
  const [platform, setPlatform] = useState('win32');

  useEffect(() => {
    const plat = window.streamDock?.getPlatform?.();
    if (plat) setPlatform(plat);

    const unfocus = window.streamDock?.onWindowFocused?.(() => setIsFocused(true));
    const unblur = window.streamDock?.onWindowBlurred?.(() => setIsFocused(false));

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === '1') { e.preventDefault(); onTabChange('capture'); }
      if (e.key === '2') { e.preventDefault(); onTabChange('transfers'); }
      if (e.key === '3') { e.preventDefault(); onTabChange('settings'); }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      unfocus?.();
      unblur?.();
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onTabChange]);

  const isMac = platform === 'darwin';
  const copy = pageCopy[currentTab];

  return (
    <div
      className={`flex h-screen overflow-hidden bg-bg transition-[filter] duration-normal ${
        !isFocused ? 'brightness-[0.94] saturate-[0.85]' : ''
      }`}
    >
      {/* Icon rail */}
      <aside
        className="flex w-[var(--nav-rail-width)] shrink-0 flex-col items-center border-r border-border bg-surface-1 py-2"
        aria-label="Main navigation"
      >
        <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Download className="h-3.5 w-3.5" aria-hidden />
        </div>

        <nav className="flex flex-1 flex-col items-center gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.tab;
            const showBadge = item.tab === 'transfers' && activeCount > 0;

            return (
              <button
                key={item.tab}
                type="button"
                onClick={() => onTabChange(item.tab)}
                title={item.label}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
                className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                  isActive
                    ? 'bg-accent-muted text-accent'
                    : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {showBadge && (
                  <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white">
                    {activeCount > 9 ? '9+' : activeCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Titlebar */}
        <header
          className={`flex h-[var(--titlebar-height)] shrink-0 items-center justify-between border-b border-border bg-surface-1 ${
            isMac ? 'pl-[68px]' : 'pl-3'
          }`}
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        >
          <span className="text-xs font-medium text-text-secondary">StreamDock</span>

          {!isMac && (
            <div className="flex h-full" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
              <button
                type="button"
                onClick={() => window.streamDock?.minimizeWindow?.()}
                className="flex h-full w-10 items-center justify-center text-text-secondary transition-colors hover:bg-surface-2"
                aria-label="Minimize"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => window.streamDock?.maximizeRestoreWindow?.()}
                className="flex h-full w-10 items-center justify-center text-text-secondary transition-colors hover:bg-surface-2"
                aria-label="Maximize"
              >
                <Square className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => window.streamDock?.closeWindow?.()}
                className="flex h-full w-10 items-center justify-center text-text-secondary transition-colors hover:bg-error hover:text-white"
                aria-label="Close"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </header>

        {/* Page header */}
        <div className="shrink-0 border-b border-border-subtle bg-surface-0 px-4 py-3">
          <h1 className="page-title">{copy.title}</h1>
          <p className="page-desc">{copy.description}</p>
        </div>

        {/* Content */}
        <main className="min-h-0 flex-1 overflow-hidden bg-surface-0">
          {children}
        </main>
      </div>
    </div>
  );
}
