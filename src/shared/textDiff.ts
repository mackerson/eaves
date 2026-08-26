/**
 * A line diff, small enough to read.
 *
 * The Workshop needs this because an agent rewrites a draft in place: the
 * question at the bench is never "what does this file say" on the second pass,
 * it is "what moved since I last read it". Pulling in a diff library for that
 * would be a dependency for one screen; an LCS over lines is a dozen lines and
 * has no opinions about rendering.
 */

export type DiffOp = 'same' | 'added' | 'removed';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/**
 * Longest common subsequence over lines, walked back into a diff.
 *
 * O(n·m) in both time and memory, which is fine at the scale this runs: a
 * draft file is capped at 512KB and in practice is a few hundred lines. Files
 * past `MAX_LINES` are reported as a wholesale replacement rather than
 * allocating a matrix nobody will read the output of.
 */
const MAX_LINES = 3000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map(text => ({ op: 'removed' as const, text })),
      ...b.map(text => ({ op: 'added' as const, text })),
    ];
  }

  // lengths[i][j] = LCS length of a[i:] and b[j:]
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] = a[i] === b[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++; j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ op: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ op: 'added', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ op: 'removed', text: a[i++] });
  while (j < b.length) out.push({ op: 'added', text: b[j++] });

  return out;
}

/** Whether a diff has anything in it worth showing. */
export function hasChanges(diff: DiffLine[]): boolean {
  return diff.some(line => line.op !== 'same');
}

/**
 * Collapse long runs of unchanged lines to a few lines of context either side.
 *
 * A 300-line file with a one-line fix is 299 lines of noise around the answer,
 * and scrolling past it is how a reviewer stops reviewing.
 */
export function collapseUnchanged(diff: DiffLine[], context = 3): Array<DiffLine | { op: 'skip'; count: number }> {
  const keep = new Set<number>();
  diff.forEach((line, index) => {
    if (line.op === 'same') return;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < diff.length) keep.add(k);
    }
  });

  const out: Array<DiffLine | { op: 'skip'; count: number }> = [];
  let skipped = 0;
  diff.forEach((line, index) => {
    if (keep.has(index)) {
      if (skipped > 0) { out.push({ op: 'skip', count: skipped }); skipped = 0; }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ op: 'skip', count: skipped });
  return out;
}
