import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToastStore } from '@/stores';

interface ConfigSchema {
  type: string;
  default?: any;
  description?: string;
}

interface ConfigData {
  schema: Record<string, ConfigSchema>;
  values: Record<string, any>;
  pluginId: string;
  pluginName: string;
}

interface SecretsData {
  encryptionAvailable: boolean;
  declared: Array<{ key: string; label: string; description?: string; set: boolean }>;
  undeclared: string[];
}

interface ConfigurePluginModalProps {
  pluginId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConfigurePluginModal({ pluginId, open, onOpenChange }: ConfigurePluginModalProps) {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Secrets are write-only: `secrets` holds key names and set/not-set,
  // `secretInputs` holds what the user is typing right now and is cleared the
  // moment a value is submitted — the renderer never holds a stored value.
  const [secrets, setSecrets] = useState<SecretsData | null>(null);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [secretBusy, setSecretBusy] = useState<string | null>(null);
  const showToast = useToastStore((state) => state.showToast);

  useEffect(() => {
    loadConfig();
    loadSecrets();
  }, [pluginId]);

  const loadConfig = async () => {
    try {
      setLoading(true);
      const data = await window.electron.getPluginConfig(pluginId);
      setConfig(data);

      // Initialize form values with current config or defaults
      const initialValues: Record<string, any> = {};
      for (const [key, schema] of Object.entries(data.schema)) {
        initialValues[key] = data.values[key] ?? schema.default;
      }
      setFormValues(initialValues);
    } catch (error: any) {
      console.error('Failed to load plugin config:', error);
      showToast(error.message || 'Failed to load configuration', 'error');
      onOpenChange(false);
    } finally {
      setLoading(false);
    }
  };

  const loadSecrets = async () => {
    try {
      const data = await window.electron.getPluginSecrets(pluginId);
      if (data && data.declared !== undefined) {
        setSecrets({
          encryptionAvailable: data.encryptionAvailable ?? false,
          declared: data.declared ?? [],
          undeclared: data.undeclared ?? [],
        });
      } else {
        setSecrets(null);
      }
    } catch (error) {
      // No secrets section rather than a dead modal — config still works.
      console.error('Failed to load plugin secrets status:', error);
      setSecrets(null);
    }
  };

  const handleSetSecret = async (key: string) => {
    const value = secretInputs[key];
    if (!value) return;
    try {
      setSecretBusy(key);
      const result = await window.electron.setPluginSecret(pluginId, key, value);
      if (!result?.success) {
        showToast(result?.error || 'Failed to store secret', 'error');
        return;
      }
      // Drop the plaintext from renderer state as soon as the store has it.
      setSecretInputs(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      showToast('Secret stored', 'success');
      await loadSecrets();
    } catch (error: any) {
      showToast(error?.message || 'Failed to store secret', 'error');
    } finally {
      setSecretBusy(null);
    }
  };

  const handleDeleteSecret = async (key: string) => {
    try {
      setSecretBusy(key);
      const result = await window.electron.deletePluginSecret(pluginId, key);
      if (!result?.success) {
        showToast(result?.error || 'Failed to delete secret', 'error');
        return;
      }
      showToast('Secret deleted', 'success');
      await loadSecrets();
    } catch (error: any) {
      showToast(error?.message || 'Failed to delete secret', 'error');
    } finally {
      setSecretBusy(null);
    }
  };

  const handleSave = async () => {
    if (!config) return;

    try {
      setSaving(true);
      await window.electron.setPluginConfig(pluginId, formValues);
      showToast('Configuration saved and plugin reloaded', 'success');
      onOpenChange(false);
    } catch (error: any) {
      console.error('Failed to save plugin config:', error);
      showToast(error.message || 'Failed to save configuration', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = (key: string, value: any) => {
    setFormValues(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const renderField = (key: string, schema: ConfigSchema) => {
    const value = formValues[key];

    switch (schema.type) {
      case 'string':
        return (
          <Input
            type="text"
            value={value || ''}
            onChange={(e) => handleInputChange(key, e.target.value)}
            placeholder={schema.default || ''}
          />
        );

      case 'number':
        return (
          <Input
            type="number"
            value={value ?? ''}
            onChange={(e) => handleInputChange(key, e.target.valueAsNumber)}
            placeholder={schema.default || ''}
          />
        );

      case 'boolean':
        return (
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={value ?? false}
              onChange={(e) => handleInputChange(key, e.target.checked)}
            />
            <span>Enable</span>
          </label>
        );

      default:
        return (
          <Input
            type="text"
            value={value || ''}
            onChange={(e) => handleInputChange(key, e.target.value)}
          />
        );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {loading ? 'Loading Configuration...' : `Configure ${config?.pluginName || ''}`}
          </DialogTitle>
        </DialogHeader>

        <div className="py-4">
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">
              Loading...
            </div>
          ) : !config ? (
            <div className="text-center py-8 text-muted-foreground">
              Failed to load configuration
            </div>
          ) : Object.keys(config.schema).length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              This plugin has no configurable options.
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(config.schema).map(([key, schema]) => (
                <div key={key} className="space-y-2">
                  <Label htmlFor={key}>
                    {key.split(/(?=[A-Z])/).join(' ').replace(/^./, str => str.toUpperCase())}
                  </Label>
                  {schema.description && (
                    <p className="text-sm text-muted-foreground">
                      {schema.description}
                    </p>
                  )}
                  {renderField(key, schema)}
                  {schema.default !== undefined && (
                    <div className="text-xs text-muted-foreground">
                      Default: {String(schema.default)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Secrets: write-only. The UI shows set/not-set and takes new
              values; a stored value is never read back into this window. */}
          {!loading && secrets && (secrets.declared.length > 0 || secrets.undeclared.length > 0) && (
            <div className="mt-6 pt-4 border-t border-border space-y-4">
              <div>
                <h3 className="text-sm font-semibold">Secrets</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Stored sealed with your OS keychain. Values are write-only: you can replace or
                  delete one, but it is never shown again. Changes take effect the next time the
                  plugin reads them.
                </p>
              </div>

              {!secrets.encryptionAvailable && (
                <p className="text-sm text-yellow-700 dark:text-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-3">
                  OS encryption (safeStorage) is unavailable on this system, so secrets cannot be
                  stored. There is deliberately no plaintext fallback.
                </p>
              )}

              {secrets.declared.map((secret) => (
                <div key={secret.key} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`secret-${secret.key}`}>{secret.label}</Label>
                    {secret.set ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                        set
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        not set
                      </span>
                    )}
                  </div>
                  {secret.description && (
                    <p className="text-sm text-muted-foreground">{secret.description}</p>
                  )}
                  <div className="flex items-center gap-2">
                    <Input
                      id={`secret-${secret.key}`}
                      type="password"
                      autoComplete="off"
                      value={secretInputs[secret.key] ?? ''}
                      onChange={(e) => setSecretInputs(prev => ({ ...prev, [secret.key]: e.target.value }))}
                      placeholder={secret.set ? 'Enter a new value to replace it' : 'Enter a value'}
                      disabled={!secrets.encryptionAvailable || secretBusy !== null}
                    />
                    <Button
                      size="sm"
                      onClick={() => handleSetSecret(secret.key)}
                      disabled={!secrets.encryptionAvailable || !secretInputs[secret.key] || secretBusy !== null}
                    >
                      {secretBusy === secret.key ? 'Saving…' : secret.set ? 'Replace' : 'Set'}
                    </Button>
                    {secret.set && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDeleteSecret(secret.key)}
                        disabled={secretBusy !== null}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              ))}

              {secrets.undeclared.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Also stored by the plugin itself (not declared in its manifest — can be
                    deleted here, not edited):
                  </p>
                  {secrets.undeclared.map((key) => (
                    <div key={key} className="flex items-center justify-between gap-2">
                      <code className="text-sm">{key}</code>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => handleDeleteSecret(key)}
                        disabled={secretBusy !== null}
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || loading || !config || Object.keys(config?.schema || {}).length === 0}
          >
            {saving ? 'Saving...' : 'Save & Reload Plugin'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
