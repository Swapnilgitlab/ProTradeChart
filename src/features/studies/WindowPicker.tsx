import { useId, useState } from 'react';
import { featureLabel } from '../../studies/metrics';
import { presetOf, windowPhrase, WINDOW_PRESETS } from '../../studies/measures';
import type { AnchorPoint, Condition, Endpoint, Measure } from '../../studies/spec';
import { ConditionList, FEATURE_CHOICES } from './ConditionList';

interface Props {
  value: Measure['window'];
  onChange: (next: Measure['window']) => void;
}

type PointKind = 'offset' | AnchorPoint['find'];

const KIND_LABEL: Record<PointKind, string> = {
  offset: 'A fixed number of days from the event',
  lowest: 'The day of its lowest…',
  highest: 'The day of its highest…',
  first: 'The first day these held…',
  last: 'The last day these held…',
};

const isAnchor = (e: Endpoint): e is AnchorPoint => 'find' in e;

function convert(e: Endpoint, kind: PointKind, role: 'start' | 'end'): Endpoint {
  if (kind === 'offset') return { offset: role === 'start' ? -252 : 0 };
  const base: AnchorPoint = isAnchor(e)
    ? { ...e, find: kind }
    : { find: kind, feature: null, conditions: [], direction: role === 'start' ? 'before' : 'after', within: 252, if_not_found: 'cap' };
  if (kind === 'lowest' || kind === 'highest') return { ...base, feature: base.feature ?? 'close' };
  return { ...base, conditions: base.conditions.length ? base.conditions : [{ left: 'close', op: '<', right: 'sma_50' }] };
}

/** One end of a window: a fixed offset, or a day found near the event. */
function PointEditor({ label, value, role, onChange }: { label: string; value: Endpoint; role: 'start' | 'end'; onChange: (e: Endpoint) => void }) {
  const listId = useId();
  const kind: PointKind = isAnchor(value) ? value.find : 'offset';
  return (
    <fieldset className="study-point">
      <legend>{label}</legend>
      <select className="python-input" aria-label={`${label}: kind`} value={kind} onChange={(e) => onChange(convert(value, e.currentTarget.value as PointKind, role))}>
        {(Object.keys(KIND_LABEL) as PointKind[]).map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      {!isAnchor(value) ? (
        <label className="study-inline">
          <input
            className="python-input study-narrow"
            type="number"
            step={1}
            min={-1000}
            max={1000}
            aria-label={`${label}: days from the event`}
            value={Number.isFinite(value.offset) ? value.offset : ''}
            onChange={(e) => onChange({ offset: e.currentTarget.valueAsNumber })}
          />
          <span className="muted small">days from the event (negative: before; 0: the event day)</span>
        </label>
      ) : (
        <>
          {(value.find === 'lowest' || value.find === 'highest') && (
            <>
              <datalist id={listId}>
                {FEATURE_CHOICES.map((f) => (
                  <option key={f} value={f}>
                    {featureLabel(f)}
                  </option>
                ))}
              </datalist>
              <input
                className="python-input study-cond-feature"
                list={listId}
                spellCheck={false}
                aria-label={`${label}: feature`}
                value={value.feature ?? ''}
                onChange={(e) => onChange({ ...value, feature: e.currentTarget.value.trim() })}
              />
            </>
          )}
          {(value.find === 'first' || value.find === 'last') && (
            <ConditionList<Condition>
              items={value.conditions}
              onChange={(conditions) => onChange({ ...value, conditions })}
              make={() => ({ left: 'close', op: '<', right: 'sma_50' })}
              addLabel="Add a condition (AND)"
            />
          )}
          <div className="study-row">
            <label className="study-inline">
              <span className="muted small">searching</span>
              <select className="python-input" aria-label={`${label}: direction`} value={value.direction} onChange={(e) => onChange({ ...value, direction: e.currentTarget.value as 'before' | 'after' })}>
                <option value="before">before the event (up to it)</option>
                <option value="after">after the event</option>
              </select>
            </label>
            <label className="study-inline">
              <span className="muted small">within</span>
              <input
                className="python-input study-narrow"
                type="number"
                min={1}
                max={1000}
                aria-label={`${label}: days searched`}
                value={Number.isFinite(value.within) ? value.within : ''}
                onChange={(e) => onChange({ ...value, within: e.currentTarget.valueAsNumber })}
              />
              <span className="muted small">days</span>
            </label>
            {(value.find === 'first' || value.find === 'last') && (
              <label className="study-inline">
                <span className="muted small">if it never happened</span>
                <select className="python-input" aria-label={`${label}: if not found`} value={value.if_not_found} onChange={(e) => onChange({ ...value, if_not_found: e.currentTarget.value as 'cap' | 'skip' })}>
                  <option value="cap">use the end of the search (a lower bound)</option>
                  <option value="skip">leave the event out</option>
                </select>
              </label>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}

/** Which stretch of days a measure reads: a named window, or a custom one from a start to an end. */
export function WindowPicker({ value, onChange }: Props) {
  // "Custom…" opens the editors on the current window, even when that window is still a preset.
  const [customChosen, setCustomChosen] = useState(false);
  const preset = customChosen ? 'custom' : presetOf(value);
  let phrase: string | null = null;
  try {
    phrase = windowPhrase(value);
  } catch {
    phrase = null;
  }
  return (
    <div className="study-window">
      <label className="study-field">
        <span>Over</span>
        <select
          className="python-input"
          value={preset}
          onChange={(e) => {
            const chosen = WINDOW_PRESETS.find((p) => p.id === e.currentTarget.value);
            setCustomChosen(!chosen);
            if (chosen) onChange(structuredClone(chosen.window));
          }}
        >
          {WINDOW_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
      </label>
      {preset === 'custom' && (
        <div className="study-window-custom">
          <PointEditor label="From" role="start" value={value.start} onChange={(start) => onChange({ ...value, start })} />
          <PointEditor label="To" role="end" value={value.end} onChange={(end) => onChange({ ...value, end })} />
        </div>
      )}
      {phrase && <p className="muted small study-hint">Reads the days {phrase}.</p>}
    </div>
  );
}
