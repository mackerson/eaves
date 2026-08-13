import React, { useRef, useEffect, useCallback, memo } from 'react';

interface ChatInputProps {
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  /** Short explanation shown as a hover-title and inline hint when the input
   *  is disabled. Without this, a disabled bar leaves users guessing. */
  disabledReason?: string;
}

export const ChatInput: React.FC<ChatInputProps> = memo(({ onSend, disabled, placeholder, value, onChange, disabledReason }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea to fit content. Skip measurement when the value is
  // empty: scrollHeight is unreliable on first paint (fonts/layout not yet
  // settled in Electron) and we'd lock the textarea at a wrong height until
  // the user types. With no content, the desired height is always 40px.
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!value) {
      el.style.height = '40px';
      return;
    }
    el.style.height = '40px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // When the input flips from disabled→enabled (stream finished, agent
  // selected, etc.), return focus to the textarea so the user can keep
  // typing without re-clicking. Disabling a focused textarea blurs it
  // natively, so without this hook the cursor lives nowhere after every
  // send. Wrapped in a tiny rAF so the focus call lands after React's
  // commit phase has actually re-enabled the element.
  const prevDisabledRef = useRef(disabled);
  useEffect(() => {
    if (prevDisabledRef.current && !disabled) {
      const id = requestAnimationFrame(() => textareaRef.current?.focus());
      prevDisabledRef.current = disabled;
      return () => cancelAnimationFrame(id);
    }
    prevDisabledRef.current = disabled;
  }, [disabled]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  // When disabled, swap the placeholder for the reason and pin the title
  // attr so a hover surfaces the same explanation. Falls back to the normal
  // placeholder if no reason was passed (back-compat).
  const effectivePlaceholder = disabled && disabledReason ? disabledReason : placeholder;
  const titleAttr = disabled ? (disabledReason ?? 'Input is currently disabled') : undefined;

  return (
    <div className="flex-1 min-w-0" title={titleAttr}>
      <textarea
        ref={textareaRef}
        placeholder={effectivePlaceholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        // Baseline inline height so the very first paint is correct, before
        // the auto-resize effect has a chance to run.
        style={{ height: '40px' }}
        className="w-full min-h-[40px] max-h-[160px] resize-none rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
      />
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
