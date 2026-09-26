import { useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { compareRuns, defaultCompareOffset, type CompareRow } from '../../studies/compare';
import { formatRupees, formatValue, offsetLabel } from '../../studies/metrics';
import type { StudyResultData } from '../../studies/result';

export interface ComparedRun {
  id: string;
  name: string;
  executedAt: string;
  data: StudyResultData;
}

interface Props {
  a: ComparedRun;
  b: ComparedRun;
  onOpen: (id: string) => void;
  onClose: () => void;
}

function cell(value: number | string | null, unit: CompareRow['unit']): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (unit === 'count') return value.toLocaleString();
  if (unit === 'share') return `${Math.round(value * 100)}%`;
  if (unit === 'text') return String(value);
  return unit === 'money' ? formatRupees(value) : formatValue(value, unit);
}

function gapCell(row: CompareRow): string {
  if (row.gap === null) return '';
  if (row.unit === 'percent' || row.unit === 'share') return `${row.gap > 0 ? '+' : ''}${(row.gap * 100).toFixed(1)} pts`;
  if (row.unit === 'count') return `${row.gap > 0 ? '+' : ''}${row.gap.toLocaleString()}`;
  return `${row.gap > 0 ? '+' : ''}${cell(row.gap, row.unit === 'price' || row.unit === 'volume' || row.unit === 'money' ? 'number' : row.unit)}`;
}

function Rows({ title, rows, a, b }: { title: string; rows: CompareRow[]; a: string; b: string }) {
  if (rows.length === 0) return null;
  return (
    <table className="python-table study-stats study-compare-table">
      <thead>
        <tr>
          <th>{title}</th>
          <th>{a}</th>
          <th>{b}</th>
          <th>B − A</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="numeric">{cell(r.a, r.unit)}</td>
            <td className="numeric">{cell(r.b, r.unit)}</td>
            <td className="numeric muted">{gapCell(r)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Two stored runs side by side: what differs in their specifications, then their figures where both
 *  measured the same thing. Nothing reruns; figures are medians among each run's events. */
export function CompareView({ a, b, onOpen, onClose }: Props) {
  const [offset, setOffset] = useState(() => defaultCompareOffset(a.data, b.data));
  const c = useMemo(() => compareRuns(a.data, b.data, offset), [a, b, offset]);
  const label = (r: ComparedRun, tag: string) => `${tag}: ${r.name}`;

  return (
    <div className="study-results">
      <header className="study-block-head">
        <button type="button" className="btn btn-tiny" onClick={onClose}>
          <ArrowLeft size={13} />
          Back
        </button>
        <h2 className="study-compare-title">Compare results</h2>
      </header>
      <div className="study-compare-runs">
        {([['A', a], ['B', b]] as const).map(([tag, r]) => (
          <div key={tag} className="study-tile">
            <div className="study-tile-label">{tag}</div>
            <div className="study-tile-value">{r.name}</div>
            <div className="study-tile-hint">{r.executedAt.replace('T', ' ').slice(0, 16)}</div>
            <button type="button" className="btn btn-tiny" onClick={() => onOpen(r.id)}>
              Open
            </button>
          </div>
        ))}
      </div>

      <section className="study-block">
        <h3>How the Studies differ</h3>
        {c.differences.length === 0 ? (
          <p className="muted small">The two runs have the same specification; any difference comes from the data (for example, a later run seeing newer bars).</p>
        ) : (
          <table className="python-table study-stats">
            <thead>
              <tr>
                <th>Part</th>
                <th>A</th>
                <th>B</th>
              </tr>
            </thead>
            <tbody>
              {c.differences.map((d) => (
                <tr key={d.part}>
                  <td>{d.part}</td>
                  <td className="study-wrap">{d.a}</td>
                  <td className="study-wrap">{d.b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="study-block">
        <div className="study-block-head">
          <h3>Figures</h3>
          {c.offsets.length > 0 && (
            <label className="small">
              Metrics at{' '}
              <select className="python-input" value={offset} onChange={(e) => setOffset(Number(e.currentTarget.value))}>
                {c.offsets.map((o) => (
                  <option key={o} value={o}>
                    {offsetLabel(o)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <Rows title="Summary" rows={c.summary} a={label(a, 'A')} b={label(b, 'B')} />
        <Rows title={`Median at ${offsetLabel(offset)}`} rows={c.metrics} a="A" b="B" />
        <Rows title={`Share at ${offsetLabel(offset)}`} rows={c.characteristics} a="A" b="B" />
        <Rows title="After the event" rows={c.forward} a="A" b="B" />
        {c.metrics.length === 0 && <p className="muted small">The two runs measured no metric in common.</p>}
        <p className="muted small">Each figure is among that run’s own events. Differences between runs are historical associations too.</p>
      </section>
    </div>
  );
}
