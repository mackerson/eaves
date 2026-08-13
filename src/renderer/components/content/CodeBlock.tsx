import { useState } from 'react';
import { Highlight, themes } from 'prism-react-renderer';

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  className?: string;
  metadata?: {
    execution?: boolean;
    execution_output?: boolean;
  };
}

/**
 * Renders syntax-highlighted code blocks with copy-to-clipboard functionality
 */
export function CodeBlock({
  code,
  language = 'plaintext',
  showLineNumbers = false,
  className = '',
  metadata
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy code:', err);
    }
  };

  // Determine if this is execution-related code
  const isExecution = metadata?.execution || false;
  const isExecutionOutput = metadata?.execution_output || false;

  return (
    <div className={`code-block-container relative group ${className}`}>
      {/* Header with language and copy button */}
      <div className="flex items-center justify-between px-4 py-2 bg-bg-tertiary border-b border-border-secondary rounded-t-md">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-text-secondary uppercase">
            {isExecution ? `${language} (execution)` : isExecutionOutput ? 'output' : language}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="px-2 py-1 text-xs bg-bg-secondary hover:bg-bg-hover border border-border-primary rounded transition-colors"
          title="Copy code"
        >
          {copied ? '✓ Copied!' : 'Copy'}
        </button>
      </div>

      {/* Code content with syntax highlighting */}
      <Highlight
        theme={themes.vsDark}
        code={code.trim()}
        language={language}
      >
        {({ className: highlightClassName, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${highlightClassName} p-4 overflow-x-auto overflow-y-hidden text-sm rounded-b-md`}
            style={{
              ...style,
              margin: 0,
              backgroundColor: isExecutionOutput ? '#1a1a1a' : style.backgroundColor,
            }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {showLineNumbers && (
                  <span className="inline-block w-8 text-right mr-4 text-text-tertiary select-none">
                    {i + 1}
                  </span>
                )}
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
