import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/modals/ConfirmDialog';
import { useToastStore } from '@/stores';
import { AlertTriangle } from 'lucide-react';
import type { PluginDraft } from '@/../shared/types';

/**
 * The Workshop: where an agent's plugin gets read, run and judged before it is
 * allowed to become real.
 *
 * The gap this closes is that until now you could keep a plugin without ever
 * having seen its code. Every file is shown verbatim, because "approve each
 * step" is meaningless if the thing being approved is opaque.
 *
 * The agent still works in chat — this is the review surface, not a second
 * conversation. Everything here is an action only a person may take.
 */

interface DraftFile { path: string; content: string }

const ELEVATED = new Set(['network:http', 'system:filesystem']);

export function WorkshopView() {
  const [drafts, setDrafts] = useState<PluginDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [discardTarget, setDiscardTarget] = useState<PluginDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const showToast = useToastStore((state) => state.showToast);

  const refresh = useCallback(async () => {
    const result = await window.electron.listPluginDrafts();
    setDrafts(result?.drafts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const openDraft = async (draft: PluginDraft) => {
    if (openId === draft.id) { setOpenId(null); return; }
    const result = await window.electron.readPluginDraft(draft.id);
    if (!result?.success || !result.files) {
      showToast(result?.error || 'Could not read that draft', 'error');
      return;
    }
    setOpenId(draft.id);
    setFiles(result.files);
    setOpenFile(result.files[0]?.path ?? null);
  };

  /** Every action is the same shape: run it, say what happened, re-read state. */
  const act = async (
    draft: PluginDraft,
    verb: string,
    run: () => Promise<{ success: boolean; error?: string }>,
    done: string,
  ) => {
    setBusyId(draft.id);
    try {
      const result = await run();
      if (!result?.success) {
        showToast(result?.error || `Could not ${verb} ${draft.name}`, 'error');
        return;
      }
      showToast(done, 'success');
      await refresh();
    } catch (error: any) {
      showToast(error?.message || `Could not ${verb} ${draft.name}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div className="p-8 text-muted-foreground">Loading drafts…</div>;
  }

  return (
    <div className="p-8 overflow-y-auto">
      <div className="mb-6">
        <h2 className="text-3xl font-semibold">Workshop</h2>
        <p className="text-muted-foreground mt-2">
          Plugins an agent has written. Read them, run them, look at them — then decide.
        </p>
      </div>

      {drafts.length === 0 ? (
        <div className="max-w-3xl border border-dashed border-border rounded-lg p-8 text-center">
          <p className="text-muted-foreground">
            Nothing staged. Turn on <strong>Let agents build plugins</strong> in Settings → Advanced,
            then ask an agent to build one.
          </p>
        </div>
      ) : (
        <div className="max-w-4xl space-y-4">
          {drafts.map((draft) => {
            const isOpen = openId === draft.id;
            const busy = busyId === draft.id;
            const elevated = draft.permissions.filter((p) => ELEVATED.has(p));

            return (
              <div key={draft.id} className="border border-border rounded-lg bg-card">
                <div className="p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-medium truncate">{draft.name}</h3>
                      <span className="text-xs text-muted-foreground">v{draft.version}</span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                        {draft.type}
                      </span>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          draft.running
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {draft.running ? 'running' : 'staged'}
                      </span>
                    </div>
                    {draft.description && (
                      <p className="text-sm text-muted-foreground mt-1">{draft.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">
                      <button className="underline underline-offset-2" onClick={() => openDraft(draft)}>
                        {draft.files.length} file{draft.files.length === 1 ? '' : 's'}
                      </button>
                      {' · '}
                      {draft.permissions.length
                        ? `asks for: ${draft.permissions.join(', ')}`
                        : 'asks for no special access'}
                    </p>
                    {elevated.length > 0 && (
                      <p className="text-xs mt-2 flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        Wants {elevated.join(' and ')} — read the code before you keep this.
                      </p>
                    )}
                  </div>

                  <div className="flex items-center flex-wrap gap-2 justify-end mt-3">
                    {draft.bundleUrl && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          act(draft, 'preview', () => window.electron.previewPluginDraft(draft.id), 'Preview opened')
                        }
                      >
                        Preview
                      </Button>
                    )}
                    {draft.running ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          act(draft, 'stop', () => window.electron.deactivatePluginDraft(draft.id), `${draft.name} stopped`)
                        }
                      >
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          act(draft, 'run', () => window.electron.activatePluginDraft(draft.id), `${draft.name} is running`)
                        }
                      >
                        Run
                      </Button>
                    )}
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => setDiscardTarget(draft)}>
                      Discard
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        act(draft, 'keep', () => window.electron.promotePluginDraft(draft.id), `${draft.name} is now installed`)
                      }
                    >
                      Keep
                    </Button>
                  </div>
                </div>

                {isOpen && (
                  <div className="border-t border-border">
                    <div className="flex gap-1 px-3 py-2 overflow-x-auto border-b border-border">
                      {files.map((file) => (
                        <button
                          key={file.path}
                          onClick={() => setOpenFile(file.path)}
                          className={`text-xs px-2 py-1 rounded whitespace-nowrap ${
                            openFile === file.path
                              ? 'bg-accent text-accent-foreground'
                              : 'text-muted-foreground hover:bg-accent/50'
                          }`}
                        >
                          {file.path}
                        </button>
                      ))}
                    </div>
                    <pre className="p-4 text-xs overflow-x-auto max-h-96 overflow-y-auto font-mono">
                      {files.find((f) => f.path === openFile)?.content ?? ''}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {discardTarget && (
        <ConfirmDialog
          open={true}
          onOpenChange={(open) => { if (!open) setDiscardTarget(null); }}
          title={`Discard ${discardTarget.name}?`}
          message={
            `This stops ${discardTarget.name} and deletes it. It was never installed, so nothing else ` +
            `changes — but the agent's work on it is gone and it would have to be written again.`
          }
          confirmLabel="Discard"
          onConfirm={() => {
            const target = discardTarget;
            setDiscardTarget(null);
            if (openId === target.id) setOpenId(null);
            void act(target, 'discard', () => window.electron.discardPluginDraft(target.id), `${target.name} discarded`);
          }}
        />
      )}
    </div>
  );
}
