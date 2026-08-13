/**
 * Reordering helpers for lists that are only ever *partly* on screen.
 *
 * `reorderNotes`/`reorderTasks` assign `sortOrder = N - i` across exactly the
 * ids handed to them. Both views hand over a subset — NotesView passes its
 * filtered set, TasksView passes only the incomplete or only the completed
 * half — so everything outside that subset kept its old values and started
 * colliding with the freshly assigned ones. The store's own "shouldn't happen,
 * but safety" comment shows the list was assumed to be complete.
 */

/**
 * Place `subsetNewOrder` back into `allIds`, leaving every id outside the
 * subset exactly where it was.
 *
 * The subset's items land in the slots the subset previously occupied, in
 * their new relative order — so reordering a filtered view moves only what
 * the user could see, and hidden items neither move nor collide.
 */
export function spliceReorder(allIds: string[], subsetNewOrder: string[]): string[] {
  const subset = new Set(subsetNewOrder);
  const slots: number[] = [];
  allIds.forEach((id, index) => {
    if (subset.has(id)) slots.push(index);
  });

  // A subset containing ids not present in allIds (or vice versa) would leave
  // holes; fall back to the caller's order rather than emitting undefined.
  if (slots.length !== subsetNewOrder.length) return subsetNewOrder;

  const result = [...allIds];
  slots.forEach((slot, i) => {
    result[slot] = subsetNewOrder[i];
  });
  return result;
}

/**
 * The value a dropped item should adopt from where it landed.
 *
 * Prefers the neighbour above — dropping directly beneath the high-priority
 * block reads as "make this high" — and falls back to the neighbour below so a
 * drop at the very top of the list still adopts something.
 */
export function valueAtDropPosition<T>(
  order: string[],
  movedId: string,
  valueOf: (id: string) => T | undefined,
): T | undefined {
  const index = order.indexOf(movedId);
  if (index === -1) return undefined;
  const above = index > 0 ? valueOf(order[index - 1]) : undefined;
  if (above !== undefined) return above;
  return index < order.length - 1 ? valueOf(order[index + 1]) : undefined;
}
