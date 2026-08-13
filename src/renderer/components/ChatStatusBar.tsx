import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { MessageMetrics } from '@/types';
import { useConversationsStore } from '@/stores';
import { getContextWindow, calculateCost } from '../../shared/pricing';

interface ChatStatusBarProps {
  /** All messages in the current chat (to compute session totals) */
  messages: Array<{ senderType: string; metrics?: MessageMetrics }>;
  /** The agent's provider (for cost fallback calculation) */
  provider?: string;
  /** The agent's model name (for context window lookup and cost fallback) */
  model?: string;
  /** Whether a stream is currently active */
  isStreaming?: boolean;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toString();
}

function formatTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function ChatStatusBar({ messages, provider, model, isStreaming }: ChatStatusBarProps) {
  const isCompacting = useConversationsStore((s) => s.isCompacting);
  const sessionStats = useMemo(() => {
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalCost = 0;
    let totalTime = 0;
    let messageCount = 0;
    let lastPromptTokens = 0;
    let hasCost = false;
    // OpenRouter served backend + whether its prompt cache was warm on the most
    // recent turn (cachedTokens > 0), for the sticky-provider indicator.
    let lastServedProvider: string | undefined;
    let lastCachedTokens = 0;

    let unpricedMessages = 0;
    for (const msg of messages) {
      if (msg.senderType !== 'agent' || !msg.metrics) continue;
      messageCount++;
      const promptTok = msg.metrics.inputTokens || 0;
      const completionTok = msg.metrics.outputTokens || 0;
      totalPromptTokens += promptTok;
      totalCompletionTokens += completionTok;
      totalTime += msg.metrics.timeToComplete || 0;

      if (msg.metrics.cost != null) {
        totalCost += msg.metrics.cost;
        hasCost = true;
      } else if (provider && model && (promptTok > 0 || completionTok > 0)) {
        // Fallback: calculate cost from tokens for older messages without stored cost
        const estimatedCost = calculateCost(provider, model, promptTok, completionTok);
        if (estimatedCost !== null) {
          totalCost += estimatedCost;
          hasCost = true;
        } else {
          // No price for this model. Counted, not silently dropped — a sum
          // that quietly omits turns reads as a complete total.
          unpricedMessages++;
        }
      }
      lastPromptTokens = promptTok;
      if (msg.metrics.servedProvider) {
        lastServedProvider = msg.metrics.servedProvider;
        lastCachedTokens = msg.metrics.cachedTokens ?? 0;
      }
    }

    return {
      totalPromptTokens,
      totalCompletionTokens,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalCost,
      hasCost,
      unpricedMessages,
      totalTime,
      messageCount,
      lastPromptTokens,
      lastServedProvider,
      lastCachedTokens,
    };
  }, [messages, provider, model]);

  const contextWindow = model ? getContextWindow(model) : null;
  const contextUsed = sessionStats.lastPromptTokens;
  const contextPct = contextWindow ? Math.round((contextUsed / contextWindow) * 100) : null;

  // Don't render if there are no agent messages yet
  if (sessionStats.messageCount === 0 && !isStreaming && !isCompacting) return null;

  return (
    <div
      className="px-5 py-1.5 flex items-center gap-4 text-xs text-muted-foreground border-b border-border"
      style={{ backgroundColor: 'var(--bg-tertiary)' }}
    >
      {/* Compaction indicator — summarizing old history before the turn */}
      {isCompacting && (
        <div className="flex items-center gap-1.5" title="Summarizing older messages to keep the context small">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
          </span>
          <span className="text-amber-400 font-medium">Compacting…</span>
        </div>
      )}

      {/* Streaming indicator */}
      {isStreaming && (
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span
              className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
              style={{ backgroundColor: 'var(--accent-primary)' }}
            />
            <span
              className="relative inline-flex rounded-full h-2 w-2"
              style={{ backgroundColor: 'var(--accent-primary)' }}
            />
          </span>
          <span className="font-medium" style={{ color: 'var(--accent-primary)' }}>Streaming</span>
        </div>
      )}

      {/* Session token totals */}
      <div className="flex items-center gap-1.5" title={`Prompt: ${formatTokens(sessionStats.totalPromptTokens)} | Completion: ${formatTokens(sessionStats.totalCompletionTokens)}`}>
        <span>Tokens</span>
        <Badge variant="secondary" className="text-xs h-5 px-1.5 font-mono">
          {formatTokens(sessionStats.totalTokens)}
        </Badge>
      </div>

      {/* Cost. Shown whenever there are billable turns — including when none of
          them can be priced, because a missing row reads as "free" rather than
          "unknown". A partial total is marked with a + so it is never mistaken
          for the whole bill. */}
      {(sessionStats.hasCost || sessionStats.unpricedMessages > 0) && (
        <div
          className="flex items-center gap-1.5"
          title={
            sessionStats.unpricedMessages > 0
              ? `${sessionStats.unpricedMessages} turn(s) have no price for this model — set per-agent pricing in the agent editor to include them.`
              : 'Estimated session cost'
          }
        >
          <span>Cost</span>
          <Badge variant="secondary" className="text-xs h-5 px-1.5 font-mono">
            {sessionStats.hasCost
              ? `${formatCost(sessionStats.totalCost)}${sessionStats.unpricedMessages > 0 ? '+' : ''}`
              : 'unpriced'}
          </Badge>
        </div>
      )}

      {/* OpenRouter served backend + prompt-cache warmth (sticky-provider pin) */}
      {sessionStats.lastServedProvider && (
        <div
          className="flex items-center gap-1.5"
          title={
            sessionStats.lastCachedTokens > 0
              ? `Pinned to ${sessionStats.lastServedProvider} — prompt cache warm (${formatTokens(sessionStats.lastCachedTokens)} cached tokens last turn)`
              : `Served by ${sessionStats.lastServedProvider} — cache cold last turn`
          }
        >
          <span>Provider</span>
          <Badge variant="secondary" className="text-xs h-5 px-1.5 font-mono flex items-center gap-1">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                sessionStats.lastCachedTokens > 0 ? 'bg-green-500' : 'bg-muted-foreground/50'
              }`}
            />
            {sessionStats.lastServedProvider}
          </Badge>
        </div>
      )}

      {/* Context window usage */}
      {contextPct !== null && contextWindow && (
        <div className="flex items-center gap-1.5" title={`Last prompt used ${formatTokens(contextUsed)} of ${formatTokens(contextWindow)} context window`}>
          <span>Context</span>
          <div className="flex items-center gap-1">
            <div className="w-16 h-1.5 app-bg-secondary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  contextPct > 80 ? 'bg-red-500' : contextPct > 50 ? 'bg-yellow-500' : 'bg-green-500'
                }`}
                style={{ width: `${Math.min(contextPct, 100)}%` }}
              />
            </div>
            <span className="font-mono text-[10px]">{contextPct}%</span>
          </div>
        </div>
      )}

      {/* Total time */}
      {sessionStats.totalTime > 0 && (
        <div className="flex items-center gap-1.5" title="Total generation time this session">
          <span>Time</span>
          <Badge variant="secondary" className="text-xs h-5 px-1.5 font-mono">
            {formatTime(sessionStats.totalTime)}
          </Badge>
        </div>
      )}

      {/* Response count */}
      <div className="flex items-center gap-1.5 ml-auto" title="Number of agent responses">
        <span className="font-mono text-[10px]">{sessionStats.messageCount} responses</span>
      </div>
    </div>
  );
}
