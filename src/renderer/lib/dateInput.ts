/**
 * Conversions between `<input type="date">`'s `YYYY-MM-DD` and the epoch
 * milliseconds the store holds.
 *
 * Both directions are deliberately **local**. `new Date('2026-08-09')` — a
 * bare date with no time part — is parsed by the ES spec as UTC midnight,
 * while `new Date('2026-08-09T00:00')` is parsed as local. Everything that
 * *reads* a due date (formatDueDate, the calendar) rebuilds a local calendar
 * day from the timestamp, so storing UTC midnight put the whole field one day
 * early anywhere west of UTC: a task showed a day early, flagged "Today" a day
 * early, and reported "1d overdue" on the day it was actually due.
 *
 * It went unnoticed because the form round-trips consistently — the old writer
 * and the old reader were both UTC, so editing a task showed the date back
 * exactly as typed.
 */

/** `YYYY-MM-DD` → epoch ms at local midnight. Empty/invalid input → undefined. */
export function parseDateInput(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  // Month is 0-based, and this constructor form is always local.
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

/** Epoch ms → `YYYY-MM-DD` for the local calendar day it falls on. */
export function toDateInputValue(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  // Local getters, not toISOString() — that reports the UTC day, which is the
  // other half of the same bug.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
