import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, FileText, FolderOpen, RefreshCw } from 'lucide-react';

interface LogViewerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LogFileEntry {
  path: string;
  name: string;
  size: number;
  modified: number;
}

/**
 * Mirrors MAX_LOG_READ_BYTES in src/main/ipc/logs.ts. Only used to tell the
 * user how much of the file they are *not* seeing; the main process is the
 * authority on where the cut actually falls, and `truncated` is what we trust
 * to decide whether a cut happened at all.
 */
const TAIL_BYTES = 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function LogViewerModal({ open, onOpenChange }: LogViewerModalProps) {
  const [files, setFiles] = useState<LogFileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  const loadFiles = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const result = await window.electron.getLogFiles();
      // `get-log-files` is wrapped in ipcResult, so a throw inside the handler
      // comes back as an error envelope rather than an array. The declared type
      // doesn't admit that shape, hence the structural check.
      if (!Array.isArray(result)) {
        const envelope = result as { error?: string };
        setFiles([]);
        setListError(envelope?.error || 'Failed to list log files');
        return;
      }
      const sorted = result.slice().sort((a, b) => b.modified - a.modified);
      setFiles(sorted);
      setSelected((current) =>
        current && sorted.some((f) => f.path === current) ? current : sorted[0]?.path ?? null
      );
    } catch (error) {
      setFiles([]);
      setListError(error instanceof Error ? error.message : 'Failed to list log files');
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Re-list on every open: logs rotate and grow while the modal is closed.
  useEffect(() => {
    if (open) void loadFiles();
  }, [open, loadFiles]);

  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;

    setLoadingContent(true);
    setReadError(null);
    window.electron
      .readLogFile(selected)
      .then((result) => {
        if (cancelled) return;
        if (!result?.success) {
          setContent('');
          setTruncated(false);
          setFileSize(0);
          setReadError(result?.error || 'Failed to read log file');
          return;
        }
        setContent(result.content ?? '');
        setTruncated(result.truncated === true);
        setFileSize(result.size ?? 0);
      })
      .catch((error) => {
        if (cancelled) return;
        setContent('');
        setTruncated(false);
        setFileSize(0);
        setReadError(error instanceof Error ? error.message : 'Failed to read log file');
      })
      .finally(() => {
        if (!cancelled) setLoadingContent(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, selected]);

  // We are handed the tail of the file, so the newest lines are at the bottom —
  // land the user there rather than at the arbitrary line the cut started on.
  useEffect(() => {
    if (content && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content]);

  const handleOpenDirectory = () => {
    void window.electron.openLogDir().catch(() => {
      // Nothing actionable in the renderer; the shell either opened it or not.
    });
  };

  const elidedBytes = Math.max(0, fileSize - TAIL_BYTES);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Application Logs</DialogTitle>
          <DialogDescription>
            Diagnostic logs written by Eaves. Only the end of each file is loaded.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 flex gap-4">
          {/* File list */}
          <div className="w-64 shrink-0 border rounded-md overflow-y-auto" data-testid="log-file-list">
            {loadingList ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : listError ? (
              <div className="p-4 text-sm text-destructive">{listError}</div>
            ) : files.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No log files found.
              </div>
            ) : (
              files.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  onClick={() => setSelected(file.path)}
                  className={`w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-accent/50 ${
                    selected === file.path ? 'bg-accent' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 text-sm truncate">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{file.name}</span>
                  </div>
                  <div className="text-xs text-muted-foreground pl-6">
                    {formatBytes(file.size)} · {new Date(file.modified).toLocaleString()}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Contents */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            {truncated && (
              <div
                role="status"
                data-testid="log-truncation-notice"
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400"
              >
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Showing only the last {formatBytes(TAIL_BYTES)} of this {formatBytes(fileSize)} file
                  {elidedBytes > 0 && <> — roughly {formatBytes(elidedBytes)} of earlier entries are not shown</>}
                  . Open the log directory to read the whole file.
                </span>
              </div>
            )}

            {!truncated && !readError && selected && !loadingContent && (
              <div className="text-xs text-muted-foreground px-1">
                Complete file · {formatBytes(fileSize)}
              </div>
            )}

            {/* A single <pre> holding one ~1MB text node, deliberately not
                virtualized. Virtualizing means splitting the string into ~10k
                lines and mounting an element per visible row; the browser
                lays out one unwrapped text node far more cheaply than that,
                and the split itself would cost more than it saves. The rule
                this respects is: never build the view by repeated string
                concatenation or per-line elements — hand the DOM the string
                the IPC returned, once. Revisit only if the main-process cap
                (MAX_LOG_READ_BYTES) is raised well past 1MB. */}
            <div
              ref={contentRef}
              data-testid="log-content"
              className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/30 p-3"
            >
              {loadingContent ? (
                <div className="text-sm text-muted-foreground">Loading log…</div>
              ) : readError ? (
                <div className="text-sm text-destructive">{readError}</div>
              ) : !selected ? (
                <div className="text-sm text-muted-foreground">Select a log file to view it.</div>
              ) : content.length === 0 ? (
                <div className="text-sm text-muted-foreground">This log file is empty.</div>
              ) : (
                <pre className="font-mono text-xs leading-relaxed whitespace-pre">{content}</pre>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleOpenDirectory}>
              <FolderOpen className="h-4 w-4 mr-2" />
              Open Log Directory
            </Button>
            <Button variant="outline" size="sm" onClick={() => void loadFiles()} disabled={loadingList}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
