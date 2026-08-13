import { describe, it, expect } from 'vitest';
import { spliceReorder, valueAtDropPosition } from './reorder';

describe('spliceReorder', () => {
  it('is a plain reorder when the subset is the whole list', () => {
    expect(spliceReorder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
  });

  /**
   * The bug: reorderNotes/reorderTasks assign `sortOrder = N - i` across
   * exactly the ids handed to them, and the views handed over a filtered or
   * half list. Hidden items kept their old values and collided with the new
   * ones.
   */
  it('leaves hidden items exactly where they were', () => {
    // b and d are filtered out; the user drags e above a.
    const all = ['a', 'b', 'c', 'd', 'e'];
    const visible = ['e', 'c', 'a'];

    const result = spliceReorder(all, visible);

    expect(result).toEqual(['e', 'b', 'c', 'd', 'a']);
    // Hidden ids keep their absolute positions.
    expect(result[1]).toBe('b');
    expect(result[3]).toBe('d');
  });

  it('renumbers over the full list, so no two items can collide', () => {
    const all = ['a', 'b', 'c', 'd'];
    const result = spliceReorder(all, ['c', 'a']);

    expect(new Set(result).size).toBe(all.length);
    expect([...result].sort()).toEqual([...all].sort());
  });

  it('handles a subset drawn from the tail (the completed-tasks half)', () => {
    expect(spliceReorder(['a', 'b', 'c', 'd'], ['d', 'c'])).toEqual(['a', 'b', 'd', 'c']);
  });

  // A subset with ids the full list doesn't know about would leave holes.
  it('falls back to the caller order when the subset does not fit', () => {
    expect(spliceReorder(['a', 'b'], ['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
  });

  it('is a no-op for an empty subset', () => {
    expect(spliceReorder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('valueAtDropPosition', () => {
  const priorities: Record<string, string> = { a: 'high', b: 'high', c: 'medium', d: 'low' };
  const valueOf = (id: string) => (id === 'moved' ? undefined : priorities[id]);

  it('takes the neighbour above', () => {
    // Dropped directly beneath the high block.
    expect(valueAtDropPosition(['a', 'b', 'moved', 'c', 'd'], 'moved', valueOf)).toBe('high');
  });

  it('falls back to the neighbour below at the top of the list', () => {
    expect(valueAtDropPosition(['moved', 'a', 'b'], 'moved', valueOf)).toBe('high');
  });

  it('takes the neighbour above at the bottom of the list', () => {
    expect(valueAtDropPosition(['a', 'c', 'd', 'moved'], 'moved', valueOf)).toBe('low');
  });

  it('returns nothing when the item is alone or absent', () => {
    expect(valueAtDropPosition(['moved'], 'moved', valueOf)).toBeUndefined();
    expect(valueAtDropPosition(['a', 'b'], 'moved', valueOf)).toBeUndefined();
  });
});
