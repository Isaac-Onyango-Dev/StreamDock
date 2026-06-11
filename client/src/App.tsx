import { useEffect, useState } from 'react';
import { AppChrome } from './components/AppChrome';
import { TransferView } from './views/TransferView';
import { ErrorBanner } from './components/ErrorBanner';
import { VersionWarningBanner } from './components/VersionWarningBanner';
import { SettingsView } from './views/SettingsView';
import { CaptureView } from './views/CaptureView';
import { OverlayBus } from './components/OverlayBus';
import type { CaptureMode, EngineStatus, Settings, Tab } from './lib/types';
import { downloadStore } from './store/DownloadStore';
import { useDownloadRecords, useActiveCount } from './store/useDownloadStore';

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
          const urlInput = document.querySelector<HTMLInputElement>('input[name="capture-url"]');
          if (urlInput) {
            urlInput.value = firstUrl;
            urlInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } catch {
          // silent
        }
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

  const scrollableTab = currentTab !== 'transfers';

  return (
    <>
      <OverlayBus />
      <AppChrome currentTab={currentTab} activeCount={activeCount} onTabChange={setCurrentTab}>
        <div
          className={`flex h-full min-h-0 flex-col px-4 py-4 ${
            scrollableTab ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'
          }`}
        >
          <div className={`page-shell ${currentTab === 'transfers' ? 'min-h-0 flex-1' : ''}`}>
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
    </>
  );
}
