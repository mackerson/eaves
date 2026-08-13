import { useState, useEffect, useCallback, useMemo, KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, Trash2, Brain, Loader2, ChevronDown, ChevronRight, Tag, Plus, Pencil, Check, X, Copy } from 'lucide-react';
import { CoreMemorySection } from '@/components/memory/CoreMemorySection';

/**
 * Core "Memory" view — browse / search / edit / delete the active memory backend
 * (core default, or a plugin override). Everything routes through the memory:*
 * IPC → the memory-backend service, so it's backend-agnostic.
 */

interface MemoryMeta {
  tags?: string[];
  updatedAt?: number;
  storedAt?: number;
  description?: string;
  [k: string]: unknown;
}
interface MemoryRow { key: string; value: string; metadata?: MemoryMeta }

const PAGE_SIZE = 50;
const LARGE_VALUE = 4000; // chars — beyond this, don't dump the whole blob into the DOM

function formatWhen(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diffDays = Math.floor((Date.now() - ts) / 86_400_000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  return `${(chars / 1024).toFixed(1)} KB`;
}

/** Small tag input: type + Enter/comma to add, click × to remove. */
function TagEditor({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !draft && tags.length) onChange(tags.slice(0, -1));
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map(t => (
        <span key={t} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          <Tag size={10} /> {t}
          <button className="hover:text-destructive" onClick={() => onChange(tags.filter(x => x !== t))}><X size={10} /></button>
        </span>
      ))}
      <input
        className="bg-transparent text-xs outline-none min-w-[80px] flex-1 py-0.5"
        placeholder="add tag…"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
      />
    </div>
  );
}

export function MemoryView() {
  const [rows, setRows] = useState<MemoryRow[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [showFull, setShowFull] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newTags, setNewTags] = useState<string[]>([]);

  const searching = query.trim().length > 0;

  const loadPage = useCallback(async (reset: boolean, currentLen: number) => {
    setLoading(true);
    const res = await window.electron.memoryList({ limit: PAGE_SIZE, offset: reset ? 0 : currentLen });
    if (res.success) {
      const page = (res.memories ?? []) as MemoryRow[];
      setRows(prev => (reset ? page : [...prev, ...page]));
      setTotal(res.total ?? res.count ?? 0);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadPage(true, 0); }, [loadPage]);

  // Debounced search — empty query returns to the paged browse list.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await window.electron.memorySearch({ query: q, limit: 50 });
      if (!cancelled && res.success) {
        setRows((res.results ?? []) as MemoryRow[]);
        setTotal(res.count ?? 0);
      }
      if (!cancelled) setLoading(false);
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);
  useEffect(() => { if (!query.trim()) loadPage(true, 0); }, [query, loadPage]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) for (const t of r.metadata?.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const largest = useMemo(() => rows.reduce<MemoryRow | null>((m, r) => (!m || r.value.length > m.value.length ? r : m), null), [rows]);

  const displayed = activeTag ? rows.filter(r => (r.metadata?.tags ?? []).includes(activeTag)) : rows;
  const hasMore = !searching && rows.length < total;

  const beginEdit = (row: MemoryRow) => {
    setEditingKey(row.key);
    setDraftValue(row.value);
    setDraftTags([...(row.metadata?.tags ?? [])]);
    setExpanded(row.key);
  };
  const saveEdit = async (row: MemoryRow) => {
    const { storedAt: _s, updatedAt: _u, ...rest } = row.metadata ?? {};
    const res = await window.electron.memoryStore({ key: row.key, value: draftValue, metadata: { ...rest, tags: draftTags } });
    if (res.success) {
      setRows(prev => prev.map(r => r.key === row.key
        ? { ...r, value: draftValue, metadata: { ...rest, tags: draftTags, updatedAt: Date.now() } }
        : r));
      setEditingKey(null);
    }
  };
  const handleDelete = async (key: string) => {
    const res = await window.electron.memoryDelete(key);
    if (res.success) { setRows(prev => prev.filter(r => r.key !== key)); setTotal(t => Math.max(0, t - 1)); }
  };
  const saveNew = async () => {
    const key = newKey.trim();
    if (!key) return;
    const res = await window.electron.memoryStore({ key, value: newValue, metadata: newTags.length ? { tags: newTags } : undefined });
    if (res.success) {
      setAdding(false); setNewKey(''); setNewValue(''); setNewTags([]);
      loadPage(true, 0);
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-6 py-4 border-b border-border">
        <Brain size={20} className="text-muted-foreground" />
        <h1 className="text-xl font-semibold">Memory</h1>
        <span className="text-sm text-muted-foreground ml-1">
          {searching ? `${displayed.length} match${displayed.length === 1 ? '' : 'es'}` : `${total} stored`}
          {!searching && rows.length < total ? ` · loaded ${rows.length}` : ''}
        </span>
        <div className="ml-auto">
          <Button size="sm" variant="outline" onClick={() => setAdding(a => !a)}>
            <Plus size={14} className="mr-1" /> New
          </Button>
        </div>
      </div>

      {/* Core memory (agent-scoped, editable) */}
      <CoreMemorySection />

      {/* Search */}
      <div className="px-6 py-3 border-b border-border">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search memories…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
      </div>

      {/* Overview strip */}
      {!searching && rows.length > 0 && (
        <div className="px-6 py-2 border-b border-border flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {allTags.length > 0 && (
            <>
              <button
                className={`px-1.5 py-0.5 rounded ${activeTag === null ? 'bg-primary/20 text-foreground' : 'hover:bg-muted'}`}
                onClick={() => setActiveTag(null)}
              >All</button>
              {allTags.slice(0, 8).map(([t, n]) => (
                <button
                  key={t}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${activeTag === t ? 'bg-primary/20 text-foreground' : 'hover:bg-muted'}`}
                  onClick={() => setActiveTag(activeTag === t ? null : t)}
                ><Tag size={10} /> {t} <span className="opacity-60">{n}</span></button>
              ))}
            </>
          )}
          {largest && largest.value.length > 10_000 && (
            <span className="ml-auto text-amber-500/80" title="Large memories inflate context — consider splitting or summarizing">
              largest: {largest.key} ({formatSize(largest.value.length)})
            </span>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2">
        {/* Add form */}
        {adding && (
          <div className="rounded-lg border border-primary/40 bg-card p-3 space-y-2">
            <Input placeholder="key (unique)" value={newKey} onChange={e => setNewKey(e.target.value)} />
            <textarea
              className="w-full min-h-[80px] rounded-md border border-border bg-background p-2 text-sm"
              placeholder="value" value={newValue} onChange={e => setNewValue(e.target.value)}
            />
            <TagEditor tags={newTags} onChange={setNewTags} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button size="sm" onClick={saveNew} disabled={!newKey.trim()}><Check size={14} className="mr-1" /> Save</Button>
            </div>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 size={20} className="animate-spin mr-2" /> Loading…</div>
        ) : displayed.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {searching ? 'No memories match your search.' : activeTag ? `No memories tagged “${activeTag}”.` : 'No memories stored yet.'}
          </div>
        ) : (
          displayed.map(row => {
            const isOpen = expanded === row.key;
            const isEditing = editingKey === row.key;
            const tags = row.metadata?.tags ?? [];
            const tooLong = row.value.length > LARGE_VALUE;
            const shownValue = isOpen && tooLong && showFull !== row.key ? row.value.slice(0, LARGE_VALUE) : row.value;
            return (
              <div key={row.key} className="rounded-lg border border-border bg-card">
                <div className="flex items-start gap-2 p-3">
                  <button className="mt-0.5 text-muted-foreground hover:text-foreground" onClick={() => setExpanded(isOpen ? null : row.key)}>
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium truncate">{row.key}</span>
                      {row.metadata?.updatedAt && <span className="text-xs text-muted-foreground shrink-0">{formatWhen(row.metadata.updatedAt)}</span>}
                      <span className="text-xs text-muted-foreground/60 shrink-0">{formatSize(row.value.length)}</span>
                    </div>

                    {isEditing ? (
                      <div className="mt-2 space-y-2">
                        <textarea
                          className="w-full min-h-[120px] rounded-md border border-border bg-background p-2 text-sm font-mono"
                          value={draftValue} onChange={e => setDraftValue(e.target.value)}
                        />
                        <TagEditor tags={draftTags} onChange={setDraftTags} />
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)}>Cancel</Button>
                          <Button size="sm" onClick={() => saveEdit(row)}><Check size={14} className="mr-1" /> Save</Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className={isOpen ? 'mt-2 whitespace-pre-wrap text-sm break-words' : 'mt-1 text-sm text-muted-foreground truncate'}>
                          {isOpen ? shownValue : row.value.slice(0, 200)}
                        </div>
                        {isOpen && tooLong && (
                          <button className="mt-1 text-xs text-primary hover:underline" onClick={() => setShowFull(showFull === row.key ? null : row.key)}>
                            {showFull === row.key ? 'Show less' : `Show full (${formatSize(row.value.length)})`}
                          </button>
                        )}
                        {tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {tags.map(t => (
                              <span key={t} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"><Tag size={10} /> {t}</span>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {!isEditing && (
                    <div className="flex shrink-0 gap-0.5">
                      {isOpen && (
                        <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" title="Copy value"
                          onClick={() => navigator.clipboard?.writeText(row.value)}><Copy size={15} /></Button>
                      )}
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-foreground" title="Edit" onClick={() => beginEdit(row)}><Pencil size={15} /></Button>
                      <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive" title="Delete" onClick={() => handleDelete(row.key)}><Trash2 size={15} /></Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {hasMore && !activeTag && (
          <div className="flex justify-center py-3">
            <Button variant="outline" size="sm" onClick={() => loadPage(false, rows.length)} disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin mr-1" /> : null}
              Load more ({total - rows.length} more)
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
