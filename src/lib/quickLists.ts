/** Quick-access watchlists: up to five lists pinned for one-click switching in the watchlist panel
 *  and one-click adding from a chart's right-click menu. They are kept as watchlist ids, in the
 *  order they were pinned. Pure. */

export const MAX_QUICK_LISTS = 5;

/** The stored preference as ids: anything unreadable is dropped, and at most five are kept. */
export function parseQuickLists(raw: string | null | undefined): number[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0);
  return [...new Set(ids)].slice(0, MAX_QUICK_LISTS);
}

/** Pins or unpins `id`. Pinning a sixth list is refused (`full`), leaving the pins as they were. */
export function toggleQuickList(ids: readonly number[], id: number): { ids: number[]; full: boolean } {
  if (ids.includes(id)) return { ids: ids.filter((x) => x !== id), full: false };
  if (ids.length >= MAX_QUICK_LISTS) return { ids: [...ids], full: true };
  return { ids: [...ids, id], full: false };
}

/** The pins that still name a watchlist (one may have been deleted since). */
export function existingQuickLists(ids: readonly number[], existing: readonly number[]): number[] {
  const alive = new Set(existing);
  return ids.filter((id) => alive.has(id));
}
