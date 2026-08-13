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
  const showToast = useToastStore((state) => state.showToast);

  useEffect(() => {
    loadConfig();
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
