import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, HelpCircle, Plus, Trash2, X } from 'lucide-react';
import { useDismiss } from '../../components/useDismiss';
import {
  chipText,
  compareChoices,
  exampleOf,
  familyOf,
  filterValid,
  INTERVAL_LABELS,
  intervalOf,
  LENGTHS,
  paramOf,
  PERIODS,
  PICKER,
  titleOf,
  valueScale,
  valueSuffix,
  windowOf,
  withFamily,
  withWindow,
  type PickerEntry,
} from '../../screener/catalog';
import { INTERVALS, windowLabel, withInterval, type Interval } from '../../studies/metrics';
import { OPS, RANGE_OPS, withOp, type Condition, type Op } from '../../studies/spec';

const OP_LABELS: Record<Op, string> = {
  '>': 'Above',
  '>=': 'Above or equal',
  '<': 'Below',
  '<=': 'Below or equal',
  crosses_above: 'Crosses above',
  crosses_below: 'Crosses below',
  between: 'Between',
  outside: 'Outside',
};

interface Props {
  items: Condition[];
  onChange: (items: Condition[]) => void;
}

/** A screen's filters as TradingView-style chips ("Chg > 2%", "Price ≥ EMA, 50"): a chip opens its own
 *  editor — the feature's window and interval, the condition, and a value, a range or another feature
 *  picked by family, window and interval. **+** adds one from a grouped, searchable list. Study Builder
 *  keeps the always-expanded `ConditionList` — this is the Screener's own. */
export function FilterChips({ items, onChange }: Props) {
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  useDismiss(popoverRef, editing !== null, () => setEditing(null));
  useDismiss(addRef, adding, () => setAdding(false));

  const replace = (i: number, c: Condition) => onChange(items.map((x, k) => (k === i ? c : x)));
  const remove = (i: number) => {
    onChange(items.filter((_, k) => k !== i));
    setEditing((e) => (e === i ? null : e !== null && e > i ? e - 1 : e));
  };
  const add = (entry: PickerEntry) => {
    onChange([...items, { ...entry.condition }]);
    setAdding(false);
    setEditing(items.length);
  };

  return (
    <div className="screener-filter-chips">
      {items.map((c, i) => (
        <span key={i} className="menu-anchor">
          <span className={`screener-filter-chip${filterValid(c) ? '' : ' invalid'}`}>
            <button type="button" className="screener-filter-chip-text" title={titleOf(c.left)} onClick={() => setEditing(editing === i ? null : i)}>
              {chipText(c)}
            </button>
            <button type="button" className="icon-button" aria-label={`Remove ${chipText(c)}`} onClick={() => remove(i)}>
              <X size={11} />
            </button>
          </span>
          {editing === i && (
            <div className="screener-filter-popover" ref={popoverRef} role="dialog" aria-label={`Edit ${titleOf(c.left)}`}>
              <FilterEditor condition={c} onChange={(next) => replace(i, next)} onClose={() => setEditing(null)} onDelete={() => remove(i)} />
            </div>
          )}
        </span>
      ))}

      <span className="menu-anchor" ref={addRef}>
        <button
          type="button"
          className="icon-button screener-add-column-btn"
          aria-label="Add a filter"
          aria-haspopup="menu"
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={14} />
        </button>
        {adding && <FilterPicker onPick={add} />}
      </span>
    </div>
  );
}

/** The grouped, searchable add-filter menu. */
function FilterPicker({ onPick }: { onPick: (entry: PickerEntry) => void }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PICKER.map((g) => ({ ...g, entries: g.entries.filter((e) => !q || e.label.toLowerCase().includes(q) || g.category.toLowerCase().includes(q)) })).filter(
      (g) => g.entries.length > 0,
    );
  }, [query]);
  return (
    <div className="menu left screener-filter-picker" role="menu">
      <input className="python-input" placeholder="Search filters" value={query} autoFocus onChange={(e) => setQuery(e.currentTarget.value)} />
      {groups.map((g) => (
        <div key={g.category}>
          <div className="menu-heading">{g.category}</div>
          {g.entries.map((e) => (
            <button key={e.label} type="button" role="menuitem" className="menu-item" onClick={() => onPick(e)}>
              <span className="grow">{e.label}</span>
            </button>
          ))}
        </div>
      ))}
      {groups.length === 0 && <div className="muted small screener-filter-none">No filter matches.</div>}
    </div>
  );
}

interface EditorProps {
  condition: Condition;
  onChange: (c: Condition) => void;
  onClose: () => void;
  onDelete: () => void;
}

function FilterEditor({ condition: c, onChange, onClose, onDelete }: EditorProps) {
  const rightIsFeature = typeof c.right === 'string';
  const range = RANGE_OPS.includes(c.op);
  const pickDefault = PICKER.flatMap((g) => g.entries).find((e) => familyOf(e.condition.left) === familyOf(c.left));

  return (
    <>
      <div className="screener-filter-head">
        <button type="button" className="icon-button" aria-label="Back" title="Back" onClick={onClose}>
          <ChevronLeft size={15} />
        </button>
        <span className="screener-filter-title">{titleOf(c.left)}</span>
        <button type="button" className="icon-button" aria-label="About this feature" title="See Indicator reference in Help for what this measures">
          <HelpCircle size={13} />
        </button>
        {pickDefault && (
          <button type="button" className="screener-filter-reset" onClick={() => onChange({ ...pickDefault.condition, left: c.left })}>
            Reset
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Delete this filter" title="Delete" onClick={onDelete}>
          <Trash2 size={14} />
        </button>
      </div>
      <FeatureParams name={c.left} onChange={(left) => onChange({ ...c, left })} />

      <label className="study-field">
        <span>Condition</span>
        <select className="python-input" value={c.op} onChange={(e) => onChange(withOp(c, e.currentTarget.value as Op))}>
          {OPS.map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
      </label>

      {range ? (
        <div className="screener-filter-range">
          <ValueInput label="From" name={c.left} value={(c.right as [number, number])[0]} onChange={(v) => onChange({ ...c, right: [v, (c.right as [number, number])[1]] })} />
          <ValueInput label="To" name={c.left} value={(c.right as [number, number])[1]} onChange={(v) => onChange({ ...c, right: [(c.right as [number, number])[0], v] })} />
        </div>
      ) : (
        <>
          <label className="study-field">
            <span>Compare with</span>
            <select
              className="python-input"
              value={rightIsFeature ? 'feature' : 'number'}
              onChange={(e) =>
                onChange({ ...c, right: e.currentTarget.value === 'feature' ? withInterval(defaultOther(c.left), intervalOf(c.left)) : Number.NaN })
              }
            >
              <option value="number">Value</option>
              <option value="feature">Indicator or price</option>
            </select>
          </label>
          {rightIsFeature ? (
            <OtherFeature left={c.left} name={c.right as string} onChange={(right) => onChange({ ...c, right })} />
          ) : (
            <ValueInput label="Value" name={c.left} value={c.right as number} onChange={(right) => onChange({ ...c, right })} />
          )}
        </>
      )}
    </>
  );
}

/** The first other family of the same unit: a price compares with an EMA, a percentage with a percentage. */
function defaultOther(left: string): string {
  const choices = compareChoices(left).filter((x) => x.key !== familyOf(left));
  return choices.find((x) => x.key === 'ema')?.example ?? choices[0]?.example ?? exampleOf('ema');
}

/** A feature's window (length or period) and interval, as the small pickers under its title. */
function FeatureParams({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  const window = windowOf(name);
  const param = paramOf(name);
  return (
    <div className="screener-filter-params">
      {window !== null && param === 'length' && <LengthSelect value={window} onChange={(n) => onChange(withWindow(name, n))} />}
      {window !== null && param === 'period' && <PeriodSelect value={window} onChange={(n) => onChange(withWindow(name, n))} />}
      <select
        className="screener-filter-param"
        aria-label="Interval"
        value={intervalOf(name)}
        onChange={(e) => onChange(withInterval(name, e.currentTarget.value as Interval))}
      >
        {INTERVALS.map((tf) => (
          <option key={tf} value={tf}>
            {INTERVAL_LABELS[tf]}
          </option>
        ))}
      </select>
    </div>
  );
}

function LengthSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const options = [...new Set<number>([...LENGTHS, value])].sort((a, b) => a - b);
  return (
    <select className="screener-filter-param" aria-label="Length" value={value} onChange={(e) => onChange(Number(e.currentTarget.value))}>
      {options.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </select>
  );
}

function PeriodSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <select className="screener-filter-param" aria-label="Period" value={value} onChange={(e) => onChange(Number(e.currentTarget.value))}>
      {!PERIODS.some(([n]) => n === value) && <option value={value}>{windowLabel(value)}</option>}
      {PERIODS.map(([n, label]) => (
        <option key={n} value={n}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** The other side of a comparison: a family of the same unit, with its own window and interval. */
function OtherFeature({ left, name, onChange }: { left: string; name: string; onChange: (name: string) => void }) {
  const choices = compareChoices(left);
  const family = familyOf(name);
  return (
    <div className="study-field">
      <select className="python-input" aria-label="Indicator or price" value={family ?? ''} onChange={(e) => onChange(withFamily(name, e.currentTarget.value))}>
        {family && !choices.some((x) => x.key === family) && <option value={family}>{titleOf(name)}</option>}
        {choices.map((x) => (
          <option key={x.key} value={x.key}>
            {x.title}
          </option>
        ))}
      </select>
      <FeatureParams name={name} onChange={onChange} />
    </div>
  );
}

/** A threshold typed in the feature's unit: a percentage as a percentage, with its suffix. */
function ValueInput({ label, name, value, onChange }: { label: string; name: string; value: number; onChange: (v: number) => void }) {
  const scale = valueScale(name);
  const suffix = valueSuffix(name);
  return (
    <label className="study-field screener-filter-value">
      <span>{label}</span>
      <span className="screener-filter-value-input">
        <input
          className="python-input"
          type="number"
          step="any"
          placeholder="Enter value"
          value={Number.isFinite(value) ? Number((value * scale).toPrecision(10)) : ''}
          onChange={(e) => {
            const v = e.currentTarget.valueAsNumber;
            onChange(Number.isFinite(v) ? v / scale : Number.NaN);
          }}
        />
        {suffix && <span className="muted">{suffix}</span>}
      </span>
    </label>
  );
}
