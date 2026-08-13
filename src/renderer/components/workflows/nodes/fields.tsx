/**
 * Shared form primitives for workflow node config.
 *
 * Every field writes straight back to the graph via setNodes. The previous
 * inputs were uncontrolled `defaultValue` with no onChange, so edits looked
 * accepted and were silently discarded on save.
 *
 * The same components render in two places — inline inside a node on the canvas
 * and full-height in the inspector panel — so a field is defined once and the
 * `dense` flag only changes how much room it takes.
 */

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useReactFlow } from 'reactflow';
import { Highlight, themes } from 'prism-react-renderer';
import { Maximize2, X } from 'lucide-react';

/** Writer that merges one key into a node's data. */
export function useNodeFieldWriter(id: string) {
  const { setNodes } = useReactFlow();
  return useCallback(
    (field: string, value: unknown) => {
      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id ? { ...node, data: { ...node.data, [field]: value } } : node
        )
      );
    },
    [id, setNodes]
  );
}

interface FieldShellProps {
  label: string;
  children: ReactNode;
  help?: string;
  action?: ReactNode;
}

function FieldShell({ label, children, help, action }: FieldShellProps) {
  return (
    <div className="node-field">
      <label className="node-field-label">
        <span>{label}</span>
        {action}
      </label>
      {children}
      {help && <div className="node-help-text">{help}</div>}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  help?: string;
}

export function NodeTextField({ label, value, onChange, placeholder, help }: TextFieldProps) {
  return (
    <FieldShell label={label} help={help}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="node-input"
      />
    </FieldShell>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  help?: string;
}

export function NodeNumberField({ label, value, onChange, min, max, help }: NumberFieldProps) {
  return (
    <FieldShell label={label} help={help}>
      <input
        type="number"
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (!Number.isNaN(next)) onChange(next);
        }}
        min={min}
        max={max}
        className="node-input"
      />
    </FieldShell>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  help?: string;
}

export function NodeSelectField({ label, value, onChange, options, help }: SelectFieldProps) {
  return (
    <FieldShell label={label} help={help}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="node-input">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function NodeCheckboxField({ label, checked, onChange }: CheckboxFieldProps) {
  return (
    <div className="node-field">
      <label>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="node-checkbox"
        />
        <span style={{ marginLeft: '8px' }}>{label}</span>
      </label>
    </div>
  );
}

/**
 * Near-fullscreen editing surface. Long prompts and code are unreadable in a
 * node-sized box, and the node config panel can't grow past the canvas.
 */
function MaximizedEditor({
  title,
  value,
  onChange,
  onClose,
  language,
}: {
  title: string;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  language?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Portalled to the body on purpose. ReactFlow transforms its viewport, and a
  // transformed ancestor makes position:fixed resolve against that ancestor —
  // so rendering in place traps this inside the node's box and scales it with
  // the canvas zoom. Only nodes on the canvas hit that; the inspector does not,
  // which is exactly how it slipped through review.
  return createPortal(
    <div className="node-maximize-backdrop" onClick={onClose}>
      {/* A portal moves the DOM node but not the React tree, so events still
          bubble to the workflow node's handlers: dragging to select text would
          pan the node, and Delete would remove it. Stop them here. */}
      <div
        className="node-maximize-panel"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="node-maximize-header">
          <span>{title}</span>
          <button onClick={onClose} title="Close (Esc)" className="node-control-btn">
            <X size={14} />
          </button>
        </div>
        <div className="node-maximize-body">
          {language ? (
            <CodeSurface value={value} onChange={onChange} language={language} autoFocus />
          ) : (
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="node-maximize-textarea"
              autoFocus
            />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

interface TextAreaFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  /** Enables the maximize affordance. */
  title?: string;
}

export function NodeTextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  title,
}: TextAreaFieldProps) {
  const [maximized, setMaximized] = useState(false);

  return (
    <>
      <FieldShell
        label={label}
        action={
          <button
            type="button"
            className="node-control-btn"
            onClick={() => setMaximized(true)}
            title="Edit full screen"
          >
            <Maximize2 size={12} />
          </button>
        }
      >
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="node-textarea"
          rows={rows}
        />
      </FieldShell>
      {maximized && (
        <MaximizedEditor
          title={title || label}
          value={value}
          onChange={onChange}
          onClose={() => setMaximized(false)}
        />
      )}
    </>
  );
}

/**
 * Textarea with a syntax-highlighted layer painted behind it. Uses
 * prism-react-renderer, already a dependency for message code blocks, rather
 * than pulling a full editor and its dependency tree into the app.
 */
function CodeSurface({
  value,
  onChange,
  language,
  rows,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  language: string;
  rows?: number;
  autoFocus?: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);

  // The highlight layer is not scrollable itself; it follows the textarea so
  // the painted text stays under the real caret.
  const syncScroll = () => {
    if (highlightRef.current && textareaRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  };

  // Tab should indent, not escape the field — losing your place mid-function is
  // worse than losing tab-to-next-control inside a code box.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart, selectionEnd } = el;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.selectionStart = el.selectionEnd = selectionStart + 2;
    });
  };

  return (
    <div className="code-surface">
      <Highlight theme={themes.vsDark} code={value || ''} language={language}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="code-surface-highlight" ref={highlightRef} aria-hidden>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="code-surface-gutter">{i + 1}</span>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        className="code-surface-input"
        spellCheck={false}
        rows={rows}
        autoFocus={autoFocus}
      />
    </div>
  );
}

interface CodeFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  language: string;
  rows?: number;
  title?: string;
}

export function NodeCodeField({
  label,
  value,
  onChange,
  language,
  rows = 8,
  title,
}: CodeFieldProps) {
  const [maximized, setMaximized] = useState(false);

  return (
    <>
      <FieldShell
        label={label}
        action={
          <button
            type="button"
            className="node-control-btn"
            onClick={() => setMaximized(true)}
            title="Edit full screen"
          >
            <Maximize2 size={12} />
          </button>
        }
      >
        <CodeSurface value={value} onChange={onChange} language={language} rows={rows} />
      </FieldShell>
      {maximized && (
        <MaximizedEditor
          title={title || label}
          value={value}
          onChange={onChange}
          onClose={() => setMaximized(false)}
          language={language}
        />
      )}
    </>
  );
}
