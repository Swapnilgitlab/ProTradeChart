/** Two stored runs side by side: how their specifications differ, and what each measured where they
 *  overlap. Read-only — nothing reruns. Pure. */

import { measureUnit, STAT_LABEL, type MeasureUnit } from './measures';
import { featureLabel, featureUnit, windowLabel, type Unit } from './metrics';
import type { StudyResultData } from './result';
import { interpret, type StudySpec } from './spec';

export interface SpecDifference {
  part: string;
  a: string;
  b: string;
}

/** The parts of two specs that differ, in the builder's own words (`interpret`). */
export function specChanges(a: StudySpec, b: StudySpec): SpecDifference[] {
  const read = (spec: StudySpec) => new Map(interpret(spec).map((p) => [p.heading, p.lines.join('; ')]));
  const ia = read(a);
  const ib = read(b);
  const parts = [...new Set([...ia.keys(), ...ib.keys()])];
  return parts
    .map((part) => ({ part, a: ia.get(part) ?? '—', b: ib.get(part) ?? '—' }))
    .filter((d) => d.a !== d.b);
}

/** How two runs' specifications differ. */
export function specDifferences(a: StudyResultData, b: StudyResultData): SpecDifference[] {
  return specChanges(a.spec, b.spec);
}

export interface CompareRow {
  label: string;
  unit: Unit | 'count' | 'text' | 'share';
  a: number | string | null;
  b: number | string | null;
  /** b − a, for numbers. */
  gap: number | null;
}

export interface Comparison {
  differences: SpecDifference[];
  /** Observation points both runs measured. */
  offsets: number[];
  summary: CompareRow[];
  metrics: CompareRow[];
  characteristics: CompareRow[];
  forward: CompareRow[];
  /** Measures both runs have (same label and stat): the median per event. */
  measures: CompareRow[];
}

function measureCompareUnit(unit: MeasureUnit): CompareRow['unit'] {
  if (unit === 'bars' || unit === 'count') return 'count';
  if (unit === 'points') return 'percent';
  return unit;
}

const gap = (a: number | null, b: number | null) => (a !== null && b !== null ? b - a : null);

function numberRow(label: string, unit: CompareRow['unit'], a: number | null, b: number | null): CompareRow {
  return { label, unit, a, b, gap: gap(a, b) };
}

/** Everything both runs can be compared on. `offset` picks the observation point for the metrics and
 *  characteristics; it falls back to the latest shared point before the event. */
export function compareRuns(a: StudyResultData, b: StudyResultData, offset?: number): Comparison {
  const offsets = a.offsets.filter((o) => b.offsets.includes(o));
  const at = offset !== undefined && offsets.includes(offset) ? offset : ([...offsets].reverse().find((o) => o < 0) ?? offsets[0] ?? 0);
  const median = (r: StudyResultData, metric: string) => r.stats.find((s) => s.metric === metric && s.offset === at)?.events.median ?? null;
  const share = (r: StudyResultData, label: string) => r.characteristics.find((c) => c.label === label && c.offset === at)?.events.share ?? null;
  const fwd = (r: StudyResultData, window: number) => r.forward.find((f) => f.window === window)?.events.median ?? null;

  const summary: CompareRow[] = [
    numberRow('Events', 'count', a.summary.events, b.summary.events),
    numberRow('Unique stocks', 'count', a.summary.unique_symbols, b.summary.unique_symbols),
    { label: 'First – last event', unit: 'text', a: `${a.summary.first_event ?? '—'} – ${a.summary.last_event ?? '—'}`, b: `${b.summary.first_event ?? '—'} – ${b.summary.last_event ?? '—'}`, gap: null },
    numberRow('Comparison dates', 'count', a.summary.control_samples, b.summary.control_samples),
    numberRow('Differences that stand out', 'count', a.summary.findings.length, b.summary.findings.length),
    { label: 'Data through', unit: 'text', a: a.meta.data_through, b: b.meta.data_through, gap: null },
  ];
  const metrics = a.spec.metrics
    .filter((m) => b.spec.metrics.includes(m))
    .map((m) => numberRow(featureLabel(m), featureUnit(m), median(a, m), median(b, m)));
  const labels = a.spec.characteristics.map((c) => c.label ?? '').filter((l) => l && b.spec.characteristics.some((c) => c.label === l));
  const characteristics = labels.map((l) => numberRow(l, 'share', share(a, l), share(b, l)));
  const forward = a.spec.forward_windows
    .filter((w) => b.spec.forward_windows.includes(w))
    .map((w) => numberRow(`Median return, next ${windowLabel(w)}`, 'percent', fwd(a, w), fwd(b, w)));
  const measures = a.measures.flatMap((ma) => {
    const mb = b.measures.find((x) => x.label === ma.label && x.stat === ma.stat);
    const spec = a.spec.measures[ma.index];
    if (!mb || !spec) return [];
    return [numberRow(`${ma.label} (${STAT_LABEL[ma.stat].toLowerCase()})`, measureCompareUnit(measureUnit(spec)), ma.events.median, mb.events.median)];
  });
  return { differences: specDifferences(a, b), offsets, summary, metrics, characteristics, forward, measures };
}

/** The observation point `compareRuns` settled on, for a selector's initial value. */
export function defaultCompareOffset(a: StudyResultData, b: StudyResultData): number {
  const shared = a.offsets.filter((o) => b.offsets.includes(o));
  return [...shared].reverse().find((o) => o < 0) ?? shared[0] ?? 0;
}
