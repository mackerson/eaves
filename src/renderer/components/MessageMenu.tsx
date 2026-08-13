import { memo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  HelpCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { MessageMetrics } from '@/types';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

interface MessageMenuProps {
  messageId: string;
  content: string;
  senderType: 'human' | 'agent';
  metrics?: MessageMetrics;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  onRegenerate?: () => void;
}

export const MessageMenu = memo(function MessageMenu({
  messageId: _messageId,
  content,
  senderType,
  metrics,
  onEdit,
  onDelete,
  onCopy,
  onRegenerate,
}: MessageMenuProps) {
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    if (onCopy) onCopy();
  };

  const formatTime = (ms?: number) => {
    if (!ms) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatTokens = (tokens?: number) => {
    if (tokens === null || tokens === undefined) return 'N/A';
    return tokens.toLocaleString();
  };

  const getFinishReasonDisplay = (reason?: string) => {
    const displays: Record<string, { Icon: typeof Check; label: string }> = {
      'stop': { Icon: Check, label: 'Natural stop' },
      'length': { Icon: AlertTriangle, label: 'Token limit' },
      'error': { Icon: XCircle, label: 'Error' },
      'tool_use': { Icon: Wrench, label: 'Tool use' },
      'unknown': { Icon: HelpCircle, label: 'Unknown' },
    };
    const match = displays[reason ?? 'unknown'];
    if (!match) return <span>{reason}</span>;
    const { Icon, label } = match;
    return (
      <span className="inline-flex items-center gap-1">
        <Icon className="h-3 w-3" />
        {label}
      </span>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          aria-label="Message actions"
        >
          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/* Metrics section (for agent messages) */}
        {senderType === 'agent' && metrics && (
          <>
            <DropdownMenuLabel>Message Metrics</DropdownMenuLabel>
            <div className="px-2 py-1.5 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Model:</span>
                <span className="font-mono text-xs">{metrics.model || 'N/A'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time:</span>
                <span className="font-mono text-xs">{formatTime(metrics.timeToComplete)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tokens:</span>
                <span className="font-mono text-xs">
                  {formatTokens(metrics.inputTokens)} + {formatTokens(metrics.outputTokens)} = {formatTokens(metrics.totalTokens)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Finish:</span>
                <span className="text-xs">{getFinishReasonDisplay(metrics.finishReason)}</span>
              </div>
            </div>
            {metrics.requestInfo && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Request Info</DropdownMenuLabel>
                <div className="px-2 py-1.5 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Context:</span>
                    <span className="font-mono text-xs">{formatTokens(metrics.requestInfo.contextWindow)} ({metrics.requestInfo.sizeClass})</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">System:</span>
                    <span className="font-mono text-xs">~{formatTokens(metrics.requestInfo.systemPromptTokens)} tokens</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Messages:</span>
                    <span className="font-mono text-xs">
                      {metrics.requestInfo.messagesSent}
                      {metrics.requestInfo.messagesSent < metrics.requestInfo.messagesTotal && (
                        <span className="text-yellow-500"> / {metrics.requestInfo.messagesTotal}</span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tools:</span>
                    <span className="font-mono text-xs">
                      {metrics.requestInfo.toolsIncluded ? metrics.requestInfo.toolCount : 'stripped'}
                    </span>
                  </div>
                  {metrics.requestInfo.systemPrompt && (
                    <button
                      className="w-full text-left text-xs mt-1 cursor-pointer hover:underline inline-flex items-center gap-1"
                      style={{ color: 'var(--accent-primary)' }}
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowSystemPrompt(!showSystemPrompt); }}
                    >
                      {showSystemPrompt ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {showSystemPrompt ? 'Hide System Prompt' : 'Show System Prompt'}
                    </button>
                  )}
                </div>
                {showSystemPrompt && metrics.requestInfo.systemPrompt && (
                  <div className="px-2 pb-1.5">
                    <pre className="text-[10px] leading-tight text-muted-foreground bg-secondary/50 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                      {metrics.requestInfo.systemPrompt}
                    </pre>
                    <button
                      className="text-[10px] mt-1 cursor-pointer hover:underline"
                      style={{ color: 'var(--accent-primary)' }}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        navigator.clipboard.writeText(metrics.requestInfo!.systemPrompt!);
                      }}
                    >
                      Copy to clipboard
                    </button>
                  </div>
                )}
              </>
            )}
            <DropdownMenuSeparator />
          </>
        )}

        {/* Actions */}
        <DropdownMenuLabel>Actions</DropdownMenuLabel>
        <DropdownMenuItem onClick={handleCopy}>
          <Copy className="h-4 w-4 mr-2" />
          <span>Copy</span>
        </DropdownMenuItem>
        {senderType === 'agent' && onRegenerate && (
          <DropdownMenuItem onClick={onRegenerate}>
            <RefreshCw className="h-4 w-4 mr-2" />
            <span>Regenerate</span>
          </DropdownMenuItem>
        )}
        {senderType === 'human' && onEdit && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="h-4 w-4 mr-2" />
            <span>Edit</span>
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem onClick={onDelete} className="text-destructive">
            <Trash2 className="h-4 w-4 mr-2" />
            <span>Delete</span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
