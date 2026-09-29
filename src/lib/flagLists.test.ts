import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { flagOfList, WATCHLIST_FLAGS } from './ipc';

describe('colour-flag lists', () => {
  it('go by negative ids, red first, as the backend numbers them (watchlists::flag_list_id)', () => {
    expect(WATCHLIST_FLAGS.map((_, i) => flagOfList(-(i + 1)))).toEqual([...WATCHLIST_FLAGS]);
    expect(flagOfList(-1)).toBe('red');
    expect(flagOfList(-6)).toBe('purple');
  });

  it('are never a real watchlist', () => {
    for (const id of [0, 1, 42, -7, null, undefined]) expect(flagOfList(id)).toBeNull();
  });
});
