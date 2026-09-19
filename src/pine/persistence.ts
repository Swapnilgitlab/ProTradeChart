import type { IndicatorHandle } from '@luxalgo/vela';
import {
  inputDeltas,
  registerStatePersistence,
  type CellStateContext,
  type ExternalIndicatorEntry,
  type InputValue,
} from '@luxalgo/vela/plugin';
import { declaredTitle } from './source';

/** Vela saves a layout's manifest and native indicators itself, but not script indicators
 *  added at runtime — so a saved layout would silently lose every Pine script. This puts
 *  them in the layout's per-chart `ext` bag: the source travels with the layout, so a
 *  layout still opens after the script is deleted from the library or moved to another
 *  machine. */
export const PINE_STATE_KEY = 'charting.pine';

type Values = Record<string, InputValue>;

export interface SavedScript {
  id: string;
  name: string;
  source: string;
  /** Only the values that differ from the script's declared defaults. */
  inputs?: Values;
  props?: Values;
  hidden?: boolean;
}

/** The slice of an `IndicatorHandle` the mapping reads (keeps it testable without Vela). */
type HandleLike = Pick<IndicatorHandle, 'id' | 'title' | 'source' | 'inputs' | 'props' | 'visible' | 'inputValues' | 'propValues'>;

function nonEmpty(values: Values | undefined): Values | undefined {
  return values && Object.keys(values).length > 0 ? values : undefined;
}

export function toSavedScripts(handles: readonly HandleLike[]): SavedScript[] {
  const saved: SavedScript[] = [];
  for (const h of handles) {
    if (h.source === undefined) continue; // a native indicator: Vela persists those
    // `h.title` is a placeholder until the script has run; the title it declares is the real name.
    const entry: SavedScript = { id: h.id, name: declaredTitle(h.source) ?? h.title, source: h.source };
    // Deltas only, for props as for inputs: a default frozen into a layout would outlive a
    // change to the script's own declaration (Vela's `propValues()` includes the defaults).
    const inputs = nonEmpty(inputDeltas(h.inputs, h.inputValues()));
    const props = nonEmpty(inputDeltas(h.props, h.propValues()));
    if (inputs) entry.inputs = inputs;
    if (props) entry.props = props;
    if (!h.visible) entry.hidden = true;
    saved.push(entry);
  }
  return saved;
}

function isValues(v: unknown): v is Values {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean')
  );
}

/** A layout is untrusted input (a file the user was sent, an older version): keep the
 *  entries that are well-formed and drop the rest rather than fail the whole restore. */
export function parseSavedScripts(payload: unknown): SavedScript[] {
  if (!Array.isArray(payload)) return [];
  const out: SavedScript[] = [];
  const seen = new Set<string>();
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
    if (typeof r.source !== 'string' || !r.source.trim()) continue;
    seen.add(r.id);
    const entry: SavedScript = {
      id: r.id,
      name: typeof r.name === 'string' && r.name ? r.name : 'Script',
      source: r.source,
    };
    if (isValues(r.inputs)) entry.inputs = r.inputs;
    if (isValues(r.props)) entry.props = r.props;
    if (r.hidden === true) entry.hidden = true;
    out.push(entry);
  }
  return out;
}

export function toIndicatorEntry(saved: SavedScript): ExternalIndicatorEntry {
  return {
    id: saved.id,
    name: saved.name,
    script: saved.source,
    language: 'pine',
    inputs: saved.inputs,
    props: saved.props,
    hidden: saved.hidden,
  };
}

let installed = false;

export function installPinePersistence(): void {
  if (installed) return;
  installed = true;
  registerStatePersistence({
    key: PINE_STATE_KEY,
    scope: 'cell',
    serialize: (ctx: CellStateContext) => {
      const saved = toSavedScripts(ctx.chart.indicators());
      return saved.length > 0 ? saved : undefined;
    },
    restore: (payload: unknown, ctx: CellStateContext) => {
      for (const saved of parseSavedScripts(payload)) ctx.addIndicator(toIndicatorEntry(saved));
    },
  });
}
