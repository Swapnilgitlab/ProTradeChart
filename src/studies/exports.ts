/** Exports of a Study: CSV (event level, stock level, metric level), the full result as JSON, the
 *  specification, and a written report. Everything a user needs to continue outside the app. Pure. */

import type { Cell } from '../python/results';
import { answer, groupNames, measureSentence } from './answer';
import { measureLine, windowPhrase } from './measures';
import { featureLabel, featureUnit, formatValue, offsetLabel, windowLabel } from './metrics';
import type { StudyResultData, TestResult } from './result';
import { describeFinding } from './significance';
import { describeCondition } from './spec';

/** One CSV field: quoted when it holds a comma, quote or line break, and with a leading `=`, `+`,
 *  `-` or `@` defused so a spreadsheet doesn't run a symbol or a note as a formula. */
export function csvField(value: Cell | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  let text = value;
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return [columns.map(csvField).join(','), ...rows.map((r) => columns.map((_, i) => csvField(r[i])).join(','))].join('\r\n') + '\r\n';
}

/** Every event and everything measured about it: one row per event. */
export function eventsCsv(result: StudyResultData): string {
  return toCsv(result.events.columns, result.events.rows);
}

/** One row per stock: how many events it had, when, and the median of each measured column. */
export function stocksCsv(result: StudyResultData): string {
  const { columns, rows } = result.events;
  const at = (name: string) => columns.indexOf(name);
  const symbolAt = at('symbol');
  const nameAt = at('name');
  const dateAt = at('event_date');
  const numeric = columns
    .map((c, i) => ({ c, i }))
    // A measure's status and start date are words and dates, not numbers to take a median of.
    .filter(({ c }) => !['symbol', 'name', 'event_date', 'market_cap'].includes(c) && !/^measure_\d+_(status|from)$/.test(c));
  const groups = new Map<string, Cell[][]>();
  for (const row of rows) {
    const key = String(row[symbolAt] ?? '');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const header = ['symbol', 'name', 'events', 'first_event', 'last_event', ...numeric.map(({ c }) => `median_${c}`)];
  const out: Cell[][] = [];
  for (const [symbol, group] of groups) {
    const dates = group.map((r) => String(r[dateAt] ?? '')).sort();
    out.push([
      symbol,
      nameAt >= 0 ? (group[0][nameAt] ?? null) : null,
      group.length,
      dates[0] ?? null,
      dates[dates.length - 1] ?? null,
      ...numeric.map(({ i }) => median(group.map((r) => r[i]))),
    ]);
  }
  return toCsv(header, out);
}

/** One row per metric and observation point: the distribution among events and in the control group. */
export function metricsCsv(result: StudyResultData): string {
  const header = [
    'metric', 'offset_bars', 'observation', 'group', 'count', 'mean', 'median', 'min', 'max', 'p25', 'p75',
    // The test of events against the comparison group, on the events row.
    'effect_or_share_diff', 'diff_ci_low', 'diff_ci_high', 'p', 'q',
  ];
  const testCells = (t: TestResult | null, group: string): Cell[] =>
    group === 'events' && t ? [t.effect ?? t.diff, t.low, t.high, t.p, t.q] : [null, null, null, null, null];
  const out: Cell[][] = [];
  for (const s of result.stats) {
    for (const [group, st] of [['events', s.events], ['control', s.control]] as const) {
      if (!st) continue;
      out.push([s.metric, s.offset, offsetLabel(s.offset), group, st.count, st.mean, st.median, st.min, st.max, st.p25, st.p75, ...testCells(s.test, group)]);
    }
  }
  for (const c of result.characteristics) {
    for (const [group, sh] of [['events', c.events], ['control', c.control]] as const) {
      if (!sh) continue;
      out.push([`share: ${c.label}`, c.offset, offsetLabel(c.offset), group, sh.count, sh.share, null, null, null, null, null, ...testCells(c.test, group)]);
    }
  }
  for (const f of result.forward) {
    for (const [group, st] of [['events', f.events], ['control', f.control]] as const) {
      if (!st) continue;
      out.push([`fwd_return_${f.window}`, f.window, `T+${windowLabel(f.window)}`, group, st.count, st.mean, st.median, st.min, st.max, st.p25, st.p75, ...testCells(f.test, group)]);
    }
  }
  for (const m of result.measures) {
    const spec = result.spec.measures[m.index];
    for (const [group, st] of [['events', m.events], ['control', m.control]] as const) {
      if (!st) continue;
      out.push([`measure: ${m.label} (${m.stat})`, null, spec ? windowPhrase(spec.window) : '', group, st.count, st.mean, st.median, st.min, st.max, st.p25, st.p75, ...testCells(m.test, group)]);
    }
  }
  return toCsv(header, out);
}

function median(values: Cell[]): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

export function specJson(result: StudyResultData): string {
  return `${JSON.stringify(result.spec, null, 2)}\n`;
}

export function resultJson(result: StudyResultData): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const pct = (share: number | null) => (share === null ? '—' : `${Math.round(share * 100)}%`);

/** A written report in Markdown: what was asked, what data it ran on, what was found, and its limits. */
export function reportMarkdown(result: StudyResultData): string {
  const { spec, meta, summary } = result;
  const found = answer(result);
  const lines: string[] = [
    `# ${spec.name}`,
    '',
    spec.question ? `**${spec.question}**\n` : '',
    spec.description ? `${spec.description}\n` : '',
    '## Answer',
    '',
    ...found.lines.map((l) => `- ${l.text}${l.coverage ? ` ${l.coverage}` : ''}`),
    '',
    '## Study',
    '',
    `- Event: ${spec.event.conditions.map(describeCondition).join(' and ')}`,
    `- Period: ${spec.period.start} to ${spec.period.end ?? meta.data_through ?? 'latest'}`,
    `- Universe: ${spec.universe.source === 'instruments' ? `${spec.universe.exchanges.join(' + ')} equities (${spec.universe.provider})` : spec.universe.source === 'watchlist' ? `watchlist "${spec.universe.watchlist}"` : `${spec.universe.symbols.length} symbols`}`,
    ...spec.measures.map((m) => `- Measure: ${measureLine(m)}`),
    '',
    '## Findings',
    '',
    `- ${summary.events} events in ${summary.unique_symbols} stocks (${summary.first_event ?? '—'} to ${summary.last_event ?? '—'})`,
  ];
  for (const s of result.stats.filter((x) => x.offset < 0)) {
    if (!s.events.count) continue;
    const unit = featureUnit(s.metric);
    const control = s.control?.count ? `; control ${formatValue(s.control.median, unit)}` : '';
    lines.push(`- ${featureLabel(s.metric)} at ${offsetLabel(s.offset)}: median ${formatValue(s.events.median, unit)}${control}`);
  }
  for (const c of result.characteristics.filter((x) => x.offset === 0 || x.offset === -63)) {
    lines.push(`- ${c.label} at ${offsetLabel(c.offset)}: ${pct(c.events.share)} of events${c.control ? `, ${pct(c.control.share)} of control` : ''}`);
  }
  for (const f of result.forward) {
    lines.push(`- Return over the next ${windowLabel(f.window)}: median ${formatValue(f.events.median, 'percent')}, positive in ${pct(f.events.positive.share)}`);
  }
  for (const m of result.measures) {
    const spec_ = spec.measures[m.index];
    if (!spec_ || found.lines.some((l) => l.index === m.index)) continue; // headline measures are in the answer
    lines.push(`- ${measureSentence(m, spec_, groupNames(result).comparison)}`);
  }
  if (result.summary.findings.length) {
    const group = result.summary.control_kind === 'outcome' ? 'events that reached the outcome' : 'events';
    const comparison = result.summary.control_kind === 'outcome' ? 'events that didn’t' : 'control dates';
    lines.push('', '## What stands out', '', ...result.summary.findings.map((f) => `- ${describeFinding(f, group, comparison)}`));
    lines.push('', 'q-values are adjusted for all of the Study’s comparisons (Benjamini–Hochberg).');
  }
  lines.push(
    '',
    '## Data and reproducibility',
    '',
    `- Executed ${meta.executed_at} with ProTradeChart ${meta.app_version ?? '?'} (engine ${meta.engine_version ?? '?'}, Python ${meta.python_version ?? '?'}, pandas ${meta.pandas_version ?? '?'})`,
    `- Data source: ${meta.data_source ?? '—'}, ${meta.data_from ?? '—'} to ${meta.data_through ?? '—'} (data version ${meta.data_version ?? '—'})`,
    `- Symbols: ${meta.symbols_loaded} loaded of ${meta.symbols_requested}; ${meta.symbols_failed} failed; ${meta.symbols_short_history} with less history than the Study asked for`,
    '- Prices are used exactly as the data source supplied them (adjusted for corporate actions at source).',
    '',
    '## Caveats',
    '',
    ...result.warnings.map((w) => `- ${w.message}`),
    '- These are historical associations. They do not show that any characteristic caused a price move.',
    '',
  );
  return lines.filter((l, i, all) => !(l === '' && all[i - 1] === '')).join('\n');
}
