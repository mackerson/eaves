import React, { memo } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';

interface ToolCallDisplayProps {
  toolName: string;
  args?: any;
  result?: any;
  error?: any;
  status: 'running' | 'completed' | 'error';
}

export const ToolCallDisplay = memo(function ToolCallDisplay({ toolName, args, result, error, status }: ToolCallDisplayProps) {
  const [isExpanded, setIsExpanded] = React.useState(status === 'error');

  const hasDetails = args && Object.keys(args).length > 0;
  const hasResult = result !== undefined;
  const hasError = error !== undefined;

  return (
    <div className={`border rounded-lg p-3 my-2 ${
      status === 'error' ? 'bg-red-500/10 border-red-500/50' : 'bg-accent/50 border-border'
    }`}>
      <div className="flex items-center gap-2">
        {(hasDetails || hasResult || hasError) && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-muted-foreground hover:text-foreground"
          >
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        )}
        <Wrench size={16} className={status === 'error' ? 'text-red-500' : 'app-text-primary'} />
        <span className="font-medium text-sm">
          {status === 'running' && 'Using tool: '}
          {status === 'completed' && 'Tool completed: '}
          {status === 'error' && 'Tool failed: '}
          <code className={status === 'error' ? 'text-red-500' : 'app-text-primary'}>{toolName}</code>
        </span>
        {status === 'running' && (
          <div className="ml-2 flex items-center gap-1">
            <div className="w-1.5 h-1.5 app-bg-primary rounded-full animate-pulse" />
            <div className="w-1.5 h-1.5 app-bg-primary rounded-full animate-pulse delay-75" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 app-bg-primary rounded-full animate-pulse delay-150" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-2 text-xs">
          {hasDetails && (
            <div>
              <div className="text-muted-foreground font-semibold mb-1">Arguments:</div>
              <pre className="bg-background/50 p-2 rounded border border-border overflow-x-auto overflow-y-hidden">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {hasResult && (
            <div>
              <div className="text-muted-foreground font-semibold mb-1">Result:</div>
              <pre className="bg-background/50 p-2 rounded border border-border overflow-x-auto max-h-40 overflow-y-auto">
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <div className="text-red-500 font-semibold mb-1">Error:</div>
              <pre className="bg-background/50 p-2 rounded border border-red-500/50 overflow-x-auto max-h-40 overflow-y-auto text-red-400">
                {typeof error === 'string' ? error : JSON.stringify(error, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
