import { describe, expect, it } from 'vitest';
import { addToWatchlistLabel, membersByList, NEW_LIST_ITEM, watchlistSubmenu } from './watchlistMenu';

const lists = [
  { id: 1, name: 'Swing' },
  { id: 2, name: 'Banks' },
  { id: 3, name: 'Indices' },
];
const members = membersByList([
  [1, 'zerodha:NSE:TCS'],
  [2, 'zerodha:NSE:HDFCBANK'],
  [3, 'zerodha:NSE:TCS'],
]);

describe('the Add to watchlist submenu', () => {
  it('ticks the lists that hold the symbol', () => {
    const items = watchlistSubmenu(lists, members, [], 'zerodha:NSE:TCS');
    expect(items.map((i) => [i.label, i.checked ?? null])).toEqual([
      ['Banks', false],
      ['Indices', true],
      ['Swing', true],
      ['New watchlist…', null],
    ]);
    expect(items[items.length - 1]).toMatchObject({ id: NEW_LIST_ITEM, separatorBefore: true });
  });

  it('puts quick-access lists first, in pin order, and ignores a pin whose list is gone', () => {
    const items = watchlistSubmenu(lists, members, [3, 99, 1], 'zerodha:NSE:INFY');
    expect(items.map((i) => i.label)).toEqual(['Indices', 'Swing', 'Banks', 'New watchlist…']);
    expect(items.slice(0, 3).every((i) => i.checked === false)).toBe(true);
  });

  it('offers only a new list when there are none', () => {
    expect(watchlistSubmenu([], new Map(), [], 'x:y')).toEqual([{ id: NEW_LIST_ITEM, label: 'New watchlist…', separatorBefore: false }]);
  });

  it('keys items by the list’s id', () => {
    expect(watchlistSubmenu(lists, members, [], 'x:y')[0].id).toBe('2');
  });

  it('draws every list as a checkbox, ticked or not, and the new-list item as a plain entry', () => {
    const items = watchlistSubmenu(lists, members, [], 'zerodha:NSE:TCS');
    expect(items.slice(0, 3).every((i) => i.checkbox === true && typeof i.checked === 'boolean')).toBe(true);
    expect(items[items.length - 1].checkbox).toBeUndefined();
  });

  it('names the symbol in the item’s label', () => {
    expect(addToWatchlistLabel('DIACABS')).toBe('Add DIACABS to watchlist');
  });
});
