import { useEffect, useState, type CSSProperties } from 'react';
import { AppChrome } from './components/AppChrome';
import { TransferView } from './views/TransferView';
import { ErrorBanner } from './components/ErrorBanner';
import { VersionWarningBanner } from './components/VersionWarningBanner';
import { UpdateBanner } from './components/UpdateBanner';
import { SettingsView } from './views/SettingsView';
import { CaptureView } from './views/CaptureView';
import { OverlayBus } from './components/OverlayBus';
import type { CaptureMode, EngineStatus, Settings, Tab } from './lib/types';
import { downloadStore } from './store/DownloadStore';
import { useDownloadRecords, useActiveCount } from './store/useDownloadStore';
import { IDLE_UPDATE_STATE, type UpdateState } from '../../shared/update-state';

const fallbackSettings: Settings = {
  downloadDir: '',
};

export default function App() {
  const [currentTab, setCurrentTab] = useState<Tab>('capture');
  const [mode, setMode] = useState<CaptureMode>('video');
  const [settings, setSettings] = useState<Settings>(fallbackSettings);
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [versionWarning, setVersionWarning] = useState<string | null>(null);
  const [updatingEngine, setUpdatingEngine] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>(IDLE_UPDATE_STATE);
  /**
   * A URL pushed into the capture field from outside it (clipboard watcher,
   * Edit > Paste). Carries a sequence number so copying the *same* URL twice
   * still counts as a new delivery — plain string state would compare equal
   * and the second paste would do nothing.
   */
  const [incomingUrl, setIncomingUrl] = useState<{ url: string; seq: number } | null>(null);
  const deliverUrl = (url: string) =>
    setIncomingUrl((prev) => ({ url, seq: (prev?.seq ?? 0) + 1 }));

  const items = useDownloadRecords();
  const activeCount = useActiveCount();

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [loadedSettings, loadedEngines] = await Promise.all([
          window.streamDock?.getSettings(),
          window.streamDock?.getEngineStatus(),
        ]);
        if (!mounted) return;
        if (loadedSettings) setSettings(loadedSettings);
        if (loadedEngines) setEngines(loadedEngines);
        downloadStore.init();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribers = [
      window.streamDock?.onMenuFocusTab((tab) => {
        if (tab === 'capture' || tab === 'transfers' || tab === 'settings') {
          setCurrentTab(tab);
        }
      }),
      window.streamDock?.onMenuOpenDownloadFolder(() => {
        void chooseFolder();
      }),
      window.streamDock?.onMenuPasteClipboard(async () => {
        try {
          setCurrentTab('capture');
          const text = await window.streamDock?.readClipboard();
          if (!text) return;
          const firstUrl = text.split(/[\s\r\n]+/).find((t) => t.startsWith('http'));
          if (!firstUrl) return;
          deliverUrl(firstUrl);
        } catch {
          // silent
        }
      }),
      window.streamDock?.onClipboardUrl(({ url }) => {
        setCurrentTab('capture');
        deliverUrl(url);
        downloadStore.addToast(`URL captured from clipboard: ${url}`, 'success');
      }),
    ].filter(Boolean) as Array<() => void>;
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    const unsubscribe = window.streamDock?.onEngineVersionWarning?.((warning) => {
      setVersionWarning(warning);
    });
    return () => unsubscribe?.();
  }, []);

  /**
   * The application update flow.
   *
   * Subscribing happens before asking for the current state, so a phase
   * published in the gap between the two is not missed — the launch check fires
   * on its own eight seconds in and does not wait for this component.
   */
  useEffect(() => {
    const unsubscribe = window.streamDock?.onAppUpdateState?.(setUpdateState);
    void window.streamDock?.getUpdateState?.().then((current) => {
      if (current) setUpdateState(current);
    });
    return () => unsubscribe?.();
  }, []);

  const chooseFolder = async () => {
    const folder = await window.streamDock?.selectDownloadFolder();
    if (!folder) return;
    const next = await window.streamDock?.updateSettings({ downloadDir: folder });
    if (next) setSettings(next);
  };

  const refreshEngines = async () => {
    const status = await window.streamDock?.getEngineStatus();
    if (status) setEngines(status);
  };

  const handleEngineUpdate = async () => {
    if (!window.streamDock?.updateEngine) return;
    setUpdatingEngine(true);
    try {
      const res = await window.streamDock.updateEngine();
      if (res.success) {
        setVersionWarning(null);
        downloadStore.addToast(res.message || 'yt-dlp updated.', 'success');
        await refreshEngines();
      } else {
        setError(res.error || 'Engine update failed.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingEngine(false);
    }
  };

  const handleDensityChange = async (densityMode: 'comfortable' | 'compact') => {
    const next = await window.streamDock?.updateSettings({ densityMode });
    if (next) setSettings(next);
  };

  // Listen for background wallpaper rotations globally
  useEffect(() => {
    if (window.streamDock?.onWallpaperUpdated) {
      return window.streamDock.onWallpaperUpdated((url) => {
        void window.streamDock?.updateSettings({ backgroundImageUrl: url }).then((next) => {
          if (next) setSettings(next);
        });
      });
    }
  }, []);

  const scrollableTab = currentTab !== 'transfers';

  // Pass the image URL through the CSS variable so tokens.css
  // [data-bg-mode="bing"] can pick it up via var(--bg-bing-image, none).
  // Do NOT set backgroundImage inline — that would bypass the CSS
  // variable system and break the gradient mode too.
  const bgStyle = {
    '--bg-bing-image': settings.backgroundImageUrl ? `url("${settings.backgroundImageUrl}")` : 'none',
    '--bg-solid-color': settings.solidColorBg || undefined,
  } as CSSProperties;

  const bgMode = settings.backgroundMode ?? 'gradient';
  // Only meaningful in 'theme' mode; leaving it off otherwise keeps a stale
  // stored theme id from styling a background the user has since switched away
  // from, since the theme rules key on the attribute alone.
  const bgTheme = bgMode === 'theme' ? settings.backgroundTheme : undefined;

  return (
    <div data-bg-mode={bgMode} data-bg-theme={bgTheme} className="contents">
      <OverlayBus />
      <div className="app-background" data-bg-mode={bgMode} data-bg-theme={bgTheme} style={bgStyle} />
      <AppChrome currentTab={currentTab} activeCount={activeCount} onTabChange={setCurrentTab}>
        <div
          className={`flex h-full min-h-0 flex-col px-4 py-4 ${
            scrollableTab ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'
          }`}
        >
          <div className={`page-shell ${currentTab === 'transfers' ? 'min-h-0 flex-1' : ''}`}>
            <UpdateBanner
              state={updateState}
              onCheck={() => void window.streamDock?.checkForAppUpdate?.()}
              onDownload={() => void window.streamDock?.downloadAppUpdate?.()}
              onInstall={() => void window.streamDock?.installAppUpdate?.()}
              onDismiss={() => void window.streamDock?.dismissAppUpdate?.()}
            />
            {versionWarning && (
              <VersionWarningBanner
                message={versionWarning}
                onDismiss={() => setVersionWarning(null)}
                onUpdate={() => void handleEngineUpdate()}
                updating={updatingEngine}
              />
            )}
            <ErrorBanner message={error} onDismiss={() => setError(null)} />

            {currentTab === 'capture' && (
              <CaptureView
                mode={mode}
                setMode={setMode}
                outputDir={settings.downloadDir}
                incomingUrl={incomingUrl}
                defaultSubtitleMode={settings.ytdlpOptions?.subtitleMode ?? 'embed'}
                onError={setError}
                onStarted={(info) => {
                  setError(null);
                  void refreshEngines();
                  const text = info.itemCount
                    ? `${info.title} — ${info.itemCount} items queued`
                    : `${info.title} — added to queue`;
                  downloadStore.addToast(text, 'success');
                }}
              />
            )}

            {currentTab === 'transfers' && (
              <TransferView
                items={items}
                density={settings.densityMode ?? 'comfortable'}
                onDensityChange={(mode) => void handleDensityChange(mode)}
                onCancel={(id) => void downloadStore.cancelDownload(id)}
                onPause={(id) => void window.streamDock?.pauseDownload(id)}
                onResume={(id) => void window.streamDock?.resumeDownload(id)}
                onRetry={(id) => void window.streamDock?.retryDownload(id)}
                onOpenFile={(path) => void window.streamDock?.openFile(path)}
                onShowFolder={(path) => void window.streamDock?.showInFolder(path)}
                onClearAll={() => void downloadStore.clearRecords('all')}
                onClearCompleted={() => void downloadStore.clearRecords('completed')}
                onClearFailed={() => void downloadStore.clearRecords('failed')}
                onRemoveItem={(id) => void downloadStore.removeRecord(id)}
                onPauseAll={() => void window.streamDock?.stopAll('pause')}
                onResumeAll={() => void window.streamDock?.resumeAll()}
              />
            )}

            {currentTab === 'settings' && (
              <SettingsView
                settings={settings}
                engines={engines}
                onChooseFolder={chooseFolder}
                onSettingsChange={setSettings}
                onEngineRefresh={refreshEngines}
              />
            )}
          </div>
        </div>
      </AppChrome>
    </div>
  );
}
