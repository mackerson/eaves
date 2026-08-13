import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Hash, Loader2, MessageSquare, Paperclip, Search, StickyNote } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Note, File as ProjectFile } from '@/types';
import { useAgentStore, useConversationsStore, useProjectStore, useUIStore } from '@/stores';

interface GlobalSearchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ResultKind = 'chat' | 'channel' | 'note' | 'file';

type SearchResult =
  | { kind: 'chat'; key: string; id: string; title: string; subtitle?: string }
  | { kind: 'channel'; key: string; id: string; title: string; subtitle?: string }
  | { kind: 'note'; key: string; id: string; title: string; subtitle?: string; projectId: string; note: Note }
  | { kind: 'file'; key: string; id: string; title: string; subtitle?: string; projectId: string };

const GROUPS: { kind: ResultKind; label: string; Icon: typeof Hash }[] = [
  { kind: 'chat', label: 'Chats', Icon: MessageSquare },
  { kind: 'channel', label: 'Channels', Icon: Hash },
  { kind: 'note', label: 'Notes', Icon: StickyNote },
  { kind: 'file', label: 'Files', Icon: Paperclip },
];

const DEBOUNCE_MS = 175;
/** Per-group cap — the point is to find one thing, not to page through everything. */
const MAX_PER_GROUP = 8;

/** Notes carry no title of their own half the time; fall back to the first line. */
function noteTitle(note: Note): string {
  if (note.title?.trim()) return note.title.trim();
  const firstLine = note.content.split('\n').find((l) => l.trim());
  return firstLine?.trim() || 'Untitled note';
}

export function GlobalSearchModal({ open, onOpenChange }: GlobalSearchModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Monotonic request counter: a slow early query resolving after a fast later
  // one must not repaint the list with stale results.
  const seqRef = useRef(0);

  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim();
    const seq = ++seqRef.current;

    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);

    // Notes and files have no global search IPC — both are project-scoped
    // list surfaces, so fan out over the known projects and merge.
    const projects = useProjectStore.getState().projects;
    const agents = useAgentStore.getState().agents;
    const projectName = (id: string) => projects.find((p) => p.id === id)?.name;

    const chatsP = window.electron
      .searchChats({ query: q })
      .then((r) => (r.success && r.chats ? r.chats : []))
      .catch(() => []);

    const channelsP = window.electron
      .searchChannels({ query: q })
      .then((r) => (r.success && r.channels ? r.channels : []))
      .catch(() => []);

    const notesP = Promise.all(
      projects.map((p) =>
        window.electron
          .listNotes({ projectId: p.id, searchQuery: q })
          // list-notes returns the array on success but an error envelope on
          // failure, so the declared Note[] is only true on the happy path.
          .then((n) => (Array.isArray(n) ? n.map((note) => ({ note, projectId: p.id })) : []))
          .catch(() => [] as { note: Note; projectId: string }[])
      )
    ).then((per) => per.flat());

    const needle = q.toLowerCase();
    const filesP = Promise.all(
      projects.map((p) =>
        window.electron
          .listFiles(p.id)
          .then((f) => (Array.isArray(f) ? f : ([] as ProjectFile[])))
          .catch(() => [] as ProjectFile[])
      )
    ).then((per) =>
      // files:list is a plain list — no query support — so match client-side.
      per
        .flat()
        .filter((f) => f.name.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
    );

    const [chats, channels, notes, files] = await Promise.all([chatsP, channelsP, notesP, filesP]);

    if (seq !== seqRef.current) return;

    const next: SearchResult[] = [
      ...chats.slice(0, MAX_PER_GROUP).map((c): SearchResult => ({
        kind: 'chat',
        key: `chat:${c.id}`,
        id: c.id,
        title: c.name,
        subtitle: agents.find((a) => a.id === c.agentId)?.name,
      })),
      ...channels.slice(0, MAX_PER_GROUP).map((c): SearchResult => ({
        kind: 'channel',
        key: `channel:${c.id}`,
        id: c.id,
        title: c.name,
        subtitle: c.projectId ? projectName(c.projectId) : undefined,
      })),
      ...notes.slice(0, MAX_PER_GROUP).map(({ note, projectId }): SearchResult => ({
        kind: 'note',
        key: `note:${note.id}`,
        id: note.id,
        title: noteTitle(note),
        subtitle: projectName(projectId),
        projectId,
        note,
      })),
      ...files.slice(0, MAX_PER_GROUP).map((f): SearchResult => ({
        kind: 'file',
        key: `file:${f.id}`,
        id: f.id,
        title: f.name,
        subtitle: f.path,
        projectId: f.projectId,
      })),
    ];

    setResults(next);
    setActiveIndex(0);
    setSearching(false);
  }, []);

  // Debounce the query; the modal opening with an empty box does no work.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void runSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, open, runSearch]);

  // Each opening starts clean, and any in-flight query from the last opening
  // is invalidated rather than allowed to land on the fresh list.
  useEffect(() => {
    if (open) return;
    seqRef.current++;
    setQuery('');
    setResults([]);
    setActiveIndex(0);
    setSearching(false);
  }, [open]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  const groups = useMemo(
    () =>
      GROUPS.map((g) => ({ ...g, items: results.filter((r) => r.kind === g.kind) })).filter(
        (g) => g.items.length > 0
      ),
    [results]
  );

  const openResult = (result: SearchResult) => {
    const { setView } = useUIStore.getState();

    switch (result.kind) {
      case 'chat':
        void useConversationsStore.getState().switchChat(result.id);
        setView('chats');
        break;
      case 'channel':
        void useConversationsStore.getState().switchChannel(result.id);
        setView('channels');
        break;
      case 'note': {
        const projectStore = useProjectStore.getState();
        if (projectStore.currentProjectId !== result.projectId) {
          void projectStore.switchProject(result.projectId);
        }
        setView('notes');
        projectStore.openNoteModal(result.note);
        break;
      }
      case 'file': {
        const projectStore = useProjectStore.getState();
        if (projectStore.currentProjectId !== result.projectId) {
          void projectStore.switchProject(result.projectId);
        }
        // No per-file surface exists; the project's file list is the destination.
        setView('files');
        break;
      }
    }

    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const result = results[activeIndex];
      if (result) openResult(result);
    }
  };

  const trimmed = query.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] p-0 gap-0" onKeyDown={handleKeyDown}>
        <DialogTitle className="sr-only">Search Everything</DialogTitle>
        <DialogDescription className="sr-only">
          Search across chats, channels, notes, and files.
        </DialogDescription>

        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats, channels, notes, and files…"
            aria-label="Search everything"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="global-search-results"
            aria-activedescendant={results[activeIndex] ? `global-search-${results[activeIndex].key}` : undefined}
            className="border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {searching && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
        </div>

        <div
          ref={listRef}
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="max-h-[360px] overflow-y-auto py-2"
        >
          {!trimmed && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Start typing to search.
            </p>
          )}

          {trimmed && !searching && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results for “{trimmed}”.
            </p>
          )}

          {groups.map((group) => (
            <div key={group.kind} className="mb-1">
              <div className="px-4 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </div>
              {group.items.map((item) => {
                const index = results.indexOf(item);
                const active = index === activeIndex;
                return (
                  <button
                    key={item.key}
                    id={`global-search-${item.key}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-result-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => openResult(item)}
                    className={cn(
                      'flex w-full items-center gap-2 px-4 py-2 text-left text-sm',
                      active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                    )}
                  >
                    <group.Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{item.title}</span>
                    {item.subtitle && (
                      <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                        {item.subtitle}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
