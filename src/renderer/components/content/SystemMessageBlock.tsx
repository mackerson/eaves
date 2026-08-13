import { TriangleAlert, Globe, Brain, MessageSquareText, StickyNote, Info } from 'lucide-react';

interface SystemMessageBlockProps {
  content: string;
  metadata?: {
    browsing?: boolean;
    error?: boolean;
    reasoningText?: boolean;
    reasoning_summary?: boolean;
    custom_instructions?: boolean;
    label?: string;
    result?: any;
  };
  className?: string;
}

/**
 * Renders system messages with distinctive styling
 * Used for web browsing results, system errors, tool outputs, etc.
 */
export function SystemMessageBlock({ content, metadata, className = '' }: SystemMessageBlockProps) {
  const isBrowsing = metadata?.browsing || false;
  const isError = metadata?.error || false;
  const isReasoning = metadata?.reasoningText || false;
  const isReasoningSummary = metadata?.reasoning_summary || false;
  const isCustomInstructions = metadata?.custom_instructions || false;

  // Determine icon and styling based on message type
  const getIcon = () => {
    if (isError) return <TriangleAlert size={20} />;
    if (isBrowsing) return <Globe size={20} />;
    if (isReasoning) return <Brain size={20} />;
    if (isReasoningSummary) return <MessageSquareText size={20} />;
    if (isCustomInstructions) return <StickyNote size={20} />;
    return <Info size={20} />;
  };

  const getBorderColor = () => {
    if (isError) return 'border-status-error';
    if (isBrowsing) return 'border-accent-primary';
    if (isReasoning || isReasoningSummary) return 'border-purple-500/30';
    if (isCustomInstructions) return 'border-blue-500/30';
    return 'border-border-secondary';
  };

  const getBgColor = () => {
    if (isError) return 'bg-status-error/10';
    if (isBrowsing) return 'bg-accent-primary/5';
    if (isReasoning || isReasoningSummary) return 'bg-purple-500/5';
    if (isCustomInstructions) return 'bg-blue-500/5';
    return 'bg-bg-tertiary';
  };

  const getTextColor = () => {
    if (isError) return 'text-status-error';
    if (isBrowsing) return 'text-accent-primary';
    if (isReasoning || isReasoningSummary) return 'text-purple-400';
    if (isCustomInstructions) return 'text-blue-400';
    return 'text-text-secondary';
  };

  const getLabel = () => {
    if (metadata?.label) return metadata.label;
    if (isError) return 'System Error';
    if (isBrowsing) return 'Web Search Result';
    if (isReasoning) return 'Internal Reasoning';
    if (isReasoningSummary) return 'Reasoning Summary';
    if (isCustomInstructions) return 'Custom Instructions';
    return 'System Message';
  };

  return (
    <div
      className={`system-message-block p-4 rounded-md border ${getBorderColor()} ${getBgColor()} ${className}`}
    >
      <div className="flex gap-3">
        <div className="flex-shrink-0 text-xl">{getIcon()}</div>
        <div className="flex-1">
          <div className={`text-sm font-medium mb-1 ${getTextColor()}`}>
            {getLabel()}
          </div>
          <div className="text-text-primary text-sm whitespace-pre-wrap break-words">
            {content}
          </div>

          {/* Show additional result data if available */}
          {metadata?.result && (
            <div className="mt-3 text-xs text-text-tertiary">
              <details className="cursor-pointer">
                <summary className="hover:text-text-secondary">View raw result</summary>
                <pre className="mt-2 p-2 bg-bg-secondary rounded border border-border-secondary overflow-x-auto overflow-y-hidden">
                  {JSON.stringify(metadata.result, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
