import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Check } from 'lucide-react';

interface ModelComboboxProps {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Max items rendered in the popover; matches narrow scroll area. */
  maxResults?: number;
}

/**
 * Searchable model picker for providers that expose hundreds of options
 * (OpenRouter is the immediate user). The plain `<select>` chokes on lists
 * that long; a typing-to-filter combobox keeps it usable without pulling in
 * a heavyweight Command/Popover dep.
 *
 * Behavior:
 *  - Always shows the current value in the input. Typing replaces it and
 *    filters the popover.
 *  - Click an item (or Enter on highlighted) to commit. Esc / blur cancels
 *    pending input, restoring the committed value.
 *  - Free-form text is allowed — committing on blur lets users pick a model
 *    that didn't come back from the listing API (rare but real).
 */
export function ModelCombobox({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  maxResults = 100,
}: ModelComboboxProps) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Re-sync the input when the parent's value changes (e.g. provider switch
  // auto-selects the first model). Without this the combobox stays stale.
  useEffect(() => {
    setQuery(value);
  }, [value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || q === value.toLowerCase()) return options.slice(0, maxResults);
    return options.filter(o => o.toLowerCase().includes(q)).slice(0, maxResults);
  }, [query, value, options, maxResults]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const commit = (next: string) => {
    onChange(next);
    setQuery(next);
    setOpen(false);
  };

  return (
    <div ref={containerRef} className="relative">
      <Input
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={() => {
          // Free-form commit on blur if the typed value differs from the
          // currently-selected one. Doesn't close the popover here — that's
          // handled by the outside-click listener so a click on an item
          // still registers.
          if (query !== value) onChange(query);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(i => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            if (open && filtered[activeIndex]) {
              e.preventDefault();
              commit(filtered[activeIndex]);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
            setQuery(value);
          }
        }}
      />
      {open && filtered.length > 0 && (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-md border border-border bg-background shadow-lg text-sm"
        >
          {filtered.map((opt, idx) => {
            const isActive = idx === activeIndex;
            const isSelected = opt === value;
            return (
              <li
                key={opt}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(idx)}
                // Use onMouseDown so the click fires before the input's
                // onBlur tears the popover down on the next tick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt);
                }}
                className={`px-3 py-1.5 cursor-pointer flex items-center justify-between gap-2 ${
                  isActive ? 'bg-accent text-accent-foreground' : ''
                }`}
              >
                <span className="truncate">{opt}</span>
                {isSelected && <Check size={14} className="shrink-0 opacity-60" />}
              </li>
            );
          })}
          {options.length > filtered.length && (
            <li className="px-3 py-1.5 text-xs text-muted-foreground border-t border-border">
              {filtered.length} of {options.length} — keep typing to narrow
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
