import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { diffLines, collapseUnchanged, hasChanges } from '@/../shared/textDiff';

/**
 * Reading the code, and reading what changed in it.
 *
 * A dialog rather than an expander inside the bench rail, because the rail is
 * 320px wide and code is not. Approving code you have not read is the failure
 * this whole tier exists to prevent, so the surface for reading it should not
 * be the most cramped one in the app.
 *
 * The diff tab is the half that matters on the second pass. An agent rewrites
 * a draft in place — a fix, a renamed export, a permission quietly added — and
 * without this every revision resets the reader to the top of the file.
 */

interface DraftFile { path: string; content: string }

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  files: DraftFile[];
  /** The version this one replaced, if the agent has rewritten it. */
  previous?: DraftFile[];
}

type Tab = 'code' | 'changes';

/** Files as the diff sees them: added, removed, or possibly-changed. */
function pairFiles(files: DraftFile[], previous: DraftFile[]) {
  const paths = [...new Set([...previous.map(f => f.path), ...files.map(f => f.path)])].sort();
  return paths.map(path => ({
    path,
    before: previous.find(f => f.path === path)?.content,
    after: files.find(f => f.path === path)?.content,
  }));
}

function DiffBody({ before, after }: { before: string; after: string }) {
  const rows = useMemo(() => collapseUnchanged(diffLines(before, after)), [before, after]);
  return (
    <pre className="text-[11px] leading-relaxed font-mono overflow-x-auto">
      {rows.map((row, index) => {
        if (row.op === 'skip') {
          return (
            <div key={index} className="text-muted-foreground/60 px-2 py-1 select-none">
              ⋯ {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </div>
          );
        }
        const tone =
          row.op === 'added' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : row.op === 'removed' ? 'bg-red-500/10 text-red-700 dark:text-red-300'
          : '';
        const sign = row.op === 'added' ? '+' : row.op === 'removed' ? '-' : ' ';
        return (
          <div key={index} className={`px-2 whitespace-pre-wrap break-words ${tone}`}>
            <span className="select-none opacity-50">{sign} </span>{row.text}
          </div>
        );
      })}
    </pre>
  );
}

export function DraftCodeDialog({ open, onOpenChange, name, files, previous }: Props) {
  const [tab, setTab] = useState<Tab>('code');
  const [openFile, setOpenFile] = useState<string | null>(null);

  const canDiff = !!previous?.length;
  const active = tab === 'changes' && canDiff ? 'changes' : 'code';
  const pairs = useMemo(
    () => (previous ? pairFiles(files, previous) : []),
    [files, previous],
  );
  const changed = pairs.filter(
    pair => pair.before !== pair.after,
  );

  const selected = openFile ?? files[0]?.path ?? null;
  const body = files.find(file => file.path === selected)?.content ?? '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1 border-b border-border -mt-2">
          <button
            className={`text-sm px-3 py-1.5 border-b-2 ${active === 'code' ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}
            onClick={() => setTab('code')}
          >
            Code
          </button>
          {canDiff && (
            <button
              className={`text-sm px-3 py-1.5 border-b-2 ${active === 'changes' ? 'border-foreground' : 'border-transparent text-muted-foreground'}`}
              onClick={() => setTab('changes')}
            >
              Changes {changed.length > 0 && <span className="text-xs">({changed.length})</span>}
            </button>
          )}
        </div>

        {active === 'code' ? (
          <>
            <div className="flex gap-1 overflow-x-auto">
              {files.map((file) => (
                <button
                  key={file.path}
                  onClick={() => setOpenFile(file.path)}
                  className={`text-xs px-2 py-1 rounded whitespace-nowrap ${
                    selected === file.path
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50'
                  }`}
                >
                  {file.path}
                </button>
              ))}
            </div>
            <pre className="text-[11px] leading-relaxed font-mono max-h-[60vh] overflow-auto p-3 rounded bg-muted/40 whitespace-pre-wrap break-words">
              {body}
            </pre>
          </>
        ) : (
          <div className="max-h-[60vh] overflow-auto space-y-4">
            {changed.length === 0 ? (
              <p className="text-sm text-muted-foreground p-3">
                The files are identical to the previous version.
              </p>
            ) : (
              changed.map((pair) => (
                <div key={pair.path}>
                  <p className="text-xs font-medium mb-1">
                    {pair.path}
                    {pair.before === undefined && <span className="text-emerald-500"> — new file</span>}
                    {pair.after === undefined && <span className="text-red-500"> — deleted</span>}
                  </p>
                  <div className="rounded bg-muted/40 py-1">
                    <DiffBody before={pair.before ?? ''} after={pair.after ?? ''} />
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Exported for the bench, which decides whether the Changes tab is worth offering. */
export function draftHasChanges(files: DraftFile[], previous?: DraftFile[]): boolean {
  if (!previous?.length) return false;
  return pairFiles(files, previous).some(
    pair => pair.before !== pair.after && hasChanges(diffLines(pair.before ?? '', pair.after ?? '')),
  );
}
