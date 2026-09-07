import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * In-window menu bar for the frameless titlebar.
 *
 * The app already defined a complete native File/Edit/View/Help menu, but the
 * window is created with `frame: false`, and on Windows and Linux that stops
 * the native menu bar from ever being drawn — the menu existed and was
 * completely invisible. Rather than re-declaring the menu in React (two
 * definitions to keep in sync) or reinstating the OS menu bar (which would
 * clash with the custom chrome), this renders only the top-level labels and
 * asks the main process to pop up the real submenus at the button's position.
 */
interface MenuBarProps {
  /**
   * macOS draws the real menu bar at the top of the screen, so an in-window
   * copy would be a duplicate rather than the only way in.
   */
  enabled?: boolean;
}

export function MenuBar({ enabled = true }: MenuBarProps) {
  const [labels, setLabels] = useState<string[]>([]);
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void window.streamDock?.getMenuLabels?.().then((next) => {
      if (!cancelled && Array.isArray(next)) setLabels(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  if (!enabled || labels.length === 0) return null;

  const openMenu = (label: string, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setOpenLabel(label);
    // Anchor to the button's bottom-left so the submenu reads as belonging to it.
    void window.streamDock
      ?.popupMenu?.(label, rect.left, rect.bottom)
      // popup() resolves once the menu closes, so this is also the "menu
      // dismissed" signal that clears the pressed highlight.
      .finally(() => setOpenLabel((current) => (current === label ? null : current)));
  };

  return (
    <div
      ref={barRef}
      className="flex h-full items-center"
      // Must opt out of the drag region or clicks are swallowed by the titlebar.
      style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
    >
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          onClick={(event) => openMenu(label, event.currentTarget)}
          className={`h-[22px] rounded px-2 text-xs transition-colors ${
            openLabel === label
              ? 'bg-surface-3 text-text-primary'
              : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
          }`}
          aria-haspopup="menu"
          aria-expanded={openLabel === label}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
