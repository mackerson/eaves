import { useState, useEffect, useCallback } from 'react';
import { Download, RefreshCw, X, ArrowDownToLine, AlertTriangle } from 'lucide-react';
import { useSettingsStore } from '@/stores';

interface UpdaterState {
  status: string;
  info?: { version?: string };
  progress?: { percent?: number };
  error?: string;
}

export function UpdateBanner() {
  const [state, setState] = useState<UpdaterState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const updateMode = useSettingsStore((s) => s.settings.updateMode ?? 'auto');

  useEffect(() => {
    // Get current state on mount
    window.electron.updaterGetState().then(setState);

    // Listen for state changes
    const cleanup = window.electron.onUpdaterState((s: UpdaterState) => {
      setState(s);
      // Re-show banner when a new version becomes available
      if (s.status === 'available') setDismissed(false);
      // A download that got going supersedes a stale failure from an earlier try.
      if (s.status === 'downloading' || s.status === 'downloaded') setLocalError(null);
    });

    return cleanup;
  }, []);

  // The result is a `{success:false}` envelope on failure, and electron-updater
  // separately emits `error`, driving status:'error'. Both were dropped: the
  // banner unmounted, so clicking Download made it vanish with no indication
  // anything went wrong — which reads as "the update installed". A missing
  // artifact in the per-platform matrix (allowPrerelease is on) is a realistic
  // trigger. Keep whichever message we get and stay on screen.
  const handleDownload = useCallback(async () => {
    setLocalError(null);
    try {
      const result = await window.electron.updaterDownload();
      if (result && result.success === false) {
        setLocalError(result.error || 'Download failed');
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Download failed');
    }
  }, []);

  const handleRestart = useCallback(() => {
    window.electron.updaterQuitAndInstall();
  }, []);

  // Only show for actionable states
  if (!state || dismissed) return null;
  const errorMessage = localError ?? (state.status === 'error' ? (state.error || 'Update failed') : null);
  if (!errorMessage && !['available', 'downloading', 'downloaded'].includes(state.status)) return null;
  // External mode: system package manager owns updates — never nag.
  if (updateMode === 'external') return null;

  const version = state.info?.version;

  return (
    <div className="fixed bottom-4 right-4 pointer-events-auto animate-in slide-in-from-bottom duration-300" style={{ zIndex: 9998 }}>
      <div
        className={`flex items-center gap-3 px-4 py-3 rounded-lg border bg-card shadow-lg ${
          errorMessage ? 'border-red-500/40 bg-red-500/10' : 'border-blue-500/30 bg-blue-500/10'
        }`}
        style={{ minWidth: '300px', maxWidth: '420px' }}
      >

        {errorMessage && (
          <>
            <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0" />
            <div className="flex-1 text-sm text-foreground">
              <div className="font-medium">Update failed</div>
              <div className="text-xs text-muted-foreground break-words">{errorMessage}</div>
            </div>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-red-500 text-white hover:bg-red-600 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Retry
            </button>
          </>
        )}

        {!errorMessage && state.status === 'available' && (
          <>
            <ArrowDownToLine className="h-5 w-5 text-blue-500 flex-shrink-0" />
            <div className="flex-1 text-sm text-foreground">
              <span className="font-medium">Eaves {version}</span> is available
            </div>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
          </>
        )}

        {!errorMessage && state.status === 'downloading' && (
          <>
            <Download className="h-5 w-5 text-blue-500 flex-shrink-0 animate-pulse" />
            <div className="flex-1">
              <div className="text-sm text-foreground mb-1">Downloading update...</div>
              <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(state.progress?.percent ?? 0)}%` }}
                />
              </div>
            </div>
          </>
        )}

        {!errorMessage && state.status === 'downloaded' && (
          <>
            <RefreshCw className="h-5 w-5 text-green-500 flex-shrink-0" />
            <div className="flex-1 text-sm text-foreground">
              Update ready
            </div>
            <button
              onClick={handleRestart}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-green-500 text-white hover:bg-green-600 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Restart Now
            </button>
          </>
        )}

        {(errorMessage || state.status !== 'downloading') && (
          <button
            onClick={() => setDismissed(true)}
            className="flex-shrink-0 text-muted-foreground hover:text-foreground transition-colors ml-1"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
