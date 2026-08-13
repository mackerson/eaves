import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Highlight, themes } from 'prism-react-renderer';
import { cn } from '@/lib/utils';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  truncate?: boolean;
  maxLength?: number;
}

export function MarkdownRenderer({
  content,
  className,
  truncate = false,
  maxLength = 200,
}: MarkdownRendererProps) {
  // For truncated preview, strip to plain text first
  const displayContent = truncate
    ? content.slice(0, maxLength) + (content.length > maxLength ? '...' : '')
    : content;

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        // Custom styling to match our theme
        '[&_h1]:text-xl [&_h1]:font-bold [&_h1]:mb-2 [&_h1]:mt-0',
        '[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3',
        '[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2',
        '[&_p]:mb-2 [&_p]:leading-relaxed',
        '[&_ul]:mb-2 [&_ul]:pl-4 [&_ul]:list-disc',
        '[&_ol]:mb-2 [&_ol]:pl-4 [&_ol]:list-decimal',
        '[&_li]:mb-0.5',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/30 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
        '[&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono',
        '[&_pre]:bg-transparent [&_pre]:p-0 [&_pre]:m-0',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_hr]:my-4 [&_hr]:border-border',
        '[&_table]:border-collapse [&_table]:w-full',
        '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:bg-muted/50',
        '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        '[&_img]:max-w-full [&_img]:rounded',
        // Task list styling
        '[&_input[type=checkbox]]:mr-1.5',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ node, className, children, ...props }) {
            const match = /language-(\w+)/.test(className || '')
              ? className?.match(/language-(\w+)/)
              : null;
            const isInline = !match && !String(children).includes('\n');

            if (isInline) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }

            const code = String(children).replace(/\n$/, '');
            const lang = match ? match[1] : 'text';
            return (
              <Highlight theme={themes.oneDark} code={code} language={lang}>
                {({ style, tokens, getLineProps, getTokenProps }) => (
                  <div
                    style={{
                      ...style,
                      margin: '0.5rem 0',
                      borderRadius: '0.375rem',
                      fontSize: '0.875rem',
                      padding: '1rem',
                      overflowX: 'auto',
                    }}
                  >
                    <pre style={{ margin: 0 }}>
                      {tokens.map((line, i) => (
                        <div key={i} {...getLineProps({ line })}>
                          {line.map((token, key) => (
                            <span key={key} {...getTokenProps({ token })} />
                          ))}
                        </div>
                      ))}
                    </pre>
                  </div>
                )}
              </Highlight>
            );
          },
        }}
      >
        {displayContent}
      </ReactMarkdown>
    </div>
  );
}
