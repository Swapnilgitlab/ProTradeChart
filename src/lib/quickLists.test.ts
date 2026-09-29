import { describe, expect, it } from 'vitest';
import { existingQuickLists, MAX_QUICK_LISTS, parseQuickLists, toggleQuickList } from './quickLists';

describe('quick-access watchlists', () => {
  it('reads the stored preference tolerantly', () => {
    expect(parseQuickLists('[3,1,3,"x",-2,2.5,7]')).toEqual([3, 1, 7]);
    expect(parseQuickLists('[1,2,3,4,5,6,7]')).toHaveLength(MAX_QUICK_LISTS);
    for (const bad of [null, undefined, '', 'nope', '{"a":1}']) expect(parseQuickLists(bad)).toEqual([]);
  });

  it('pins in order, unpins, and refuses a sixth', () => {
    expect(toggleQuickList([1, 2], 3)).toEqual({ ids: [1, 2, 3], full: false });
    expect(toggleQuickList([1, 2, 3], 2)).toEqual({ ids: [1, 3], full: false });
    expect(toggleQuickList([1, 2, 3, 4, 5], 6)).toEqual({ ids: [1, 2, 3, 4, 5], full: true });
    // Unpinning is always allowed, even when full.
    expect(toggleQuickList([1, 2, 3, 4, 5], 5)).toEqual({ ids: [1, 2, 3, 4], full: false });
  });

  it('drops pins of deleted watchlists, keeping the order', () => {
    expect(existingQuickLists([4, 1, 9], [1, 2, 4])).toEqual([4, 1]);
  });
});
