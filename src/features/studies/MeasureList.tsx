import { useId } from 'react';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { measureKind, STAT_LABEL, WINDOW_PRESETS } from '../../studies/measures';
import { featureLabel } from '../../studies/metrics';
import { CONDITION_STATS, FEATURE_STATS, LIMITS, PRICE_STATS, type Condition, type Measure, type MeasureStat } from '../../studies/spec';
import { ConditionList, FEATURE_CHOICES } from './ConditionList';
import { WindowPicker } from './WindowPicker';

interface Props {
  items: Measure[];
  onChange: (items: Measure[]) => void;
}

const GROUPS: [string, readonly MeasureStat[]][] = [
  ['Days on which conditions held', CONDITION_STATS],
  ['A feature over the window', FEATURE_STATS],
  ['The price over the window', PRICE_STATS],
];

const preset = (id: string) => structuredClone(WINDOW_PRESETS.find((p) => p.id === id)!.window);

/** A new measure: the share of days above the 50 EMA in the 12 months up to the event. */
function fresh(headline: boolean): Measure {
  return {
    label: 'Closed above its 50 EMA',
    stat: 'share',
    conditions: [{ left: 'close', op: '>', right: 'ema_50' }],
    feature: null,
    window: preset('before_12m'),
    headline,
  };
}

/** A measure with another stat, keeping what still applies and filling in what the new one needs. */
function withStat(m: Measure, stat: MeasureStat): Measure {
  const next: Measure = { ...m, stat };
  if (measureKind(stat) === 'condition' && next.conditions.length === 0) next.conditions = [{ left: 'close', op: '>', right: 'ema_50' }];
  if (measureKind(stat) === 'feature' && !next.feature) next.feature = 'rsi_14';
  // A fixed window is the same length for every event: length needs one that starts on a found day.
  if (stat === 'length' && !('find' in next.window.start) && !('find' in next.window.end)) next.window = preset('from_low_12m');
  return next;
}

/** What the Study reads over time: one card per measure. Each gives one number per event over its
 *  window — the journey to the event, its aftermath, or an episode between two found days. */
export function MeasureList({ items, onChange }: Props) {
  const listId = useId();
  const headlines = items.filter((m) => m.headline).length;
  const update = (i: number, next: Measure) => onChange(items.map((m, k) => (k === i ? next : m)));
  const move = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="study-measures">
      <datalist id={listId}>
        {FEATURE_CHOICES.map((f) => (
          <option key={f} value={f}>
            {featureLabel(f)}
          </option>
        ))}
      </datalist>
      {items.map((m, i) => {
        const kind = measureKind(m.stat);
        return (
          <div key={i} className="study-measure">
            <div className="study-measure-head">
              <input
                className="python-input study-measure-label"
                value={m.label}
                placeholder="What this measures, in a few words"
                aria-label="Measure label"
                maxLength={LIMITS.label}
                onChange={(e) => update(i, { ...m, label: e.currentTarget.value })}
              />
              <label className="study-check" title={`The answer leads with headline measures (at most ${LIMITS.headlines})`}>
                <input
                  type="checkbox"
                  checked={m.headline}
                  disabled={!m.headline && headlines >= LIMITS.headlines}
                  onChange={(e) => update(i, { ...m, headline: e.currentTarget.checked })}
                />
                Headline
              </label>
              <span className="study-cond-actions">
                <button type="button" className="icon-button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button type="button" className="icon-button" aria-label="Move down" title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={13} />
                </button>
                <button type="button" className="icon-button" aria-label="Remove measure" title="Remove" onClick={() => onChange(items.filter((_, k) => k !== i))}>
                  <X size={13} />
                </button>
              </span>
            </div>
            <label className="study-field">
              <span>Measure</span>
              <select className="python-input" value={m.stat} onChange={(e) => update(i, withStat(m, e.currentTarget.value as MeasureStat))}>
                {GROUPS.map(([group, stats]) => (
                  <optgroup key={group} label={group}>
                    {stats.map((s) => (
                      <option key={s} value={s}>
                        {STAT_LABEL[s]}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {kind === 'condition' && (
              <div className="study-field">
                <span>Days on which all of these held</span>
                <ConditionList<Condition>
                  items={m.conditions}
                  onChange={(conditions) => update(i, { ...m, conditions })}
                  make={() => ({ left: 'dist_ema_21', op: '<=', right: 0.03 })}
                  addLabel="Add a condition (AND)"
                />
              </div>
            )}
            {kind === 'feature' && (
              <label className="study-field">
                <span>Feature</span>
                <input
                  className="python-input study-cond-feature"
                  list={listId}
                  spellCheck={false}
                  value={m.feature ?? ''}
                  onChange={(e) => update(i, { ...m, feature: e.currentTarget.value.trim() })}
                />
              </label>
            )}
            <WindowPicker value={m.window} onChange={(window) => update(i, { ...m, window })} />
          </div>
        );
      })}
      <button type="button" className="btn btn-tiny" disabled={items.length >= LIMITS.measures} onClick={() => onChange([...items, fresh(items.length === 0)])}>
        <Plus size={13} />
        Add a measure
      </button>
    </div>
  );
}
