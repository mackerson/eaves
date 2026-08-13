import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useSettingsStore, useToastStore } from '@/stores';

/** Suggested default embedding model per provider (mirrors DEFAULT_EMBED_MODEL in main). */
const DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'openai/text-embedding-3-small',
  openai: 'text-embedding-3-small',
  google: 'text-embedding-004',
  ollama: 'nomic-embed-text',
  lmstudio: 'text-embedding-nomic-embed-text-v1.5',
};

const PROVIDERS: Array<{ id: string; label: string }> = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'google', label: 'Google' },
  { id: 'ollama', label: 'Ollama (local)' },
  { id: 'lmstudio', label: 'LM Studio (local)' },
];

export function MemorySettingsSection() {
  const cfg = useSettingsStore(s => s.settings.memoryEmbedding);
  const updateSettings = useSettingsStore(s => s.updateSettings);
  const showToast = useToastStore(s => s.showToast);

  const enabled = !!cfg?.enabled;
  const provider = cfg?.provider || 'openrouter';
  const [model, setModel] = useState(cfg?.model || '');

  const save = (patch: Partial<{ enabled: boolean; provider: string; model: string }>) => {
    const next = { enabled, provider, model, ...patch };
    if (!next.model.trim()) next.model = DEFAULT_MODELS[next.provider] || '';
    setModel(next.model);
    updateSettings({ memoryEmbedding: next }).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : 'Save failed', 'error');
    });
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold">Semantic memory search</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Adds vector (meaning-based) recall alongside keyword search for agent memory — so a query
          finds relevant memories even without matching words. Uses your provider key; off = keyword
          only. Changing provider or model re-indexes your stored memories.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          id="embed-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(e) => save({ enabled: e.target.checked })}
          className="h-4 w-4"
        />
        <Label htmlFor="embed-enabled" className="cursor-pointer">Enable semantic search</Label>
      </div>

      {enabled && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="embed-provider">Embedding provider</Label>
            <select
              id="embed-provider"
              value={provider}
              onChange={e => save({ provider: e.target.value, model: '' })}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">
              Embeddings are configured separately from your chat provider (Anthropic has no embeddings API).
              Reuses the key stored under this provider in Settings → Providers.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="embed-model">Embedding model</Label>
            <Input
              id="embed-model"
              value={model}
              placeholder={DEFAULT_MODELS[provider] || 'model id'}
              onChange={e => setModel(e.target.value)}
              onBlur={() => save({ model })}
            />
          </div>
        </>
      )}
    </div>
  );
}
