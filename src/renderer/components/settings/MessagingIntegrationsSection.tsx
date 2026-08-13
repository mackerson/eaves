import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface BridgeStatus {
  platform: string;
  running: boolean;
  sessionCount: number;
  botUsername?: string;
  connectedAt?: number;
  lastInboundAt?: number;
  lastError?: { message: string; at: number };
}

/** Compact duration for the "up 2h 14m" line. */
function formatUptime(since: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface BridgeSession {
  platform: string;
  externalUserId: string;
  currentChatId: string | null;
  currentAgentId: string | null;
  lastActiveAt: number;
}

interface PlatformMeta {
  platform: string;
  label: string;
  description: string;
  tokenLabel: string;
  tokenPlaceholder: string;
  tokenHelp: string;
  userIdsPlaceholder: string;
  userIdsHelp: string;
  commandsHelp?: string;
}

// Add a new bridge by appending an entry here (and shipping its adapter
// in src/main/services/messaging/adapters/). The form is adapter-agnostic;
// all bridges share the token + allowed-user-IDs + autoStart shape today.
const PLATFORMS: PlatformMeta[] = [
  {
    platform: 'telegram',
    label: 'Telegram',
    description: 'Access Enclave conversations remotely via a Telegram bot.',
    tokenLabel: 'Bot Token',
    tokenPlaceholder: 'Paste token from @BotFather',
    tokenHelp: 'Create a bot at @BotFather on Telegram to get a token.',
    userIdsPlaceholder: '123456789, 987654321',
    userIdsHelp: 'Comma-separated Telegram user IDs. Use @userinfobot to find yours.',
    commandsHelp: '/chats, /search <q>, /switch <id|name>, /agents, /agent <id|name>, /new [agent] [name], /status, /stop, /help',
  },
];

export function MessagingIntegrationsSection() {
  const [bridges, setBridges] = useState<BridgeStatus[]>([]);

  const loadBridges = useCallback(async () => {
    try {
      const result = await window.electron.getMessagingBridges();
      if (result?.success && result.bridges) {
        setBridges(result.bridges);
      }
    } catch (err) {
      console.error('Failed to load bridges:', err);
    }
  }, []);

  useEffect(() => {
    loadBridges();
    const interval = setInterval(loadBridges, 5000);
    return () => clearInterval(interval);
  }, [loadBridges]);

  // Only render platforms whose adapter is registered in main.
  const registered = PLATFORMS.filter(p => bridges.some(b => b.platform === p.platform));

  if (registered.length === 0) return null;

  return (
    <div className="pt-6 border-t border-border">
      <h3 className="text-xl font-semibold mb-1">Messaging Integrations</h3>
      <p className="text-sm text-muted-foreground mb-4">
        Access Enclave conversations from outside the app.
      </p>
      <div className="space-y-6">
        {registered.map(meta => (
          <BridgeCard
            key={meta.platform}
            meta={meta}
            status={bridges.find(b => b.platform === meta.platform) ?? null}
            onStatusChange={loadBridges}
          />
        ))}
      </div>
    </div>
  );
}

interface BridgeCardProps {
  meta: PlatformMeta;
  status: BridgeStatus | null;
  onStatusChange: () => void;
}

function BridgeCard({ meta, status, onStatusChange }: BridgeCardProps) {
  const [token, setToken] = useState('');
  const [userIds, setUserIds] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [hasConfig, setHasConfig] = useState(false);
  const [sessions, setSessions] = useState<BridgeSession[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const result = await window.electron.getMessagingBridgeConfig(meta.platform);
      if (result?.success) {
        setHasConfig(result.hasConfig || false);
        if (result.hasConfig) {
          setUserIds((result.allowedUserIds || []).join(', '));
          setAutoStart(result.autoStart || false);
          setToken('');
        }
      }
    } catch (err) {
      console.error(`[${meta.platform}] failed to load config:`, err);
    }
  }, [meta.platform]);

  const loadSessions = useCallback(async () => {
    try {
      const result = await window.electron.getMessagingBridgeSessions(meta.platform);
      if (result?.success && result.sessions) setSessions(result.sessions);
    } catch (err) {
      console.error(`[${meta.platform}] failed to load sessions:`, err);
    }
  }, [meta.platform]);

  useEffect(() => {
    loadConfig();
    loadSessions();
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadConfig, loadSessions]);

  const handleSave = async () => {
    const trimmedToken = token.trim();
    if (!trimmedToken && !hasConfig) {
      setMessage({ kind: 'err', text: 'Token is required.' });
      return;
    }
    const ids = userIds.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      setMessage({ kind: 'err', text: 'At least one authorized user ID is required.' });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const result = await window.electron.setMessagingBridgeConfig({
        platform: meta.platform,
        allowedUserIds: ids,
        autoStart,
        token: trimmedToken,
        keepExistingToken: !trimmedToken && hasConfig,
      });
      if (result?.success) {
        setMessage({ kind: 'ok', text: 'Configuration saved.' });
        setHasConfig(true);
        setToken('');
        loadConfig();
      } else {
        setMessage({ kind: 'err', text: result?.error || 'Failed to save' });
      }
    } catch (err: unknown) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    setMessage(null);
    try {
      // The IPC call resolves successfully even when the adapter fails to
      // start (e.g. bad token, unreachable API) — check result.success so a
      // silent failure doesn't leave the button looking unresponsive.
      const result = status?.running
        ? await window.electron.stopMessagingBridge(meta.platform)
        : await window.electron.startMessagingBridge(meta.platform);
      if (!result?.success) {
        setMessage({ kind: 'err', text: result?.error || 'Toggle failed' });
        return;
      }
      setTimeout(onStatusChange, 500);
    } catch (err: unknown) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Toggle failed' });
    }
  };

  const handleTest = async () => {
    setMessage(null);
    setTesting(true);
    try {
      const result = await window.electron.testMessagingBridgeConnection(meta.platform);
      if (result?.ok) {
        setMessage({
          kind: 'ok',
          text: result.botUsername
            ? `Connection OK — authenticated as @${result.botUsername}.`
            : 'Connection OK.',
        });
      } else {
        setMessage({ kind: 'err', text: result?.error || 'Connection test failed.' });
      }
      onStatusChange();
    } catch (err: unknown) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Connection test failed' });
    } finally {
      setTesting(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${meta.label} configuration?`)) return;
    setMessage(null);
    try {
      await window.electron.deleteMessagingBridgeConfig(meta.platform);
      setHasConfig(false);
      setToken('');
      setUserIds('');
      setAutoStart(false);
      setMessage({ kind: 'ok', text: 'Configuration deleted.' });
      onStatusChange();
    } catch (err: unknown) {
      setMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Delete failed' });
    }
  };

  const running = !!status?.running;

  // Parent re-polls every 5s, so the uptime figure stays live without a timer.
  const health = [
    running && status?.botUsername ? `@${status.botUsername}` : null,
    running && status?.connectedAt ? `up ${formatUptime(status.connectedAt)}` : null,
    status?.sessionCount
      ? `${status.sessionCount} session${status.sessionCount === 1 ? '' : 's'}`
      : null,
    status?.lastInboundAt ? `last inbound ${formatTime(status.lastInboundAt)}` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="rounded-lg border border-border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-base font-semibold">{meta.label}</h4>
          <p className="text-xs text-muted-foreground">{meta.description}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: running ? '#22c55e' : 'var(--text-tertiary, #6b7280)' }}
            />
            <span>{running ? 'Connected' : 'Disconnected'}</span>
          </div>
          {hasConfig && (
            <Button
              size="sm"
              variant={running ? 'destructive' : 'default'}
              onClick={handleToggle}
            >
              {running ? 'Stop' : 'Start'}
            </Button>
          )}
        </div>
      </div>

      {hasConfig && (health.length > 0 || status?.lastError) && (
        <div className="space-y-1 text-xs">
          {health.length > 0 && (
            <p className="text-muted-foreground">{health.join(' · ')}</p>
          )}
          {/* Held in main-process health, not local state, so the reason a
              bridge is down survives closing and reopening this panel. */}
          {status?.lastError && (
            <p className="flex items-start gap-1.5" style={{ color: '#f59e0b' }}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
              <span>
                <span className="opacity-70">{formatTime(status.lastError.at)}</span>{' '}
                {status.lastError.message}
              </span>
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor={`${meta.platform}-token`} className="text-xs">
            {meta.tokenLabel}
            {hasConfig && <span className="ml-2 opacity-60">(leave blank to keep current)</span>}
          </Label>
          <Input
            id={`${meta.platform}-token`}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasConfig ? 'Configured (hidden)' : meta.tokenPlaceholder}
          />
          <p className="text-xs text-muted-foreground">{meta.tokenHelp}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`${meta.platform}-users`} className="text-xs">Authorized User IDs</Label>
          <Input
            id={`${meta.platform}-users`}
            value={userIds}
            onChange={(e) => setUserIds(e.target.value)}
            placeholder={meta.userIdsPlaceholder}
          />
          <p className="text-xs text-muted-foreground">{meta.userIdsHelp}</p>
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => setAutoStart(e.target.checked)}
            className="h-4 w-4"
          />
          <span>Auto-start when Enclave launches</span>
        </label>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? 'Saving...' : 'Save'}
          </Button>
          {hasConfig && (
            <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
              {testing ? 'Testing...' : 'Test connection'}
            </Button>
          )}
          {hasConfig && (
            <Button variant="ghost" size="sm" onClick={handleDelete}>
              Delete
            </Button>
          )}
        </div>

        {message && (
          <p
            className="text-xs"
            style={{ color: message.kind === 'err' ? '#ef4444' : '#22c55e' }}
          >
            {message.text}
          </p>
        )}
      </div>

      {sessions.length > 0 && (
        <div className="pt-3 border-t border-border">
          <p className="text-xs font-semibold mb-2">
            Active Sessions ({sessions.length})
          </p>
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.externalUserId} className="text-xs rounded px-2 py-1 bg-muted/30">
                <div className="font-medium">User {s.externalUserId}</div>
                <div className="text-muted-foreground">
                  Chat: {s.currentChatId || '—'} · Agent: {s.currentAgentId || '—'}
                </div>
                <div className="text-muted-foreground opacity-70">
                  {new Date(s.lastActiveAt).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {meta.commandsHelp && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Commands</summary>
          <p className="font-mono pt-2 leading-6">{meta.commandsHelp}</p>
        </details>
      )}
    </div>
  );
}
