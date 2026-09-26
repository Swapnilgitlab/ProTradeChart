import { describe, expect, it } from 'vitest';
import { panelAfterToggle, railPreferenceValue, restoreRailPanel } from './railPanel';

describe('the panel to start with', () => {
  it('is whatever was saved', () => {
    expect(restoreRailPanel('alerts', null)).toBe('alerts');
    expect(restoreRailPanel('watchlist', '1')).toBe('watchlist');
    expect(restoreRailPanel('none', null)).toBeNull();
  });

  it('follows the old watchlist setting when nothing was saved yet', () => {
    expect(restoreRailPanel(null, null)).toBe('watchlist');
    expect(restoreRailPanel(null, '0')).toBe('watchlist');
    expect(restoreRailPanel(null, '1')).toBeNull();
  });

  it('ignores a saved panel it has never heard of, rather than opening nothing', () => {
    expect(restoreRailPanel('calendar', null)).toBe('watchlist');
    expect(restoreRailPanel('', '1')).toBeNull();
  });
});

describe('pressing a rail button', () => {
  it('opens its panel, replacing the one showing', () => {
    expect(panelAfterToggle(null, 'alerts')).toBe('alerts');
    expect(panelAfterToggle('watchlist', 'alerts')).toBe('alerts');
  });

  it('folds the panel away when it is already the one showing', () => {
    expect(panelAfterToggle('alerts', 'alerts')).toBeNull();
  });
});

describe('what is remembered', () => {
  it('round-trips every panel and the closed state', () => {
    expect(restoreRailPanel(railPreferenceValue('alerts'), null)).toBe('alerts');
    expect(restoreRailPanel(railPreferenceValue('watchlist'), null)).toBe('watchlist');
    expect(restoreRailPanel(railPreferenceValue(null), null)).toBeNull();
  });
});
