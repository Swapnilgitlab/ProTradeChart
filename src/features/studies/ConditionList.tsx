import { useId } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { canonicalFeature, featureLabel, featureUnit, SUGGESTED_METRICS } from '../../studies/metrics';
import { OPS, withOp, type Condition, type Op } from '../../studies/spec';

const OP_LABELS: Record<Op, string> = {
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
  between: 'between',
  outside: 'outside',
};

/** Features offered in the pickers: the suggested ones and the price itself. */
export const FEATURE_CHOICES = [...new Set(['close', ...SUGGESTED_METRICS, 'dist_ema_21', 'dist_sma_50', 'prior_high_252', 'prior_high_63', 'range_63', 'gain_from_low_252'])];

interface Props<T extends Condition> {
  items: T[];
  onChange: (items: T[]) => void;
  /** A fresh row for the Add button. */
  make: () => T;
  /** Rows carry an `at` (bars before the event). */
  withAt?: boolean;
  /** Rows carry a label (characteristics). */
  withLabel?: boolean;
  addLabel: string;
}

/** An editable, reorderable list of conditions: `<feature> <op> <number or feature>`. A threshold on a
 *  percentage feature is typed as a percentage (100 for +100%) and stored as the fraction the engine uses. */
export function ConditionList<T extends Condition>({ items, onChange, make, withAt, withLabel, addLabel }: Props<T>) {
  const listId = useId();
  const update = (i: number, patch: Partial<T>) => onChange(items.map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="study-conditions">
      <datalist id={listId}>
        {FEATURE_CHOICES.map((f) => (
          <option key={f} value={f}>
            {featureLabel(f)}
          </option>
        ))}
      </datalist>
      {items.map((c, i) => {
        const percent = featureUnit(c.left) === 'percent';
        const rightIsFeature = typeof c.right === 'string';
        const valid = canonicalFeature(c.left) !== null && (!rightIsFeature || canonicalFeature(c.right as string) !== null);
        return (
          <div key={i} className={`study-condition${valid ? '' : ' invalid'}`}>
            {withLabel && (
              <input
                className="python-input study-cond-label"
                value={c.label ?? ''}
                placeholder="Label"
                aria-label="Label"
                onChange={(e) => update(i, { label: e.currentTarget.value } as Partial<T>)}
              />
            )}
            <input
              className="python-input study-cond-feature"
              list={listId}
              value={c.left}
              spellCheck={false}
              aria-label="Feature"
              title={featureLabel(c.left)}
              onChange={(e) => update(i, { left: e.currentTarget.value.trim() } as Partial<T>)}
            />
            <select
              className="python-input"
              value={c.op}
              aria-label="Operator"
              onChange={(e) => onChange(items.map((x, k) => (k === i ? withOp(x, e.currentTarget.value as Op) : x)))}
            >
              {OPS.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {Array.isArray(c.right) && (
              <RangeInputs
                range={c.right}
                percent={percent}
                onChange={(right) => update(i, { right } as Partial<T>)}
              />
            )}
            {!Array.isArray(c.right) && (
            <select
              className="python-input study-cond-kind"
              value={rightIsFeature ? 'feature' : 'number'}
              aria-label="Compare with"
              onChange={(e) => update(i, { right: e.currentTarget.value === 'feature' ? 'ema_200' : 0 } as Partial<T>)}
            >
              <option value="number">value</option>
              <option value="feature">feature</option>
            </select>
            )}
            {Array.isArray(c.right) ? null : rightIsFeature ? (
              <input
                className="python-input study-cond-feature"
                list={listId}
                value={c.right as string}
                spellCheck={false}
                aria-label="Other feature"
                title={featureLabel(c.right as string)}
                onChange={(e) => update(i, { right: e.currentTarget.value.trim() } as Partial<T>)}
              />
            ) : (
              <span className="study-cond-number">
                <input
                  className="python-input"
                  type="number"
                  step="any"
                  value={Number.isFinite(c.right as number) ? Number(((c.right as number) * (percent ? 100 : 1)).toPrecision(10)) : ''}
                  aria-label="Value"
                  onChange={(e) => {
                    const v = e.currentTarget.valueAsNumber;
                    update(i, { right: Number.isFinite(v) ? v / (percent ? 100 : 1) : Number.NaN } as Partial<T>);
                  }}
                />
                {percent && <span className="muted">%</span>}
              </span>
            )}
            {withAt && (
              <span className="study-cond-at">
                <input
                  className="python-input"
                  type="number"
                  min={0}
                  max={1000}
                  value={(c as unknown as { at: number }).at}
                  aria-label="Bars before the event"
                  onChange={(e) => update(i, { at: e.currentTarget.valueAsNumber } as unknown as Partial<T>)}
                />
                <span className="muted small">bars before</span>
              </span>
            )}
            <span className="study-cond-actions">
              <button type="button" className="icon-button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                <ArrowUp size={13} />
              </button>
              <button type="button" className="icon-button" aria-label="Move down" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                <ArrowDown size={13} />
              </button>
              <button type="button" className="icon-button" aria-label="Remove" title="Remove" onClick={() => onChange(items.filter((_, k) => k !== i))}>
                <X size={13} />
              </button>
            </span>
          </div>
        );
      })}
      <button type="button" className="btn btn-tiny" onClick={() => onChange([...items, make()])}>
        <Plus size={13} />
        {addLabel}
      </button>
    </div>
  );
}

/** A range condition's low and high, typed as percentages for a percentage feature. */
function RangeInputs({ range, percent, onChange }: { range: [number, number]; percent: boolean; onChange: (range: [number, number]) => void }) {
  const scale = percent ? 100 : 1;
  return (
    <span className="study-cond-number">
      {([0, 1] as const).map((end) => (
        <input
          key={end}
          className="python-input"
          type="number"
          step="any"
          value={Number.isFinite(range[end]) ? Number((range[end] * scale).toPrecision(10)) : ''}
          aria-label={end === 0 ? 'Low' : 'High'}
          onChange={(e) => {
            const v = e.currentTarget.valueAsNumber;
            const next: [number, number] = [range[0], range[1]];
            next[end] = Number.isFinite(v) ? v / scale : Number.NaN;
            onChange(next);
          }}
        />
      ))}
      {percent && <span className="muted">%</span>}
    </span>
  );
}
