import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToastStore } from '@/stores';
import type { BackupSnapshot, SnapshotReason } from '../../../shared/types';

export function DataSection() {
  const [appDataDir, setAppDataDir] = useState<string>('');
  const showToast = useToastStore((state) => state.showToast);

  useEffect(() => {
    window.electron.getDataDir()
      .then((r) => setAppDataDir(r.appDataPath))
      .catch(() => setAppDataDir(''));
  }, []);

  const handleCopy = async () => {
    if (!appDataDir) return;
    try {
      await navigator.clipboard.writeText(appDataDir);
      showToast('Path copied to clipboard', 'success');
    } catch {
      showToast('Failed to copy path', 'error');
    }
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Label>Data Directory</Label>
        {/*
          This used to name eaves-data and claim it held everything. It
          doesn't: project workspaces, avatars, themes, and installed plugins
          are siblings of it, so anyone who followed the instruction and then
          reinstalled lost all four while the database still referenced them.
        */}
        <p className="text-sm text-muted-foreground">
          Back up this folder to preserve everything Eaves stores — the database
          (chats, agents, channels, notes), message attachments, project workspaces,
          avatars, themes, and installed plugins.
        </p>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono break-all">
          {appDataDir || 'Loading…'}
        </div>
        <p className="text-xs text-muted-foreground">
          The database itself is in <span className="font-mono">eaves-data/</span> inside it.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={async () => { await window.electron.openDataDir(); }}
            disabled={!appDataDir}
          >
            Open in File Manager
          </Button>
          <Button variant="outline" onClick={handleCopy} disabled={!appDataDir}>
            Copy Path
          </Button>
        </div>
      </div>

      <BackupsPanel />
    </div>
  );
}

function BackupsPanel() {
  const showToast = useToastStore((state) => state.showToast);
  const [snapshots, setSnapshots] = useState<BackupSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await window.electron.listBackups();
    if (result.success && result.snapshots) {
      setSnapshots(result.snapshots);
    } else if (result.error) {
      showToast(`Failed to load backups: ${result.error}`, 'error');
    }
    setLoading(false);
  }, [showToast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleCreate = async () => {
    setBusy('create');
    try {
      const result = await window.electron.createBackup();
      if (result.success) {
        showToast('Backup created', 'success');
        await refresh();
      } else {
        showToast(`Backup failed: ${result.error ?? 'unknown error'}`, 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (filename: string) => {
    if (!confirm(`Delete backup "${filename}"?\n\nThis cannot be undone.`)) return;
    setBusy(filename);
    try {
      const result = await window.electron.deleteBackup(filename);
      if (result.success) {
        showToast('Backup deleted', 'success');
        await refresh();
      } else {
        showToast(`Delete failed: ${result.error ?? 'unknown error'}`, 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  const handleRestore = async (filename: string) => {
    // Spell out the scope. A snapshot is the database only, so restoring an
    // older one rolls back rows while attachment and project files on disk
    // stay at today's state — leaving messages that reference attachments
    // added since the snapshot pointing at files whose rows are now gone.
    const ok = confirm(
      `Restore from "${filename}"?\n\n` +
      'This replaces your current database — chats, agents, channels, notes and tasks ' +
      'all revert to the state in this snapshot.\n\n' +
      'Files on disk are NOT rolled back: attachments, project workspaces, avatars, ' +
      'themes and installed plugins stay exactly as they are now. Anything added since ' +
      'this snapshot will still be on disk with no database row pointing at it.\n\n' +
      'A safety snapshot of your current state is taken first. Eaves restarts immediately after.'
    );
    if (!ok) return;
    setBusy(filename);
    try {
      const result = await window.electron.restoreBackup(filename);
      if (!result.success) {
        showToast(`Restore failed: ${result.error ?? 'unknown error'}`, 'error');
        setBusy(null);
      }
      // On success, the app relaunches before this completes.
    } catch (err) {
      showToast(`Restore failed: ${err instanceof Error ? err.message : 'unknown'}`, 'error');
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label>Database Backups</Label>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreate}
          disabled={busy !== null}
        >
          {busy === 'create' ? 'Backing up…' : 'Back Up Now'}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Eaves snapshots the database at startup and once a day. The 10 newest are kept; older ones are pruned automatically. Snapshots live in <span className="font-mono text-xs">eaves-data/backups/</span>.
      </p>
      <p className="text-sm text-muted-foreground">
        These cover the database only — not attachments, project workspaces, avatars, themes or plugins. Copy the folder above to back those up.
      </p>

      {loading ? (
        <div className="text-sm text-muted-foreground py-2">Loading backups…</div>
      ) : snapshots.length === 0 ? (
        <div className="text-sm text-muted-foreground py-2">
          No backups yet. One will appear shortly — or click <em>Back Up Now</em>.
        </div>
      ) : (
        <ul className="rounded-md border border-border divide-y divide-border">
          {snapshots.map((snap) => (
            <li key={snap.filename} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {formatTimestamp(snap.createdAt)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatReason(snap.reason)} · {formatBytes(snap.sizeBytes)}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleRestore(snap.filename)}
                  disabled={busy !== null}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(snap.filename)}
                  disabled={busy !== null}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatReason(reason: SnapshotReason): string {
  switch (reason) {
    case 'startup': return 'Startup';
    case 'periodic': return 'Daily';
    case 'manual': return 'Manual';
    case 'pre-restore': return 'Pre-restore safety snapshot';
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
