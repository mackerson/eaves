import { useState, useEffect } from 'react';
import { useAgentStore } from '@/stores';
import { Button } from '@/components/ui/button';
import { Brain, Check, ChevronDown, ChevronRight } from 'lucide-react';

/**
 * Core-memory blocks for an agent — the always-in-context summaries the agent
 * (and the "dreaming" shadow) maintain. Editable here so a human can correct
 * what the agent/dream wrote. Shown at the top of the Memory view.
 */
interface Block { id: string; label: string; value: string; description: string | null; char_limit: number; read_only: number }

export function CoreMemorySection() {
  const { agents, currentAgentId } = useAgentStore();
  const [agentId, setAgentId] = useState('');
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Default to the current agent (or the first one).
  useEffect(() => {
    if (agentId || agents.length === 0) return;
    setAgentId(currentAgentId && agents.some(a => a.id === currentAgentId) ? currentAgentId : agents[0].id);
  }, [agents, currentAgentId, agentId]);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setLoading(true);
    window.electron.memoryBlocksList(agentId).then(res => {
      if (cancelled) return;
      if (res.success && res.blocks) {
        setBlocks(res.blocks);
        setDrafts(Object.fromEntries(res.blocks.map(b => [b.label, b.value])));
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [agentId]);

  const save = async (label: string) => {
    const res = await window.electron.memoryBlockSet({ agentId, label, value: drafts[label] ?? '' });
    if (res.success && res.block) {
      setBlocks(prev => prev.map(b => (b.label === label ? { ...b, value: res.block!.value } : b)));
      setDrafts(d => ({ ...d, [label]: res.block!.value }));
    }
  };

  if (agents.length === 0) return null;
  const agentName = agents.find(a => a.id === agentId)?.name;

  return (
    <div className="border-b border-border">
      <div className="flex items-center gap-2 px-6 py-2">
        <button onClick={() => setCollapsed(c => !c)} className="flex items-center gap-1.5 text-sm font-medium hover:text-foreground">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <Brain size={14} className="text-muted-foreground" /> Core memory
        </button>
        <select
          value={agentId}
          onChange={e => setAgentId(e.target.value)}
          className="ml-1 text-xs bg-transparent border border-border rounded px-1.5 py-0.5"
          title="Whose core memory to view"
        >
          {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {agentName && <span className="text-xs text-muted-foreground ml-auto">always in {agentName}'s context</span>}
      </div>

      {!collapsed && (
        <div className="px-6 pb-3 space-y-2">
          {loading ? (
            <div className="text-xs text-muted-foreground py-1">Loading…</div>
          ) : blocks.length === 0 ? (
            <div className="text-xs text-muted-foreground py-1">No core-memory blocks yet.</div>
          ) : (
            blocks.map(b => {
              const val = drafts[b.label] ?? '';
              const dirty = val !== b.value;
              return (
                <div key={b.id}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-medium">{b.label}</span>
                    {b.read_only ? <span className="text-[10px] text-muted-foreground">read-only</span> : null}
                    <span className="text-[10px] text-muted-foreground ml-auto">{val.length}/{b.char_limit}</span>
                  </div>
                  <textarea
                    className="w-full mt-1 rounded-md border border-border bg-background p-2 text-sm min-h-[52px]"
                    placeholder={b.description ?? ''}
                    value={val}
                    maxLength={b.char_limit}
                    readOnly={!!b.read_only}
                    onChange={e => setDrafts(d => ({ ...d, [b.label]: e.target.value }))}
                  />
                  {dirty && !b.read_only && (
                    <div className="flex justify-end mt-1">
                      <Button size="sm" onClick={() => save(b.label)}><Check size={13} className="mr-1" /> Save</Button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
