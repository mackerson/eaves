import { describe, it, expect } from 'vitest';
import { diffLines, hasChanges, collapseUnchanged } from './textDiff';

describe('diffLines', () => {
  it('reports an unchanged file as entirely unchanged', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'same', text: 'b' },
    ]);
    expect(hasChanges(diffLines('a\nb', 'a\nb'))).toBe(false);
  });

  it('keeps the surrounding lines when one line changes', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'removed', text: 'b' },
      { op: 'added', text: 'B' },
      { op: 'same', text: 'c' },
    ]);
  });

  it('reports an insertion without touching what was already there', () => {
    expect(diffLines('a\nc', 'a\nb\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'added', text: 'b' },
      { op: 'same', text: 'c' },
    ]);
  });

  it('reports a deletion', () => {
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'removed', text: 'b' },
      { op: 'same', text: 'c' },
    ]);
  });

  it('handles a file appearing from nothing', () => {
    expect(diffLines('', 'a')).toEqual([
      { op: 'removed', text: '' },
      { op: 'added', text: 'a' },
    ]);
  });
});

describe('collapseUnchanged', () => {
  // A 300-line file with a one-line fix is 299 lines of noise around the
  // answer, and scrolling past it is how a reviewer stops reviewing.
  it('replaces a long unchanged run with a count', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'LINE 10');

    const collapsed = collapseUnchanged(diffLines(before, after));

    expect(collapsed[0]).toEqual({ op: 'skip', count: 7 });
    expect(collapsed).toContainEqual({ op: 'removed', text: 'line 10' });
    expect(collapsed).toContainEqual({ op: 'added', text: 'LINE 10' });
    expect(collapsed[collapsed.length - 1]).toEqual({ op: 'skip', count: 6 });
  });

  it('leaves a short file alone', () => {
    const collapsed = collapseUnchanged(diffLines('a\nb', 'a\nB'));
    expect(collapsed.every(line => line.op !== 'skip')).toBe(true);
  });
});
