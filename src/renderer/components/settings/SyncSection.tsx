import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useToastStore } from '@/stores';
import type { SyncStateSnapshot } from '../../../shared/ipc-types';

/**
 * Settings → Sync. LAN-only P2P sync between this user's own devices:
 * enable toggle, device name, pairing flow (6-digit code confirmed on both
 * screens), paired-device list, and nearby unpaired devices.
 */
export function SyncSection() {
  const showToast = useToastStore((state) => state.showToast);
  const [state, setState] = useState<SyncStateSnapshot | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const result = await window.electron.syncGetState();
    if (result.success && result.state) setState(result.state);
  }, []);

  useEffect(() => {
    refresh();
    // Main pushes a fresh snapshot on every state change.
    const offState = window.electron.on('sync:state', (snapshot) => {
      setState(snapshot as SyncStateSnapshot);
    });
    const offMismatch = window.electron.on('sync:schema-mismatch', (data) => {
      const d = data as { peerName: string; ours: number; theirs: number };
      showToast(
        `Can't sync with ${d.peerName}: it runs a ${d.theirs > d.ours ? 'newer' : 'older'} database version. Update ${d.theirs > d.ours ? 'this device' : 'it'} first.`,
        'error',
      );
    });
    return () => {
      offState();
      offMismatch();
    };
  }, [refresh, showToast]);

  const handleToggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      const result = await window.electron.syncSetEnabled(enabled);
      if (!result.success) {
        showToast(`Failed to ${enabled ? 'enable' : 'disable'} sync: ${result.error ?? 'unknown error'}`, 'error');
      } else if (result.state) {
        setState(result.state);
      }
    } finally {
      setBusy(false);
    }
  };

  const commitName = async () => {
    if (nameDraft === null || !state || nameDraft.trim() === state.deviceName) {
      setNameDraft(null);
      return;
    }
    const result = await window.electron.syncSetDeviceName(nameDraft.trim());
    if (!result.success) {
      showToast(`Rename failed: ${result.error ?? 'unknown error'}`, 'error');
    }
    setNameDraft(null);
  };

  if (!state) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <Label>Sync between your devices</Label>
          <p className="text-sm text-muted-foreground">
            Keeps agents, chats, channels, and notes in sync with your other computers on the
            same network. Everything is end-to-end encrypted and flows directly between your
            devices — no servers, no cloud.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            id="sync-enabled"
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => handleToggle(e.target.checked)}
            disabled={busy}
            className="h-4 w-4"
          />
          <Label htmlFor="sync-enabled" className="cursor-pointer">
            Enable LAN sync
          </Label>
        </div>
      </section>

      {state.enabled && (
        <>
          <div className="space-y-2">
            <Label htmlFor="sync-device-name">This device's name</Label>
            <p className="text-sm text-muted-foreground">
              How this computer appears to your other devices.
            </p>
            <Input
              id="sync-device-name"
              value={nameDraft ?? state.deviceName}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              maxLength={64}
              className="max-w-sm"
            />
          </div>

          {state.pendingPair ? (
            <PairConfirmCard state={state} />
          ) : (
            <PairingPanel state={state} showToast={showToast} />
          )}

          <PairedDevices state={state} showToast={showToast} />
        </>
      )}
    </div>
  );
}

function PairConfirmCard({ state }: { state: SyncStateSnapshot }) {
  const pending = state.pendingPair!;
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <Label>Pairing with “{pending.deviceName}”</Label>
      <p className="text-sm text-muted-foreground">
        Check that this code matches the one shown on the other device, then confirm on both.
      </p>
      <div className="text-3xl font-mono tracking-[0.4em] text-center py-2 select-all">
        {pending.code}
      </div>
      <div className="flex gap-2 justify-center">
        <Button
          onClick={() => window.electron.syncConfirmPair()}
          disabled={pending.localConfirmed}
        >
          {pending.localConfirmed ? 'Waiting for the other device…' : 'The codes match'}
        </Button>
        <Button variant="outline" onClick={() => window.electron.syncRejectPair()}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function PairingPanel({
  state,
  showToast,
}: {
  state: SyncStateSnapshot;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}) {
  const [connecting, setConnecting] = useState<string | null>(null);
  const pairedIds = new Set(state.peers.map(p => p.deviceId));
  const unpaired = state.discovered.filter(d => !pairedIds.has(d.deviceId));

  const handlePair = async (host: string, port: number, key: string) => {
    setConnecting(key);
    try {
      const result = await window.electron.syncConnect(host, port);
      if (!result.success) {
        showToast(`Couldn't reach the device: ${result.error ?? 'unknown error'}`, 'error');
      }
    } finally {
      setConnecting(null);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <Label>Pair a new device</Label>
        <p className="text-sm text-muted-foreground">
          Turn this on, then click “Pair” from the other device — or pair with one of the
          devices listed below. Both screens will show a code to confirm.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <input
          id="sync-pairing-mode"
          type="checkbox"
          checked={state.pairingMode}
          onChange={(e) => window.electron.syncSetPairingMode(e.target.checked)}
          className="h-4 w-4"
        />
        <Label htmlFor="sync-pairing-mode" className="cursor-pointer">
          Accept pairing requests
        </Label>
      </div>

      {unpaired.length > 0 && (
        <ul className="space-y-2">
          {unpaired.map((device) => (
            <li
              key={device.deviceId}
              className="flex items-center justify-between rounded-md border border-border px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{device.deviceName}</div>
                <div className="text-xs text-muted-foreground font-mono">
                  {device.host}:{device.port}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={connecting === device.deviceId}
                onClick={() => handlePair(device.host, device.port, device.deviceId)}
              >
                {connecting === device.deviceId ? 'Connecting…' : 'Pair'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {unpaired.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No unpaired Enclave devices found on this network yet. Make sure sync is enabled on
          the other device too.
        </p>
      )}
    </div>
  );
}

function PairedDevices({
  state,
  showToast,
}: {
  state: SyncStateSnapshot;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}) {
  if (state.peers.length === 0) return null;

  const handleUnpair = async (deviceId: string, name: string) => {
    if (!confirm(`Unpair "${name}"?\n\nExisting data stays on both devices; they just stop syncing.`)) return;
    const result = await window.electron.syncUnpair(deviceId);
    if (!result.success) {
      showToast(`Unpair failed: ${result.error ?? 'unknown error'}`, 'error');
    }
  };

  return (
    <div className="space-y-2">
      <Label>Paired devices</Label>
      <ul className="space-y-2">
        {state.peers.map((peer) => (
          <li
            key={peer.deviceId}
            className="flex items-center justify-between rounded-md border border-border px-3 py-2"
          >
            <div>
              <div className="text-sm font-medium flex items-center gap-2">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${peer.online ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                  title={peer.online ? 'Connected' : 'Offline'}
                />
                {peer.deviceName}
              </div>
              <div className="text-xs text-muted-foreground">
                {peer.online
                  ? 'Connected — syncing live'
                  : peer.lastSeenAt
                    ? `Last synced ${new Date(peer.lastSeenAt).toLocaleString()}`
                    : 'Never synced'}
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleUnpair(peer.deviceId, peer.deviceName)}
            >
              Unpair
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
