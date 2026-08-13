import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useSettingsStore, useToastStore } from '@/stores';

export function AdvancedSection() {
  const workflowReviewRequired = useSettingsStore(
    (s) => s.settings.workflowReviewRequired,
  );
  const openrouterStickyProvider = useSettingsStore(
    (s) => s.settings.openrouterStickyProvider,
  );
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const showToast = useToastStore((s) => s.showToast);

  const reviewOn = workflowReviewRequired !== false;
  const stickyOn = openrouterStickyProvider !== false;

  const handleReviewToggle = (checked: boolean) => {
    updateSettings({ workflowReviewRequired: checked }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(`Failed to save: ${message}`, 'error');
    });
  };

  const handleStickyToggle = (checked: boolean) => {
    updateSettings({ openrouterStickyProvider: checked }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(`Failed to save: ${message}`, 'error');
    });
  };

  const handleRerunWizard = async () => {
    try {
      await updateSettings({ oobeCompleted: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      showToast(`Failed to save: ${message}`, 'error');
    }
  };

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <Label>Require review for agent-created workflows</Label>
          <p className="text-sm text-muted-foreground">
            When ON, workflows that agents create via chat are queued as <em>pending review</em> and cannot execute until you approve them in the Workflows tab. This is the default.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            id="workflow-review-required"
            type="checkbox"
            checked={reviewOn}
            onChange={(e) => handleReviewToggle(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="workflow-review-required" className="cursor-pointer">
            Require human review
          </Label>
        </div>
        {!reviewOn && (
          <div
            className="p-3 rounded-md border"
            style={{
              background: 'rgba(220, 38, 38, 0.08)',
              borderColor: 'rgb(220, 38, 38)',
            }}
          >
            <p className="text-sm font-semibold" style={{ color: 'rgb(220, 38, 38)' }}>
              ⚠️ Review gate disabled
            </p>
            <p className="text-sm mt-1 text-muted-foreground">
              Agents can now create workflows that execute arbitrary code (read/write files, call the network, run shell commands) without your approval. A prompt injection in any agent interaction could silently compromise your system. Re-enable this unless you have very good reason.
            </p>
          </div>
        )}
      </section>

      <section className="space-y-3 pt-6 border-t border-border">
        <div>
          <Label>OpenRouter sticky provider</Label>
          <p className="text-sm text-muted-foreground">
            When ON (default), an OpenRouter conversation prefers the upstream backend that served its previous turn, keeping the prompt cache warm across turns — noticeably cheaper on long, cache-heavy chats. Applied softly: if that backend is unavailable, OpenRouter still serves the request and the next turn re-pins to whoever answered. Turn OFF to use OpenRouter's default per-turn routing.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            id="openrouter-sticky-provider"
            type="checkbox"
            checked={stickyOn}
            onChange={(e) => handleStickyToggle(e.target.checked)}
            className="h-4 w-4"
          />
          <Label htmlFor="openrouter-sticky-provider" className="cursor-pointer">
            Keep conversations on one backend (cache continuity)
          </Label>
        </div>
      </section>

      <section className="space-y-3 pt-6 border-t border-border">
        <div>
          <Label>Setup Wizard</Label>
          <p className="text-sm text-muted-foreground">
            Re-run the initial setup wizard to configure providers or create a new agent.
          </p>
        </div>
        <Button variant="outline" onClick={handleRerunWizard}>
          Run Setup Wizard
        </Button>
      </section>

      <section className="space-y-3 pt-6 border-t border-border">
        <div>
          <Label>Application Logs</Label>
          <p className="text-sm text-muted-foreground">
            Logs rotate automatically when they exceed 10MB. Up to 5 files are kept.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.electron.openLogDir()}>
            Open Log Directory
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (confirm('Are you sure you want to clear all logs?')) {
                await window.electron.clearLogs();
                showToast('Logs cleared successfully', 'success');
              }
            }}
          >
            Clear All Logs
          </Button>
        </div>
      </section>
    </div>
  );
}
