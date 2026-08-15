import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSettingsStore } from '@/stores';
import type { UpdateMode } from '@/types';

interface UpdaterState {
  status: string;
  info?: { version?: string };
  progress?: { percent?: number };
  error?: string;
}

const MODE_OPTIONS: { value: UpdateMode; label: string; description: string }[] = [
  {
    value: 'auto',
    label: 'Automatic',
    description: 'Check every few hours and show a banner when a new version is available.',
  },
  {
    value: 'manual',
    label: 'Manual only',
    description: 'Never check in the background. Use the button below when you want to check.',
  },
  {
    value: 'external',
    label: 'Managed externally',
    description: 'Disable the in-app updater. For users who install Eaves via a system package manager (AUR, Homebrew, apt).',
  },
];

const STATUS_MESSAGES: Record<string, string> = {
  idle: '',
  checking: 'Checking for updates…',
  'update-not-available': 'You\u2019re on the latest version.',
  'not-available': 'You\u2019re on the latest version.',
  available: 'A newer version is available.',
  downloading: 'Downloading update…',
  downloaded: 'Update downloaded — restart to install.',
  error: 'Something went wrong while checking for updates.',
};

export function UpdatesSection() {
  const [version, setVersion] = useState<string>('…');
  const [state, setState] = useState<UpdaterState | null>(null);
  const updateMode = useSettingsStore((s) => s.settings.updateMode ?? 'auto');
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  useEffect(() => {
    window.electron.getAppVersion()
      .then((r) => setVersion(r.version))
      .catch(() => setVersion('unknown'));

    window.electron.updaterGetState().then(setState).catch(() => {});
    const cleanup = window.electron.onUpdaterState(setState);
    return cleanup;
  }, []);

  const handleModeChange = useCallback(async (next: UpdateMode) => {
    await updateSettings({ updateMode: next });
  }, [updateSettings]);

  const handleCheck = useCallback(async () => {
    try {
      const result = await window.electron.updaterCheck();
      setState(result);
    } catch (err: unknown) {
      setState({ status: 'error', error: err instanceof Error ? err.message : 'Check failed' });
    }
  }, []);

  const handleDownload = useCallback(() => {
    window.electron.updaterDownload();
  }, []);

  const handleRestart = useCallback(() => {
    window.electron.updaterQuitAndInstall();
  }, []);

  const status = state?.status || 'idle';
  const statusText = STATUS_MESSAGES[status] ?? status;
  const isChecking = status === 'checking';
  const isDownloading = status === 'downloading';
  const available = status === 'available';
  const downloaded = status === 'downloaded';
  const errored = status === 'error';
  const external = updateMode === 'external';
  // Hide the Check button when an update is already pending — the Download /
  // Restart CTA is the only useful action at that point.
  const showCheckButton = !external && !available && !downloaded;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label>Current Version</Label>
        <p className="text-sm">
          <span className="font-mono">{version}</span>
        </p>
      </div>

      <div className="space-y-3 pt-4 border-t border-border">
        <Label>Update checks</Label>
        <div className="space-y-2">
          {MODE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-start gap-3 cursor-pointer rounded-md p-2 -mx-2 hover:bg-muted/40 transition-colors"
            >
              <input
                type="radio"
                name="update-mode"
                value={opt.value}
                checked={updateMode === opt.value}
                onChange={() => handleModeChange(opt.value)}
                className="mt-1 h-4 w-4"
              />
              <div className="flex-1">
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs text-muted-foreground">{opt.description}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3 pt-4 border-t border-border">
        <Label>Status</Label>

        {external ? (
          <div
            className="text-sm rounded-md p-3 border"
            style={{
              borderColor: 'var(--border-primary, #333)',
              background: 'var(--bg-tertiary, rgba(0,0,0,0.04))',
            }}
          >
            <p>Updates are managed by your system package manager. Use it to upgrade Eaves.</p>
          </div>
        ) : (
          <>
            {(statusText || errored) && (
              <div
                className="text-sm rounded-md p-3 border"
                style={{
                  borderColor: errored ? 'rgb(220, 38, 38)' : 'var(--border-primary, #333)',
                  background: errored ? 'rgba(220, 38, 38, 0.08)' : 'var(--bg-tertiary, rgba(0,0,0,0.04))',
                  color: errored ? 'rgb(220, 38, 38)' : undefined,
                }}
              >
                <p>
                  {available && state?.info?.version
                    ? `Version ${state.info.version} is available.`
                    : statusText}
                </p>
                {isDownloading && (
                  <div className="mt-2 w-full h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.round(state?.progress?.percent ?? 0)}%`,
                        background: 'var(--accent-primary, #667eea)',
                      }}
                    />
                  </div>
                )}
                {errored && state?.error && (
                  <p className="mt-1 text-xs font-mono opacity-80">{state.error}</p>
                )}
              </div>
            )}

            <div className="flex gap-2">
              {showCheckButton && (
                <Button variant="outline" onClick={handleCheck} disabled={isChecking || isDownloading}>
                  {isChecking ? 'Checking…' : 'Check for Updates'}
                </Button>
              )}
              {available && (
                <Button onClick={handleDownload}>Download</Button>
              )}
              {downloaded && (
                <Button onClick={handleRestart}>Restart &amp; Install</Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
