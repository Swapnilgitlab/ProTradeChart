import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_DELAY_MS, SymbolDrawings, type DrawingsPort, type DrawingsStore } from './symbolDrawings';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

/** A chart's drawings, as the port sees them. */
function fakeChart(initial: string[] = []) {
  let drawings = [...initial];
  const port: DrawingsPort & { names: () => string[] } = {
    toJSON: () => ({ version: 1, drawings: drawings.map((id) => ({ id })) }),
    fromJSON: (doc) => {
      drawings = ((doc as { drawings: { id: string }[] }).drawings ?? []).map((d) => d.id);
    },
    names: () => drawings,
  };
  return { port, draw: (id: string) => drawings.push(id), clear: () => (drawings = []) };
}

/** Stored documents by symbol, with a switch to make loads wait. */
function fakeStore(initial: Record<string, string[]> = {}) {
  const docs = new Map(Object.entries(initial).map(([s, ids]) => [s, JSON.stringify({ version: 1, drawings: ids.map((id) => ({ id })) })]));
  const saves: [string, string[]][] = [];
  let hold: Promise<void> | null = null;
  const store: DrawingsStore = {
    load: async (symbol) => {
      if (hold) await hold;
      return docs.get(symbol) ?? null;
    },
    save: async (symbol, json) => {
      docs.set(symbol, json);
      saves.push([symbol, (JSON.parse(json).drawings as { id: string }[]).map((d) => d.id)]);
    },
  };
  return {
    store,
    saves,
    stored: (symbol: string) => (docs.has(symbol) ? (JSON.parse(docs.get(symbol)!).drawings as { id: string }[]).map((d) => d.id) : null),
    holdLoads: () => {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

/** Lets pending promises run (timers are faked, so `setTimeout` can't be used to wait). */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('SymbolDrawings', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => vi.useRealTimers());

  it('shows a symbol’s stored drawings when the chart opens', async () => {
    const chart = fakeChart(['from-layout']);
    const db = fakeStore({ 'india:NSE:TCS': ['line'] });
    await new SymbolDrawings(chart.port, db.store).start('india:NSE:TCS');
    expect(chart.port.names()).toEqual(['line']);
    expect(db.saves).toEqual([]);
  });

  it('adopts a layout’s drawings for a symbol that has none stored, once', async () => {
    const chart = fakeChart(['from-layout']);
    const db = fakeStore();
    await new SymbolDrawings(chart.port, db.store).start('india:NSE:TCS');
    expect(chart.port.names()).toEqual(['from-layout']);
    expect(db.stored('india:NSE:TCS')).toEqual(['from-layout']);
    // A chart with no drawings stores nothing: "never had any" stays distinguishable.
    const empty = fakeStore();
    await new SymbolDrawings(fakeChart().port, empty.store).start('india:NSE:INFY');
    expect(empty.stored('india:NSE:INFY')).toBeNull();
  });

  it('swaps drawings when the chart changes symbol, keeping the old symbol’s edits', async () => {
    const chart = fakeChart();
    const db = fakeStore({ 'india:NSE:INFY': ['infy-line'] });
    const sd = new SymbolDrawings(chart.port, db.store);
    await sd.start('india:NSE:TCS');
    chart.draw('tcs-line');
    sd.edited();
    await sd.switchTo('india:NSE:INFY');
    expect(chart.port.names()).toEqual(['infy-line']);
    expect(db.stored('india:NSE:TCS')).toEqual(['tcs-line']);
    // A symbol with nothing stored shows a clean chart, not the last symbol's drawings.
    await sd.switchTo('india:NSE:HFCL');
    expect(chart.port.names()).toEqual([]);
    await sd.switchTo('india:NSE:TCS');
    expect(chart.port.names()).toEqual(['tcs-line']);
  });

  it('saves once an edit settles, and a cleared symbol stays cleared', async () => {
    const chart = fakeChart();
    const db = fakeStore({ 'india:NSE:TCS': ['a'] });
    const sd = new SymbolDrawings(chart.port, db.store);
    await sd.start('india:NSE:TCS');
    chart.draw('b');
    sd.edited();
    sd.edited();
    expect(db.saves).toEqual([]);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    await settle();
    expect(db.saves).toEqual([['india:NSE:TCS', ['a', 'b']]]);
    chart.clear();
    sd.edited();
    await sd.flush();
    expect(db.stored('india:NSE:TCS')).toEqual([]);
  });

  it('never takes its own replacement of the drawings for an edit', async () => {
    const chart = fakeChart();
    const db = fakeStore({ 'india:NSE:TCS': ['a'] });
    const sd = new SymbolDrawings(chart.port, { ...db.store, load: db.store.load });
    const apply = chart.port.fromJSON;
    chart.port.fromJSON = (doc) => {
      apply(doc);
      sd.edited(); // Vela reporting the load as a change
    };
    await sd.start('india:NSE:TCS');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    await settle();
    expect(db.saves).toEqual([]);
  });

  it('ignores a load that finishes after the chart has moved on', async () => {
    const chart = fakeChart();
    const db = fakeStore({ 'india:NSE:TCS': ['tcs'], 'india:NSE:INFY': ['infy'] });
    const sd = new SymbolDrawings(chart.port, db.store);
    const release = db.holdLoads();
    const first = sd.start('india:NSE:TCS');
    const second = sd.switchTo('india:NSE:INFY');
    release();
    await Promise.all([first, second]);
    expect(chart.port.names()).toEqual(['infy']);
  });

  it('follows another chart’s edits to the same symbol, unless it has edits of its own', async () => {
    const chart = fakeChart();
    const db = fakeStore({ 'india:NSE:TCS': ['a'] });
    const sd = new SymbolDrawings(chart.port, db.store);
    await sd.start('india:NSE:TCS');
    await db.store.save('india:NSE:TCS', JSON.stringify({ version: 1, drawings: [{ id: 'a' }, { id: 'elsewhere' }] }));
    await sd.remoteChanged('india:NSE:INFY');
    expect(chart.port.names()).toEqual(['a']);
    await sd.remoteChanged('india:NSE:TCS');
    expect(chart.port.names()).toEqual(['a', 'elsewhere']);
    chart.draw('mine');
    sd.edited();
    await sd.remoteChanged('india:NSE:TCS');
    expect(chart.port.names()).toEqual(['a', 'elsewhere', 'mine']);
  });

  it('says when drawings couldn’t be saved or loaded', async () => {
    const errors: string[] = [];
    const chart = fakeChart(['x']);
    const sd = new SymbolDrawings(chart.port, { load: () => Promise.reject(new Error('locked')), save: () => Promise.reject(new Error('disk full')) }, (m) => errors.push(m));
    await sd.start('india:NSE:TCS');
    sd.edited();
    await sd.flush();
    expect(errors).toEqual(['Your drawings on india:NSE:TCS couldn’t be loaded: locked', 'Your drawings on india:NSE:TCS couldn’t be saved: disk full']);
  });
});
