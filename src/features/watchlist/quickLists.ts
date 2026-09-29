/** The quick-access watchlists every part of a window shares — the watchlist panel's shortcuts,
 *  the browse dialog's stars and the chart's right-click menu — kept in the `watchlist_quick`
 *  preference. The rules are `lib/quickLists.ts`'s. */

import { useSyncExternalStore } from 'react';
import { getPreference, setPreference } from '../../lib/ipc';
import { parseQuickLists, toggleQuickList } from '../../lib/quickLists';

export const PREF_QUICK_LISTS = 'watchlist_quick';

let pins: number[] = [];
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: number[]) {
  pins = next;
  for (const listener of [...listeners]) listener();
}

/** Reads the pins once per window. */
export function loadQuickLists(): Promise<void> {
  loaded ??= getPreference(PREF_QUICK_LISTS)
    .then((raw) => publish(parseQuickLists(raw)))
    .catch(() => {});
  return loaded;
}

export const quickLists = (): number[] => pins;

export function subscribeQuickLists(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Replaces the pins (e.g. without a deleted list) and keeps them. */
export function setQuickLists(next: number[]): void {
  if (next.length === pins.length && next.every((id, i) => id === pins[i])) return;
  publish(next);
  void setPreference(PREF_QUICK_LISTS, JSON.stringify(next)).catch(() => {});
}

/** Pins or unpins a list. False when it couldn't be pinned because five already are. */
export function toggleQuickListPin(id: number): boolean {
  const { ids, full } = toggleQuickList(pins, id);
  if (full) return false;
  setQuickLists(ids);
  return true;
}

export function useQuickLists(): number[] {
  return useSyncExternalStore(subscribeQuickLists, quickLists);
}
