import { memo } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownBlockProps {
  content: string;
  className?: string;
}

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS: Components = {
  a: ({ node, ...props }) => (
    <a
      {...props}
      className="text-accent-primary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
    />
  ),
  code: ({ node, inline, className, children, ...props }: any) => {
    if (inline) {
      return (
        <code
          className="px-1.5 py-0.5 bg-bg-tertiary border border-border-secondary rounded text-sm font-mono text-accent-primary"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ node, children, ...props }) => (
    <pre className="bg-bg-tertiary border border-border-secondary rounded-md p-3 overflow-x-auto overflow-y-hidden my-2" {...props}>
      {children}
    </pre>
  ),
  h1: ({ node, ...props }) => (
    <h1 className="text-2xl font-bold mt-4 mb-2 text-text-primary" {...props} />
  ),
  h2: ({ node, ...props }) => (
    <h2 className="text-xl font-bold mt-3 mb-2 text-text-primary" {...props} />
  ),
  h3: ({ node, ...props }) => (
    <h3 className="text-lg font-semibold mt-3 mb-1 text-text-primary" {...props} />
  ),
  h4: ({ node, ...props }) => (
    <h4 className="text-base font-semibold mt-2 mb-1 text-text-primary" {...props} />
  ),
  h5: ({ node, ...props }) => (
    <h5 className="text-sm font-semibold mt-2 mb-1 text-text-primary" {...props} />
  ),
  h6: ({ node, ...props }) => (
    <h6 className="text-sm font-semibold mt-2 mb-1 text-text-secondary" {...props} />
  ),
  p: ({ node, ...props }) => (
    <p className="mb-2 last:mb-0 text-text-primary leading-relaxed" {...props} />
  ),
  ul: ({ node, ...props }) => (
    <ul className="list-disc list-inside mb-2 space-y-1 text-text-primary" {...props} />
  ),
  ol: ({ node, ...props }) => (
    <ol className="list-decimal list-inside mb-2 space-y-1 text-text-primary" {...props} />
  ),
  li: ({ node, ...props }) => (
    <li className="text-text-primary" {...props} />
  ),
  blockquote: ({ node, ...props }) => (
    <blockquote className="border-l-4 border-accent-primary pl-4 italic my-2 text-text-secondary" {...props} />
  ),
  table: ({ node, ...props }) => (
    <div className="overflow-x-auto overflow-y-hidden my-2">
      <table className="min-w-full border border-border-primary" {...props} />
    </div>
  ),
  thead: ({ node, ...props }) => (
    <thead className="bg-bg-tertiary" {...props} />
  ),
  tbody: ({ node, ...props }) => (
    <tbody {...props} />
  ),
  tr: ({ node, ...props }) => (
    <tr className="border-b border-border-secondary" {...props} />
  ),
  th: ({ node, ...props }) => (
    <th className="px-4 py-2 text-left font-semibold text-text-primary border-r border-border-secondary last:border-r-0" {...props} />
  ),
  td: ({ node, ...props }) => (
    <td className="px-4 py-2 text-text-primary border-r border-border-secondary last:border-r-0" {...props} />
  ),
  hr: ({ node, ...props }) => (
    <hr className="my-4 border-border-primary" {...props} />
  ),
  strong: ({ node, ...props }) => (
    <strong className="font-bold text-text-primary" {...props} />
  ),
  em: ({ node, ...props }) => (
    <em className="italic text-text-primary" {...props} />
  ),
  del: ({ node, ...props }) => (
    <del className="line-through text-text-secondary" {...props} />
  ),
};

/**
 * Renders markdown text with GitHub-flavored markdown support
 * Supports: headers, lists, links, bold, italic, strikethrough, tables, blockquotes, inline code
 */
export const MarkdownBlock = memo(function MarkdownBlock({ content, className = '' }: MarkdownBlockProps) {
  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
