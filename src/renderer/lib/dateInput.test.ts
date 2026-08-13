import { describe, it, expect } from 'vitest';
import { parseDateInput, toDateInputValue } from './dateInput';

describe('date input conversions', () => {
  /**
   * The bug: `new Date('2026-08-09')` is UTC midnight per the ES spec, while
   * every reader (formatDueDate, the calendar) rebuilds a *local* calendar day
   * from the timestamp. West of UTC that lands on the previous day, so a task
   * showed a day early, flagged "Today" a day early, and reported "1d overdue"
   * on the day it was actually due.
   */
  it('parses to local midnight, not UTC midnight', () => {
    const ts = parseDateInput('2026-08-09')!;
    const d = new Date(ts);

    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // 0-based
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });

  it('formats from the local calendar day, not the UTC one', () => {
    const localMidnight = new Date(2026, 7, 9).getTime();
    expect(toDateInputValue(localMidnight)).toBe('2026-08-09');
  });

  // The property that actually matters: whatever day the user picks is the day
  // every reader sees, in any timezone.
  it('round-trips every day of a year without drifting', () => {
    for (let month = 0; month < 12; month++) {
      for (const day of [1, 15, 28]) {
        const value = `2026-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        expect(toDateInputValue(parseDateInput(value)!)).toBe(value);
      }
    }
  });

  it('survives a DST boundary', () => {
    // US spring-forward and fall-back Sundays; in zones without DST these are
    // ordinary days and the assertion still holds.
    for (const value of ['2026-03-08', '2026-11-01']) {
      expect(toDateInputValue(parseDateInput(value)!)).toBe(value);
    }
  });

  it('treats empty and malformed input as no date', () => {
    expect(parseDateInput('')).toBeUndefined();
    expect(parseDateInput('   ')).toBeUndefined();
    expect(parseDateInput('09/08/2026')).toBeUndefined();
    expect(parseDateInput('2026-08')).toBeUndefined();
  });

  it('treats a missing timestamp as an empty field', () => {
    expect(toDateInputValue(undefined)).toBe('');
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue(Number.NaN)).toBe('');
  });
});
