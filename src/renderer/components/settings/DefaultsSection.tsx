import { Label } from '@/components/ui/label';
import { useSettingsStore, useToastStore } from '@/stores';
import { useAgentStore } from '@/stores/useAgentStore';

export function DefaultsSection() {
  const defaultAgentId = useSettingsStore((s) => s.settings.defaultAgentId);
  const systemAgentId = useSettingsStore((s) => s.settings.systemAgentId);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showToast = useToastStore((s) => s.showToast);
  const agents = useAgentStore((state) => state.agents);

  const save = (patch: Parameters<typeof updateSettings>[0]) => {
    updateSettings(patch).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(`Failed to save: ${message}`, 'error');
    });
  };

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Label htmlFor="default-agent">Default Agent</Label>
        <p className="text-sm text-muted-foreground">
          Used when you create a new chat from the <span className="font-semibold">New</span> menu or <span className="font-semibold">+ New</span> in the chat list.
        </p>
        <select
          id="default-agent"
          value={defaultAgentId || ''}
          onChange={(e) => save({ defaultAgentId: e.target.value || undefined })}
          className="w-full px-3 py-2 border border-border rounded-md bg-background"
        >
          <option value="">First available agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} ({agent.provider}/{agent.model})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="system-agent">System Model</Label>
        <p className="text-sm text-muted-foreground">
          Used for background work — chat title generation, note metadata, workflow agent-node fallbacks. Pin a fast cheap model (Haiku, a local model) so housekeeping doesn't eat your premium tokens. Falls back to the Default Agent when unset.
        </p>
        <select
          id="system-agent"
          value={systemAgentId || ''}
          onChange={(e) => save({ systemAgentId: e.target.value || undefined })}
          className="w-full px-3 py-2 border border-border rounded-md bg-background"
        >
          <option value="">Same as Default Agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} ({agent.provider}/{agent.model})
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
