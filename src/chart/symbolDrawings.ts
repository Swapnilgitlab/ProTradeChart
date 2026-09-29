/** Drawings belong to the symbol, not to the chart. Vela keeps one set of drawings per chart and
 *  leaves them in place when the chart changes symbol, so a trend line drawn on RELIANCE would stay
 *  on TCS. Here each chart swaps its drawings on every symbol change (Vela's `market:changed`
 *  carries the previous symbol for exactly this) and stores them per symbol in the app's database
 *  (`store/symbol_drawings.rs`), so every chart of a symbol — any tab, window or layout, any
 *  timeframe — shows the same drawings, and an edit on one reaches the others.
 *
 *  Layouts still carry each chart's drawings. The stored drawings win; a symbol the app has never
 *  stored drawings for adopts the ones a layout brought (how drawings made before this change carry
 *  over). An empty document is stored when every drawing is removed, so a cleared symbol stays clear.
 *
 *  `SymbolDrawings` holds the rules and is tested with fakes; `watchSymbolDrawings` wires it to a chart. */

import { listen } from '@tauri-apps/api/event';
import type { Vela } from '@luxalgo/vela';
import { notify } from '../data/events';
import { errorMessage, getSymbolDrawings, saveSymbolDrawings } from '../lib/ipc';
import { normalizeSymbol } from '../lib/symbols';

/** How long after the last edit the drawings are saved: a drag is many edits. */
export const SAVE_DELAY_MS = 400;

interface Doc {
  drawings: unknown[];
  [key: string]: unknown;
}

/** What `SymbolDrawings` needs from a chart. */
export interface DrawingsPort {
  toJSON(): Doc;
  fromJSON(doc: unknown): void;
}

/** Where drawings are kept: by symbol, as JSON; `null` when a symbol has never had any stored. */
export interface DrawingsStore {
  load(symbol: string): Promise<string | null>;
  save(symbol: string, json: string): Promise<void>;
}

export class SymbolDrawings {
  private symbol: string | null = null;
  /** Bumped by every load, so an answer that arrives after the chart moved on is ignored. */
  private generation = 0;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Set while this class itself replaces the drawings, so that isn't taken for an edit. */
  private applying = false;

  constructor(
    private readonly port: DrawingsPort,
    private readonly store: DrawingsStore,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  get currentSymbol(): string | null {
    return this.symbol;
  }

  /** The chart's first symbol: show its stored drawings, or adopt the ones the chart already has
   *  (from a layout) if that symbol has none stored yet. */
  async start(symbol: string): Promise<void> {
    this.symbol = symbol;
    const generation = ++this.generation;
    const stored = await this.load(symbol);
    if (generation !== this.generation || stored === undefined) return;
    if (stored !== null) {
      // An edit made while loading wins; it is about to be saved.
      if (!this.dirty) this.apply(stored);
      return;
    }
    if (this.port.toJSON().drawings.length > 0) await this.saveNow();
  }

  /** The chart changed symbol: keep the old symbol's drawings, show the new one's. */
  async switchTo(symbol: string): Promise<void> {
    if (symbol === this.symbol) return;
    const previous = this.symbol;
    // Read before anything replaces them: until now the chart still holds the old symbol's drawings.
    const leaving = this.dirty && previous !== null ? JSON.stringify(this.port.toJSON()) : null;
    this.cancelTimer();
    this.dirty = false;
    this.symbol = symbol;
    const generation = ++this.generation;
    // Clear at once, so the old drawings never sit on the new symbol while its own load.
    this.apply(JSON.stringify(this.emptyDoc()));
    if (leaving !== null && previous !== null) await this.store.save(previous, leaving).catch((err) => this.onError(errorMessage(err)));
    const stored = await this.load(symbol);
    if (generation !== this.generation || stored === undefined || stored === null || this.dirty) return;
    this.apply(stored);
  }

  /** A drawing was created, edited or removed on this chart. */
  edited(): void {
    if (this.applying || this.symbol === null) return;
    this.dirty = true;
    this.cancelTimer();
    this.timer = setTimeout(() => void this.saveNow(), SAVE_DELAY_MS);
  }

  /** Another chart saved `symbol`'s drawings: follow, unless this one has edits of its own pending. */
  async remoteChanged(symbol: string): Promise<void> {
    if (symbol !== this.symbol || this.dirty) return;
    const generation = ++this.generation;
    const stored = await this.load(symbol);
    if (generation !== this.generation || stored === undefined || stored === null || this.dirty) return;
    this.apply(stored);
  }

  /** Saves pending edits now (a chart being closed). */
  async flush(): Promise<void> {
    this.cancelTimer();
    if (this.dirty) await this.saveNow();
  }

  private async saveNow(): Promise<void> {
    this.cancelTimer();
    const symbol = this.symbol;
    if (symbol === null) return;
    this.dirty = false;
    try {
      await this.store.save(symbol, JSON.stringify(this.port.toJSON()));
    } catch (err) {
      this.onError(`Your drawings on ${symbol} couldn’t be saved: ${errorMessage(err)}`);
    }
  }

  /** The stored document, `null` for none, or `undefined` when it couldn't be read. */
  private async load(symbol: string): Promise<string | null | undefined> {
    try {
      return await this.store.load(symbol);
    } catch (err) {
      this.onError(`Your drawings on ${symbol} couldn’t be loaded: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private apply(json: string): void {
    let doc: unknown;
    try {
      doc = JSON.parse(json);
    } catch {
      return;
    }
    this.applying = true;
    try {
      this.port.fromJSON(doc);
    } finally {
      this.applying = false;
    }
  }

  private emptyDoc(): Doc {
    return { ...this.port.toJSON(), drawings: [] };
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Gives `chart` per-symbol drawings. Returns a function that stops (saving any pending edits). */
export function watchSymbolDrawings(chart: Vela): () => void {
  const id = crypto.randomUUID();
  let selected = false;
  const drawings = new SymbolDrawings(
    {
      toJSON: () => chart.drawings.toJSON() as unknown as Doc,
      fromJSON: (doc) => {
        // Vela's fromJSON drops the selection without telling the renderer, which would leave a
        // selected drawing's handles and its floating edit toolbar on the chart after the drawing
        // itself is gone. Deselecting clears the handles; the toolbar closes only on a click, Escape
        // or a resize, so a same-size resize closes it — and only when something was selected.
        const hadSelection = selected;
        chart.drawings.select(null);
        chart.drawings.fromJSON(doc);
        chart.drawings.select(null);
        if (hadSelection) chart.resize();
      },
    },
    { load: getSymbolDrawings, save: (symbol, json) => saveSymbolDrawings(symbol, json, id) },
    (message) => notify('error', message),
  );
  const initial = chart.market?.symbol;
  if (initial) void drawings.start(normalizeSymbol(initial));
  const edited = () => drawings.edited();
  const stops: (() => void)[] = [
    chart.on('market:changed', ({ symbol }) => void drawings.switchTo(normalizeSymbol(symbol))),
    chart.on('drawing:created', edited),
    chart.on('drawing:edited', edited),
    chart.on('drawing:removed', edited),
    chart.on('drawing:selected', ({ ids }) => {
      selected = ids.length > 0;
    }),
  ];
  let cancelled = false;
  let unlisten: (() => void) | null = null;
  void listen<{ symbol: string; source: string }>('symbol-drawings-changed', ({ payload }) => {
    if (payload.source !== id) void drawings.remoteChanged(payload.symbol);
  }).then((stop) => {
    if (cancelled) stop();
    else unlisten = stop;
  });
  return () => {
    cancelled = true;
    unlisten?.();
    stops.forEach((stop) => stop());
    void drawings.flush();
  };
}
