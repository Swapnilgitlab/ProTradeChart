import { useMemo, useState } from 'react';
import { AlertTriangle, LineChart, ListPlus } from 'lucide-react';
import type { StudyEvent } from '../../chart/studyEvent';
import { displayTicker } from '../../lib/symbols';
import type { Cell } from '../../python/results';
import { featureLabel, featureUnit, formatRupees, formatValue, offsetLabel, windowLabel, type Unit } from '../../studies/metrics';
import { statFor, type Share, type Stat, type StudyResultData } from '../../studies/result';
import { describeCondition } from '../../studies/spec';
import { beforeAfterWindows, eventColumns, eventGrid, headline, liquidityBuckets, medianGap, type TableColumn } from '../../studies/views';
import { Histogram, PathChart } from './charts';

interface Props {
  result: StudyResultData;
  onOpenEvent: (event: StudyEvent) => void;
  onAddToWatchlist: (symbols: string[]) => void;
}

const pct = (s: Share | null | undefined) => (s?.share == null ? '—' : `${Math.round(s.share * 100)}%`);

function formatCellAs(value: Cell, unit: TableColumn['unit']): string {
  if (value === null) return '—';
  if (unit === 'symbol') return typeof value === 'string' ? displayTicker(value) : String(value);
  if (unit === 'date' || unit === 'text') return String(value);
  return typeof value === 'number' ? (unit === 'money' ? formatRupees(value) : formatValue(value, unit)) : String(value);
}

function columnTitle(col: TableColumn, offset: number): string {
  switch (col.key) {
    case 'symbol':
      return 'Symbol';
    case 'name':
      return 'Company';
    case 'event_date':
      return 'Event date';
    case 'event_value':
      return `Event: ${featureLabel(col.metric ?? '')}`;
    case 'price':
      return 'Price';
    case 'market_cap':
      return 'Market cap';
    case 'avg_traded_value':
      return 'Avg traded value';
    default:
      if (col.key.startsWith('fwd_return_')) return `Return next ${windowLabel(Number(col.key.slice(11)))}`;
      return `${featureLabel(col.metric ?? col.key)} (${offsetLabel(offset)})`;
  }
}

function StatCells({ stat, unit }: { stat: Stat | null; unit: Unit }) {
  if (!stat) return <td colSpan={5} className="muted">—</td>;
  return (
    <>
      <td className="numeric">{stat.count}</td>
      <td className="numeric">{formatValue(stat.median, unit)}</td>
      <td className="numeric">{formatValue(stat.mean, unit)}</td>
      <td className="numeric muted">
        {formatValue(stat.p25, unit)} – {formatValue(stat.p75, unit)}
      </td>
      <td className="numeric muted">
        {formatValue(stat.min, unit)} – {formatValue(stat.max, unit)}
      </td>
    </>
  );
}

/** The Study Results page: summary, event table, timeline, distributions, before/after, size
 *  groups, the comparison group and one event at a time. Everything drawn is text or SVG built from
 *  numbers; nothing from the result is rendered as HTML. */
export function StudyResults({ result, onOpenEvent, onAddToWatchlist }: Props) {
  const { spec, summary, meta } = result;
  const lookbacks = result.offsets.filter((o) => o < 0);
  const [tableOffset, setTableOffset] = useState<number>(0);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [metric, setMetric] = useState(spec.metrics[0]);
  const [distOffset, setDistOffset] = useState(lookbacks.includes(-63) ? -63 : (lookbacks[lookbacks.length - 1] ?? 0));
  const [compareOffset, setCompareOffset] = useState(lookbacks.includes(-63) ? -63 : (lookbacks[lookbacks.length - 1] ?? 0));
  const [selected, setSelected] = useState(0);

  const controlLabel =
    summary.control_kind === 'outcome' ? 'Events that didn’t reach the outcome' : summary.control_kind === 'random' ? 'Control dates' : null;
  const groupLabel = summary.control_kind === 'outcome' ? 'Reached the outcome' : 'Events';
  const columns = useMemo(() => eventColumns(result, tableOffset), [result, tableOffset]);
  const rows = useMemo(() => {
    const indexed = result.events.rows.map((row, i) => ({ row, i }));
    if (!sort) return indexed;
    const at = result.events.columns.indexOf(sort.key);
    return indexed.sort((a, b) => {
      const x = a.row[at];
      const y = b.row[at];
      if (x === null) return 1;
      if (y === null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [result, sort]);
  const symbols = useMemo(() => {
    const i = result.events.columns.indexOf('symbol');
    return [...new Set(result.events.rows.map((r) => r[i]).filter((s): s is string => typeof s === 'string'))];
  }, [result]);
  const hist = result.histograms.find((h) => h.metric === metric && h.offset === distOffset);
  const pairs = beforeAfterWindows(result);
  const buckets = liquidityBuckets(result);
  const selectedRow = result.events.rows[selected] ?? null;
  const at = (key: string) => result.events.columns.indexOf(key);
  const openRow = (row: Cell[]) => {
    const symbol = row[at('symbol')];
    const date = row[at('event_date')];
    if (typeof symbol === 'string' && typeof date === 'string') onOpenEvent({ symbol, date, label: spec.event.label });
  };
  const returnStat = (window: number) => statFor(result, `return_${window}`, 0);

  return (
    <div className="study-results">
      <header className="study-results-header">
        <div>
          <h2>{spec.name}</h2>
          <div className="study-headline">{headline(result)}</div>
          <div className="muted small">
            {spec.event.conditions.map(describeCondition).join(' and ')} ·{' '}
            {spec.universe.source === 'instruments' ? spec.universe.exchanges.join(' + ') : spec.universe.source === 'watchlist' ? `Watchlist “${spec.universe.watchlist}”` : `${spec.universe.symbols.length} symbols`}
            {spec.universe.min_avg_traded_value !== null && ` · Avg traded value ≥ ${formatRupees(spec.universe.min_avg_traded_value)}/day`}
          </div>
        </div>
      </header>

      <div className="study-caveats" role="note">
        <AlertTriangle size={14} />
        <div>
          <strong>Historical association, not causation.</strong> These figures describe what qualifying stocks looked like; they don’t
          show that any characteristic caused a move.
          {result.warnings.map((w) => (
            <div key={w.code} className="small">
              {w.message}
            </div>
          ))}
        </div>
      </div>

      <section className="study-block">
        <h3>1 · Summary</h3>
        <div className="study-tiles">
          <Tile label="Events" value={summary.events.toLocaleString()} />
          <Tile label="Unique stocks" value={summary.unique_symbols.toLocaleString()} />
          <Tile label="First – last event" value={`${summary.first_event ?? '—'} – ${summary.last_event ?? '—'}`} />
          {spec.lookback_windows
            .filter((w) => returnStat(w))
            .reverse()
            .map((w) => (
              <Tile key={w} label={`Median ${windowLabel(w)} return into the event`} value={formatValue(returnStat(w)?.events.median, 'percent')} />
            ))}
          <Tile label="Median avg traded value" value={summary.median_avg_traded_value === null ? '—' : formatRupees(summary.median_avg_traded_value)} />
          <Tile label="Market cap" value="Unavailable" muted />
          <Tile
            label="Data coverage"
            value={`${meta.symbols_loaded} of ${meta.symbols_requested} symbols`}
            hint={
              [
                meta.symbols_short_history ? `${meta.symbols_short_history} with shorter history` : null,
                meta.listings_skipped ? `${meta.listings_skipped} non-stock listings left out` : null,
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
          />
          <Tile label="Data through" value={meta.data_through ?? '—'} hint={meta.data_source ?? undefined} />
          <Tile label="Executed" value={meta.executed_at.replace('T', ' ').slice(0, 16)} hint={`data version ${meta.data_version ?? '—'}`} />
        </div>
        {summary.outcome && (
          <p className="small muted">
            Outcome ({Math.round((spec.outcome?.min_return ?? 0) * 100)}% within {windowLabel(spec.outcome?.window ?? 0)}): {summary.outcome.met} reached it,{' '}
            {summary.outcome.not_met} didn’t, {summary.outcome.unknown} too recent to tell.
          </p>
        )}
      </section>

      <section className="study-block">
        <div className="study-block-head">
          <h3>2 · Events</h3>
          <label className="small">
            Metrics at{' '}
            <select className="python-input" value={tableOffset} onChange={(e) => setTableOffset(Number(e.currentTarget.value))}>
              {result.offsets.map((o) => (
                <option key={o} value={o}>
                  {offsetLabel(o)}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small">
            {result.events.total.toLocaleString()} events{result.events.rows.length < result.events.total && `, the first ${result.events.rows.length.toLocaleString()} listed`}
          </span>
          {symbols.length > 0 && (
            <button type="button" className="btn btn-tiny" onClick={() => onAddToWatchlist(symbols)}>
              <ListPlus size={13} />
              Add {symbols.length} to a watchlist
            </button>
          )}
        </div>
        <div className="python-table-scroll study-table-scroll">
          <table className="python-table study-table">
            <thead>
              <tr>
                <th />
                {columns.map((c) => (
                  <th key={c.key} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                    <button
                      type="button"
                      onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}
                    >
                      {columnTitle(c, tableOffset)}
                      {sort?.key === c.key && <span aria-hidden="true">{sort.dir === 1 ? ' ▲' : ' ▼'}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ row, i }) => (
                <tr key={i} className={i === selected ? 'selected' : undefined} onClick={() => setSelected(i)}>
                  <td>
                    <button
                      type="button"
                      className="icon-button"
                      title="Open the chart at this event"
                      aria-label="Open the chart at this event"
                      onClick={(e) => {
                        e.stopPropagation();
                        openRow(row);
                      }}
                    >
                      <LineChart size={13} />
                    </button>
                  </td>
                  {columns.map((c) => (
                    <td key={c.key} className={c.unit === 'text' || c.unit === 'symbol' || c.unit === 'date' ? undefined : 'numeric'}>
                      {formatCellAs(row[c.index], c.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="study-block">
        <h3>3 · Event timeline</h3>
        <p className="muted small">Price relative to the close on the event day, across all events. Open any event on its chart from the table.</p>
        {result.path ? <PathChart path={result.path} control={result.control_path} controlLabel={controlLabel ?? 'Control'} /> : <div className="study-empty muted small">No events to draw.</div>}
      </section>

      <section className="study-block">
        <div className="study-block-head">
          <h3>4 · Characteristics</h3>
          <select className="python-input" value={metric} aria-label="Metric" onChange={(e) => setMetric(e.currentTarget.value)}>
            {spec.metrics.map((m) => (
              <option key={m} value={m}>
                {featureLabel(m)}
              </option>
            ))}
          </select>
          <select className="python-input" value={distOffset} aria-label="Observation point" onChange={(e) => setDistOffset(Number(e.currentTarget.value))}>
            {result.offsets.map((o) => (
              <option key={o} value={o}>
                {offsetLabel(o)}
              </option>
            ))}
          </select>
        </div>
        {hist ? (
          <Histogram edges={hist.edges} events={hist.events} control={hist.control} unit={featureUnit(metric)} controlLabel={controlLabel} />
        ) : (
          <div className="study-empty muted small">No values for {featureLabel(metric)} at {offsetLabel(distOffset)}.</div>
        )}
        <table className="python-table study-stats">
          <thead>
            <tr>
              <th>Group</th>
              <th>Count</th>
              <th>Median</th>
              <th>Mean</th>
              <th>25th – 75th pct</th>
              <th>Min – max</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{groupLabel}</td>
              <StatCells stat={statFor(result, metric, distOffset)?.events ?? null} unit={featureUnit(metric)} />
            </tr>
            {controlLabel && (
              <tr>
                <td>{controlLabel}</td>
                <StatCells stat={statFor(result, metric, distOffset)?.control ?? null} unit={featureUnit(metric)} />
              </tr>
            )}
          </tbody>
        </table>
        {spec.characteristics.length > 0 && (
          <div className="python-table-scroll">
            <table className="python-table study-stats">
              <thead>
                <tr>
                  <th>Share of {groupLabel.toLowerCase()} with…</th>
                  {result.offsets.map((o) => (
                    <th key={o}>{offsetLabel(o)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spec.characteristics.map((c, k) => (
                  <tr key={k}>
                    <td>{c.label}</td>
                    {result.offsets.map((o) => {
                      const item = result.characteristics.find((x) => x.index === k && x.offset === o);
                      return (
                        <td key={o} className="numeric" title={item ? `${item.events.true} of ${item.events.count}` : undefined}>
                          {pct(item?.events)}
                          {item?.control && <span className="muted small"> / {pct(item.control)}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {controlLabel && <p className="muted small">Second figure: {controlLabel.toLowerCase()}.</p>}
          </div>
        )}
      </section>

      <section className="study-block">
        <h3>5 · Before vs after</h3>
        {pairs.length === 0 ? (
          <p className="muted small">No forward window matches a look-back window, so there is nothing to pair.</p>
        ) : (
          <div className="python-table-scroll">
            <table className="python-table study-stats">
              <thead>
                <tr>
                  <th>Median</th>
                  {pairs.map((w) => (
                    <th key={w} colSpan={2}>
                      {windowLabel(w)} before · after
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {spec.metrics.map((m) => (
                  <tr key={m}>
                    <td>{featureLabel(m)}</td>
                    {pairs.map((w) => (
                      <PairCells key={w} before={statFor(result, m, -w)?.events.median ?? null} after={statFor(result, m, w)?.events.median ?? null} unit={featureUnit(m)} />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <table className="python-table study-stats">
          <thead>
            <tr>
              <th>Forward return</th>
              <th>Group</th>
              <th>Count</th>
              <th>Median</th>
              <th>25th – 75th pct</th>
              <th>Positive</th>
              <th>Median best gain</th>
              <th>Median worst fall</th>
            </tr>
          </thead>
          <tbody>
            {result.forward.flatMap((f) =>
              [
                [groupLabel, f.events],
                [controlLabel, f.control],
              ]
                .filter((pair): pair is [string, NonNullable<typeof f.control>] => pair[0] !== null && pair[1] !== null)
                .map(([label, s]) => (
                  <tr key={`${f.window}-${label}`}>
                    <td>Next {windowLabel(f.window)}</td>
                    <td>{label}</td>
                    <td className="numeric">{s.count}</td>
                    <td className="numeric">{formatValue(s.median, 'percent')}</td>
                    <td className="numeric muted">
                      {formatValue(s.p25, 'percent')} – {formatValue(s.p75, 'percent')}
                    </td>
                    <td className="numeric">{pct(s.positive)}</td>
                    <td className="numeric">{formatValue(s.max_gain_median, 'percent')}</td>
                    <td className="numeric">{formatValue(s.max_drawdown_median, 'percent')}</td>
                  </tr>
                )),
            )}
          </tbody>
        </table>
      </section>

      <section className="study-block">
        <h3>6 · Market and sector</h3>
        <p className="muted small">
          No sector or industry metadata and no market cap are available from the data sources, so events aren’t grouped by them. By
          liquidity at the event instead (50-day average traded value):
        </p>
        {buckets.length > 0 && (
          <table className="python-table study-stats">
            <thead>
              <tr>
                <th>Average traded value</th>
                <th>Events</th>
                {spec.forward_windows.map((w) => (
                  <th key={w}>Median next {windowLabel(w)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.label}>
                  <td>{b.label}</td>
                  <td className="numeric">{b.events}</td>
                  {b.forward.map((v, i) => (
                    <td key={i} className="numeric">
                      {formatValue(v, 'percent')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="study-block">
        <div className="study-block-head">
          <h3>7 · {summary.control_kind === 'outcome' ? 'Reached the outcome vs didn’t' : 'Events vs control group'}</h3>
          <select className="python-input" value={compareOffset} aria-label="Observation point" onChange={(e) => setCompareOffset(Number(e.currentTarget.value))}>
            {result.offsets.map((o) => (
              <option key={o} value={o}>
                {offsetLabel(o)}
              </option>
            ))}
          </select>
        </div>
        {!controlLabel ? (
          <p className="muted small">This Study has no comparison group. Turn on the control group in Edit to compare with non-events.</p>
        ) : (
          <>
            <p className="muted small">
              {summary.control_kind === 'outcome'
                ? `Among the events: those that went on to the outcome against those that didn't (${summary.control_samples} of them).`
                : `${summary.control_samples} random dates from the same universe and period, passing the same filters, with no event within ${spec.event.cooldown_days} bars.`}{' '}
              A difference is a historical association only.
            </p>
            <table className="python-table study-stats">
              <thead>
                <tr>
                  <th>Median at {offsetLabel(compareOffset)}</th>
                  <th>{groupLabel}</th>
                  <th>{controlLabel}</th>
                  <th>Difference</th>
                </tr>
              </thead>
              <tbody>
                {spec.metrics.map((m) => {
                  const s = statFor(result, m, compareOffset);
                  const unit = featureUnit(m);
                  return (
                    <tr key={m}>
                      <td>{featureLabel(m)}</td>
                      <td className="numeric">{formatValue(s?.events.median, unit)}</td>
                      <td className="numeric">{formatValue(s?.control?.median, unit)}</td>
                      <td className="numeric muted">{formatGap(medianGap(s?.events, s?.control), unit)}</td>
                    </tr>
                  );
                })}
                {spec.characteristics.map((c, k) => {
                  const item = result.characteristics.find((x) => x.index === k && x.offset === compareOffset);
                  return (
                    <tr key={`c${k}`}>
                      <td>{c.label}</td>
                      <td className="numeric">{pct(item?.events)}</td>
                      <td className="numeric">{pct(item?.control)}</td>
                      <td className="numeric muted">
                        {item?.events.share != null && item.control?.share != null ? `${Math.round((item.events.share - item.control.share) * 100)} pts` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="study-block">
        <h3>8 · Stock explorer</h3>
        {selectedRow ? (
          <>
            <div className="study-explorer-head">
              <div>
                <strong>{displayTicker(String(selectedRow[at('symbol')] ?? ''))}</strong>{' '}
                <span className="muted">{typeof selectedRow[at('name')] === 'string' ? selectedRow[at('name')] : ''}</span>
                <div className="small">
                  Event {String(selectedRow[at('event_date')] ?? '—')} · price {formatCellAs(selectedRow[at('price')], 'price')} · event value{' '}
                  {formatValue(selectedRow[at('event_value')] as number | null, featureUnit(spec.event.conditions[0].left))} · avg traded value{' '}
                  {formatCellAs(selectedRow[at('avg_traded_value')], 'money')} · market cap unavailable
                </div>
              </div>
              <button type="button" className="btn btn-tiny btn-primary" onClick={() => openRow(selectedRow)}>
                <LineChart size={13} />
                Open chart at the event
              </button>
            </div>
            <div className="python-table-scroll">
              <table className="python-table study-stats">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {result.offsets.map((o) => (
                      <th key={o}>{offsetLabel(o)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {eventGrid(result, selectedRow).map((g) => (
                    <tr key={g.metric}>
                      <td>{featureLabel(g.metric)}</td>
                      {g.values.map((v, i) => (
                        <td key={i} className={`numeric${result.offsets[i] === 0 ? ' study-t0' : ''}`}>
                          {formatValue(v, featureUnit(g.metric))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">Pick another event in the table above.</p>
          </>
        ) : (
          <p className="muted small">No events.</p>
        )}
      </section>

      <footer className="study-repro muted small">
        Reproducibility: spec v{spec.version} · engine {meta.engine_version ?? '?'} · app {meta.app_version ?? '?'} · Python {meta.python_version ?? '?'} · pandas{' '}
        {meta.pandas_version ?? '?'} · data {meta.data_from ?? '?'} to {meta.data_through ?? '?'} ({meta.data_version ?? '?'}) · took {meta.elapsed_seconds ?? '?'} s
        {Object.keys(meta.timings).length > 0 && ` (${Object.entries(meta.timings).map(([stage, sec]) => `${stage.replace(/_/g, ' ')} ${sec} s`).join(', ')})`}. Prices
        are used as the data source supplied them (adjusted for corporate actions at source).
      </footer>
    </div>
  );
}

/** A difference of medians: percentage points for percentages, the unit's own form otherwise. */
function formatGap(gap: number | null, unit: Unit): string {
  if (gap === null) return '—';
  if (unit === 'percent') return `${gap > 0 ? '+' : ''}${(gap * 100).toFixed(1)} pts`;
  if (unit === 'money') return `${gap > 0 ? '+' : ''}${formatRupees(gap)}`;
  return `${gap > 0 ? '+' : ''}${formatValue(gap, unit === 'price' || unit === 'volume' ? 'number' : unit)}`;
}

function Tile({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div className={`study-tile${muted ? ' muted' : ''}`}>
      <div className="study-tile-label">{label}</div>
      <div className="study-tile-value">{value}</div>
      {hint && <div className="study-tile-hint">{hint}</div>}
    </div>
  );
}

function PairCells({ before, after, unit }: { before: number | null; after: number | null; unit: Unit }) {
  return (
    <>
      <td className="numeric">{formatValue(before, unit)}</td>
      <td className="numeric">{formatValue(after, unit)}</td>
    </>
  );
}
