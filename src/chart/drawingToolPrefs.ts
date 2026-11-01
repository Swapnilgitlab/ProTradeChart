import type { Vela } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { getPreference, setPreference } from '../lib/ipc';

/** Each drawing tool's remembered settings (what its next drawing starts from: colours, line
 *  style, Fib levels…) and its saved styles are the user's, app-wide. Vela keeps them per
 *  workspace (and in a saved layout), so a new tab or another layout would start every tool from
 *  Vela's factory look again. Here they are one preference: laid over a chart's own when it is
 *  built, and updated one tool at a time as the user changes them, so two tabs (or windows)
 *  editing different tools don't overwrite each other. Vela validates every entry on restore,
 *  so the stored values pass through as they are. */

export const PREF_KEY = 'drawing.tools';

export interface ToolPrefs {
  defaults: Record<string, unknown>;
  templates: Record<string, unknown[]>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stored prefs, with anything malformed dropped. Pure. */
export function parseToolPrefs(raw: string | null): ToolPrefs {
  let doc: unknown = null;
  try {
    doc = raw ? JSON.parse(raw) : null;
  } catch {
    doc = null;
  }
  const out: ToolPrefs = { defaults: {}, templates: {} };
  if (!isRecord(doc)) return out;
  if (isRecord(doc.defaults)) {
    for (const [type, d] of Object.entries(doc.defaults)) if (isRecord(d)) out.defaults[type] = d;
  }
  if (isRecord(doc.templates)) {
    for (const [type, list] of Object.entries(doc.templates)) if (Array.isArray(list) && list.length > 0) out.templates[type] = list;
  }
  return out;
}

/** `prefs` with one tool's entry replaced, or removed when it has none (a reset). Pure. */
export function withTool<K extends keyof ToolPrefs>(prefs: ToolPrefs, field: K, type: string, value: ToolPrefs[K][string] | undefined): ToolPrefs {
  const next = { ...prefs[field] } as ToolPrefs[K];
  if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[type];
  else next[type] = value;
  return { ...prefs, [field]: next };
}

/** The saved settings laid over a chart's own (a layout's), the saved ones winning. Pure. */
export function layered<T>(current: Readonly<Record<string, T>>, saved: Readonly<Record<string, T>>): Record<string, T> {
  return { ...current, ...saved };
}

/** Changes are read, merged and written one at a time, in order. */
let queue: Promise<void> = Promise.resolve();

function record<K extends keyof ToolPrefs>(field: K, type: string, value: ToolPrefs[K][string] | undefined) {
  queue = queue
    .then(async () => {
      const before = parseToolPrefs(await getPreference(PREF_KEY));
      const after = withTool(before, field, type, value);
      if (JSON.stringify(after) !== JSON.stringify(before)) await setPreference(PREF_KEY, JSON.stringify(after));
    })
    .catch(() => {
      // A preference that can't be saved leaves the chart as it is; the next change tries again.
    });
}

function watch(chart: Vela): (() => void)[] {
  return [
    chart.on('drawing:defaults', ({ type }) => record('defaults', type, chart.drawings.toolDefaults()[type])),
    chart.on('drawing:templates', ({ type }) => record('templates', type, chart.drawings.toolTemplates()[type])),
  ];
}

/** Gives a newly built workspace the saved tool settings, then keeps the preference up to date
 *  with the user's changes in any of its cells. Call once per workspace, after its state is
 *  applied. Returns a function that stops. */
export function installToolPrefs(ws: VelaWorkspace): () => void {
  let stopped = false;
  const stops: (() => void)[] = [];
  void getPreference(PREF_KEY)
    .catch(() => null)
    .then((raw) => {
      if (stopped) return;
      const saved = parseToolPrefs(raw);
      // One cell is enough: the workspace mirrors a cell's tool settings onto the others. Only
      // then are changes watched, so a restored layout's own settings aren't taken as an edit.
      const drawings = ws.chart.drawings;
      drawings.setToolDefaults(layered(drawings.toolDefaults(), saved.defaults));
      drawings.setToolTemplates(layered(drawings.toolTemplates(), saved.templates));
      for (const cell of ws.cells()) stops.push(...watch(cell.chart));
      stops.push(
        ws.on('cell:created', ({ id }) => {
          const cell = ws.cells().find((c) => c.id === id);
          if (cell) stops.push(...watch(cell.chart));
        }),
      );
    });
  return () => {
    stopped = true;
    stops.forEach((stop) => stop());
  };
}
