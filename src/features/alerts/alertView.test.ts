import { describe, expect, it } from 'vitest';
import type { PriceAlert } from '../../lib/ipc';
import { describeStatus, sortAlerts } from './alertView';

const alert = (over: Partial<PriceAlert>): PriceAlert => ({
  id: 'a',
  symbol: 'binance:BTCUSDT',
  condition: 'crossing_up',
  price: 100,
  basePrice: 90,
  message: '',
  mode: 'once',
  status: 'active',
  createdAt: 1000,
  triggeredAt: null,
  triggerPrice: null,
  triggerCount: 0,
  ...over,
});

describe('the order alerts are listed in', () => {
  it('puts what is watching first, then what is paused, and what has fired last', () => {
    const list = [
      alert({ id: 'fired', status: 'triggered', triggeredAt: 5000 }),
      alert({ id: 'paused', status: 'paused' }),
      alert({ id: 'watching' }),
    ];
    expect(sortAlerts(list).map((a) => a.id)).toEqual(['watching', 'paused', 'fired']);
  });

  it('puts the newest first within a status, by when it fired or else was made', () => {
    const list = [
      alert({ id: 'old', createdAt: 1000 }),
      alert({ id: 'new', createdAt: 3000 }),
      alert({ id: 'fired-early', status: 'triggered', triggeredAt: 2000 }),
      alert({ id: 'fired-late', status: 'triggered', triggeredAt: 4000 }),
    ];
    expect(sortAlerts(list).map((a) => a.id)).toEqual(['new', 'old', 'fired-late', 'fired-early']);
  });

  it('does not reorder the list it was given', () => {
    const list = [alert({ id: 'b', status: 'paused' }), alert({ id: 'a' })];
    sortAlerts(list);
    expect(list.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('files a status it does not know with the fired ones rather than failing', () => {
    expect(sortAlerts([alert({ id: 'odd', status: 'mystery' }), alert({ id: 'ok' })]).map((a) => a.id)).toEqual(['ok', 'odd']);
  });
});

describe('what an alert says about itself', () => {
  it('says it is watching or paused', () => {
    expect(describeStatus(alert({}))).toBe('Watching');
    expect(describeStatus(alert({ status: 'paused' }))).toBe('Paused');
  });

  it('adds its repeat mode and its note', () => {
    expect(describeStatus(alert({ mode: 'every', message: 'Breakout' }))).toBe('Watching · every time it crosses · Breakout');
  });

  it('reports how often a repeating alert has fired', () => {
    const text = describeStatus(alert({ mode: 'every', triggerCount: 3, triggeredAt: 2_000_000_000_000 }));
    expect(text).toContain('fired 3×');
  });

  it('says where a fired alert fired', () => {
    const text = describeStatus(alert({ status: 'triggered', triggeredAt: 2_000_000_000_000, triggerPrice: 101.5 }));
    expect(text).toMatch(/^Fired .+ at 101\.50$/);
    expect(describeStatus(alert({ status: 'triggered', triggeredAt: null, triggerPrice: null }))).toBe('Fired at —');
  });
});
