import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { useToastStore } from '@/stores';
import { permissionLabel, ELEVATED_PERMISSIONS } from '@/../shared/pluginPermissions';
import { compareVersions } from '@/../shared/version';
import { revokeTrustedPlugin } from '@/lib/pluginTrust';
import { AlertTriangle, Check, CloudOff, RefreshCw, Search } from 'lucide-react';

/**
 * Marketplace — browse/search the curated plugin registry and install from it.
 *
 * First-party on purpose. Everything trust-relevant stays in the main process
 * (registry fetch, pre-install consent window, sha256 verify, unpack, load) —
 * this panel only renders the listing and passes a registry id back over IPC.
 * It never sees or supplies a URL, so install stays confined to curated
 * registry entries (see MarketplaceService and the marketplace RFC).
 */

type RegistryListing = Awaited<ReturnType<typeof window.electron.getPluginRegistry>>;
type RegistryPlugin = RegistryListing['plugins'][number];
type RegistryStatus = RegistryListing['status'];

interface MarketplacePanelProps {
  /** Fired after an install or uninstall changes what's on disk. */
  onInstalledChange?: () => void;
}

export function MarketplacePanel({ onInstalledChange }: MarketplacePanelProps) {
  const [plugins, setPlugins] = useState<RegistryPlugin[]>([]);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<RegistryStatus>({ source: 'none', updated: '', fetchedAt: null });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<RegistryPlugin | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<RegistryPlugin | null>(null);
  const showToast = useToastStore((state) => state.showToast);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const reg = await window.electron.getPluginRegistry(force);
      // ipcResult folds handler failures into { success: false } envelopes.
      if (reg && 'success' in reg && (reg as { success: boolean }).success === false) {
        throw new Error((reg as { error?: string }).error || 'registry request failed');
      }
      setPlugins(reg.plugins || []);
      setInstalled(reg.installed || {});
      setStatus(reg.status || { source: 'none', updated: '', fetchedAt: null });
    } catch {
      // The service already degrades to its disk cache / empty registry; an
      // IPC-level failure is rendered the same way an unreachable registry is.
      setPlugins([]);
      setInstalled({});
      setStatus({ source: 'none', updated: '', fetchedAt: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const install = useCallback(async (p: RegistryPlugin) => {
    setBusyId(p.id);
    try {
      const res = await window.electron.installPlugin(p.id);
      if (res.success) {
        showToast(`${p.name} installed`, 'success');
        await load();
        onInstalledChange?.();
      } else if (res.error && !/cancelled/i.test(res.error)) {
        showToast(`Install failed: ${res.error}`, 'error');
      }
    } catch (error) {
      showToast((error as Error)?.message || 'Install failed', 'error');
    } finally {
      setBusyId(null);
    }
  }, [load, onInstalledChange, showToast]);

  const uninstall = useCallback(async (p: RegistryPlugin) => {
    setBusyId(p.id);
    try {
      const res = await window.electron.uninstallPlugin(p.id);
      if (res.success) {
        // Trust is keyed by plugin id and would otherwise outlive the install,
        // silently re-trusting a later reinstall of the same id.
        revokeTrustedPlugin(p.id);
        showToast(`${p.name} uninstalled`, 'success');
        await load();
        onInstalledChange?.();
      } else {
        showToast(`Uninstall failed: ${res.error || 'unknown error'}`, 'error');
      }
    } catch (error) {
      showToast((error as Error)?.message || 'Uninstall failed', 'error');
    } finally {
      setBusyId(null);
    }
  }, [load, onInstalledChange, showToast]);

  const installState = useCallback((p: RegistryPlugin): 'absent' | 'installed' | 'update' => {
    const current = installed[p.id];
    if (!current) return 'absent';
    return compareVersions(current, p.latest) < 0 ? 'update' : 'installed';
  }, [installed]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter((p) =>
      [p.name, p.description, p.author, p.category ?? '', p.tier]
        .some((field) => field.toLowerCase().includes(q)),
    );
  }, [plugins, searchQuery]);

  const updatesAvailable = useMemo(
    () => plugins.filter((p) => installState(p) === 'update').length,
    [plugins, installState],
  );

  // ── Registry provenance banner ───────────────────────────────────────────
  // An empty registry and an unreachable one must not look the same: 'cache'
  // shows what we have and says how stale it is; 'none' is an explicit outage
  // state with a retry, never a silent "No plugins available".
  const statusBanner = status.source === 'cache' ? (
    <div className="mb-4 p-3 rounded-lg border border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-yellow-800 dark:text-yellow-200 min-w-0">
        <CloudOff className="w-4 h-4 shrink-0" />
        <span>
          Can't reach the plugin registry — showing the last copy
          {status.updated ? ` from ${status.updated}` : ''}. Installs may fail until you're back online.
        </span>
      </div>
      <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
        <RefreshCw className="w-4 h-4 mr-1" /> Retry
      </Button>
    </div>
  ) : null;

  // ── Detail view ──────────────────────────────────────────────────────────
  if (selected) {
    const p = selected;
    const busy = busyId === p.id;
    const state = installState(p);
    return (
      <div className="space-y-6 max-w-3xl">
        <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>← Back to Marketplace</Button>

        <div className="flex items-start gap-4">
          <PluginAvatar name={p.name} size={56} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h3 className="text-2xl font-semibold truncate">{p.name}</h3>
              <TierBadge tier={p.tier} />
              {p.category && <Badge variant="secondary">{p.category}</Badge>}
            </div>
            <p className="text-muted-foreground mb-2">{p.description}</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>by {p.author}</span><span>•</span>
              <span>v{p.latest}</span>
              {state !== 'absent' && (<><span>•</span><span>installed: v{installed[p.id]}</span></>)}
              {p.homepage && (<><span>•</span>
                <a href={p.homepage} target="_blank" rel="noreferrer" className="underline hover:text-foreground">Repository</a></>)}
            </div>
          </div>
          <InstallButton
            p={p} state={state} busy={busy}
            onInstall={() => install(p)}
          />
        </div>

        <Separator />

        <Card>
          <CardHeader><CardTitle className="text-base">Permissions</CardTitle></CardHeader>
          <CardContent>
            {p.permissions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No special access.</p>
            ) : (
              <ul className="space-y-1.5">
                {p.permissions.map((perm) => (
                  <li key={perm} className="flex items-center gap-2 text-sm">
                    {ELEVATED_PERMISSIONS.has(perm)
                      ? <AlertTriangle className="w-3.5 h-3.5 text-yellow-600 dark:text-yellow-400 shrink-0" />
                      : <Check className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                    <span>{permissionLabel(perm)}</span>
                    <code className="text-xs text-muted-foreground">{perm}</code>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-xs text-muted-foreground mt-4">
              You'll confirm these before anything downloads. Every plugin runs sandboxed,
              and the download is checksum-verified against the curated registry.
            </p>
          </CardContent>
        </Card>

        {state !== 'absent' && (
          <Button
            variant="outline" size="sm" disabled={busy}
            className="text-destructive hover:text-destructive"
            onClick={() => setUninstallTarget(p)}
          >
            Uninstall
          </Button>
        )}

        {uninstallTarget && (
          <ConfirmDialog
            open={true}
            onOpenChange={(open) => { if (!open) setUninstallTarget(null); }}
            title={`Uninstall ${uninstallTarget.name}?`}
            message={`This removes ${uninstallTarget.name} from your computer, along with its stored data and the permissions you granted it. You can install it again from the Marketplace.`}
            confirmLabel="Uninstall"
            onConfirm={() => {
              const target = uninstallTarget;
              setUninstallTarget(null);
              uninstall(target);
            }}
          />
        )}
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="relative max-w-md flex-1 min-w-[220px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Search by name, description, or category…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {updatesAvailable > 0 && (
          <Badge variant="secondary">
            {updatesAvailable} update{updatesAvailable === 1 ? '' : 's'} available
          </Badge>
        )}
        <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading} title="Refresh the registry">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {statusBanner}

      {loading ? (
        <div className="text-center py-12 text-muted-foreground animate-pulse">Loading plugins…</div>
      ) : status.source === 'none' ? (
        <div className="text-center py-12 space-y-3">
          <CloudOff className="w-8 h-8 mx-auto text-muted-foreground" />
          <p className="text-muted-foreground">
            The plugin registry is unreachable and no cached copy exists yet.
          </p>
          <Button variant="outline" size="sm" onClick={() => load(true)}>
            <RefreshCw className="w-4 h-4 mr-1" /> Try again
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          {plugins.length === 0 ? 'No plugins available yet.' : 'No plugins match your search.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((p) => (
            <PluginCard
              key={p.id} p={p} state={installState(p)} busy={busyId === p.id}
              onView={() => setSelected(p)} onInstall={() => install(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PluginAvatar({ name, size }: { name: string; size: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-lg bg-muted text-foreground font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  return (
    <Badge variant={tier === 'official' ? 'default' : 'outline'} className="capitalize">
      {tier}
    </Badge>
  );
}

/** How many permission chips a card shows before folding into "+N more". */
const CARD_CHIP_LIMIT = 4;

function PermissionChips({ permissions }: { permissions: string[] }) {
  if (permissions.length === 0) {
    return <span className="text-xs text-muted-foreground">No special access</span>;
  }
  const shown = permissions.slice(0, CARD_CHIP_LIMIT);
  const extra = permissions.length - shown.length;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((perm) => (
        <span
          key={perm}
          title={perm}
          className={`text-[11px] px-1.5 py-0.5 rounded border ${
            ELEVATED_PERMISSIONS.has(perm)
              ? 'border-yellow-400 dark:border-yellow-600 text-yellow-700 dark:text-yellow-300 bg-yellow-50 dark:bg-yellow-900/20'
              : 'border-border text-muted-foreground bg-muted/50'
          }`}
        >
          {permissionLabel(perm)}
        </span>
      ))}
      {extra > 0 && (
        <span className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground bg-muted/50">
          +{extra} more
        </span>
      )}
    </div>
  );
}

function InstallButton({ p, state, busy, onInstall }: {
  p: RegistryPlugin;
  state: 'absent' | 'installed' | 'update';
  busy: boolean;
  onInstall: () => void;
}) {
  if (!p.release) {
    return <Button variant="outline" size="sm" disabled>Not yet available</Button>;
  }
  if (state === 'installed') {
    return (
      <Button variant="outline" size="sm" disabled>
        <span className="flex items-center gap-1.5">Installed <Check className="w-3.5 h-3.5" /></span>
      </Button>
    );
  }
  if (state === 'update') {
    // Same verified pipeline as install; consent re-prompts only if the
    // permission set changed, with new grants badged.
    return (
      <Button size="sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onInstall(); }}>
        {busy ? 'Updating…' : `Update to v${p.latest}`}
      </Button>
    );
  }
  return (
    <Button size="sm" disabled={busy} onClick={(e) => { e.stopPropagation(); onInstall(); }}>
      {busy ? 'Installing…' : 'Install'}
    </Button>
  );
}

function PluginCard({ p, state, busy, onView, onInstall }: {
  p: RegistryPlugin;
  state: 'absent' | 'installed' | 'update';
  busy: boolean;
  onView: () => void;
  onInstall: () => void;
}) {
  return (
    <Card className="flex flex-col hover:shadow-lg transition-shadow">
      <CardHeader className="cursor-pointer" onClick={onView}>
        <div className="flex items-start gap-3">
          <PluginAvatar name={p.name} size={40} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <CardTitle className="text-base truncate">{p.name}</CardTitle>
              <TierBadge tier={p.tier} />
              {state === 'update' && <Badge variant="secondary">Update available</Badge>}
            </div>
            <CardDescription className="line-clamp-2">{p.description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="mt-auto space-y-3">
        {/* The access a plugin asks for is part of the browse decision, not a
            surprise at consent time — chips are visible before any install. */}
        <PermissionChips permissions={p.permissions} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <span className="truncate">by {p.author}</span><span>•</span><span>v{p.latest}</span>
            {p.category && (<><span>•</span><span>{p.category}</span></>)}
          </div>
          <InstallButton p={p} state={state} busy={busy} onInstall={onInstall} />
        </div>
      </CardContent>
    </Card>
  );
}
