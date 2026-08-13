import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSettingsStore, useToastStore } from '@/stores';
import { PROVIDERS, ProviderId } from '@shared/providers';

/**
 * Credential fields are write-only.
 *
 * The main process no longer sends provider keys to the renderer at all
 * (redactSettingsForRenderer) — plugin UI bundles share this realm and the
 * preload bridge, so anything the renderer can read, an installed plugin can
 * read. What arrives instead is `configuredProviders`: which providers have
 * something on file, and nothing about what. So a configured provider shows
 * its state and offers replace/remove rather than rendering the key back.
 *
 * Local providers (isLocalEndpoint) are exempt: that field holds an endpoint
 * URL, not a secret, and it still round-trips so it stays directly editable.
 */
export function ProvidersSection() {
  const persistedKeys = useSettingsStore((s) => s.settings.apiKeys);
  const configuredProviders = useSettingsStore((s) => s.settings.configuredProviders);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showToast = useToastStore((s) => s.showToast);

  const configured = useMemo(
    () => new Set<ProviderId>(configuredProviders ?? []),
    [configuredProviders],
  );

  // Local drafts of every provider field. Explicit-save model: edits stay
  // local until the user hits Save, so it's obvious a change is pending and
  // obvious once it's committed (unlike the old silent onBlur autosave).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Fields the user has edited this session — kept in sync-from-persisted below
  // so an untouched field still tracks external updates (hydration, OOBE).
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Configured credentials the user has asked to clear. Tracked separately
  // because an empty draft is the resting state for a write-only field and so
  // can't itself mean "delete this".
  const [pendingRemoval, setPendingRemoval] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const p of PROVIDERS) {
        // Only endpoint fields have a persisted value to sync down; credential
        // fields have nothing to show and stay empty until the user types.
        if (p.isLocalEndpoint && !touched[p.id]) next[p.id] = persistedKeys[p.id] ?? '';
      }
      return next;
    });
  }, [persistedKeys, touched]);

  const changed = useMemo(
    () =>
      PROVIDERS.filter((p) => {
        if (p.isLocalEndpoint) {
          return (drafts[p.id] ?? '').trim() !== (persistedKeys[p.id] ?? '');
        }
        return (drafts[p.id] ?? '').trim() !== '' || !!pendingRemoval[p.id];
      }),
    [drafts, persistedKeys, pendingRemoval],
  );
  const isDirty = changed.length > 0;

  const handleChange = (providerId: string, value: string) => {
    setDrafts((prev) => ({ ...prev, [providerId]: value }));
    setTouched((prev) => ({ ...prev, [providerId]: true }));
    setPendingRemoval((prev) => ({ ...prev, [providerId]: false }));
    setJustSaved(false);
  };

  const handleRemove = (providerId: string) => {
    setDrafts((prev) => ({ ...prev, [providerId]: '' }));
    setPendingRemoval((prev) => ({ ...prev, [providerId]: true }));
    setJustSaved(false);
  };

  const handleSave = async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    const patch: Record<string, string> = {};
    for (const p of changed) {
      // '' clears the stored value — see ApiKeySchema.
      patch[p.id] = pendingRemoval[p.id] ? '' : (drafts[p.id] ?? '').trim();
    }
    try {
      await updateSettings({ apiKeys: patch });
      // Untouch everything so drafts re-sync to the now-updated persisted map,
      // and clear the write-only fields — their value is no longer readable.
      setTouched({});
      setPendingRemoval({});
      setDrafts((prev) => {
        const next = { ...prev };
        for (const p of changed) if (!p.isLocalEndpoint) next[p.id] = '';
        return next;
      });
      setJustSaved(true);
      showToast('Provider settings saved', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      showToast(`Failed to save: ${message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Paste keys for the providers you want your agents to use. Keys are
        encrypted at rest and can&apos;t be read back once saved — you can
        replace or remove a key, but not view it. Click Save to apply your
        changes.
      </p>

      {PROVIDERS.map((p) => {
        const inputId = `${p.id}-key`;
        const labelText = p.needsKey ? p.keyLabel : `${p.keyLabel} (optional)`;
        const isSet = configured.has(p.id) && !pendingRemoval[p.id];
        const showStatus = !p.isLocalEndpoint;
        return (
          <div key={p.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor={inputId}>
                {p.label} — {labelText}
              </Label>
              {showStatus && isSet && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-green-600 dark:text-green-500">
                    Configured
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => handleRemove(p.id)}
                  >
                    Remove
                  </Button>
                </div>
              )}
              {showStatus && pendingRemoval[p.id] && (
                <span className="text-xs text-muted-foreground">
                  Will be removed on save
                </span>
              )}
            </div>
            <Input
              id={inputId}
              type={p.needsKey ? 'password' : 'text'}
              value={drafts[p.id] ?? ''}
              onChange={(e) => handleChange(p.id, e.target.value)}
              placeholder={isSet ? 'Enter a new key to replace' : p.keyPlaceholder}
            />
            <p className="text-xs text-muted-foreground">{p.keyHelp}</p>
          </div>
        );
      })}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={!isDirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {isDirty && !saving && (
          <span className="text-xs text-muted-foreground">
            You have unsaved changes.
          </span>
        )}
        {!isDirty && justSaved && !saving && (
          <span className="text-xs text-green-600 dark:text-green-500">
            Saved ✓
          </span>
        )}
      </div>
    </div>
  );
}
