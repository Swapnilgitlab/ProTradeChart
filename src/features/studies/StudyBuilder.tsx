import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleSlash, Info, Plus, X } from 'lucide-react';
import { canonicalFeature, featureLabel, SUGGESTED_METRICS, windowLabel } from '../../studies/metrics';
import type { Readiness, ReadinessFix } from '../../studies/readiness';
import { interpret, normalizeSpec, type Condition, type PreEventFilter, type Series, type StudySpec } from '../../studies/spec';
import { ConditionList } from './ConditionList';
import { MeasureList } from './MeasureList';

interface Props {
  draft: StudySpec;
  onChange: (next: StudySpec) => void;
  /** What stops the draft being a valid spec, if anything. */
  problem: string | null;
  readiness: Readiness | null;
  onApplyFix: (fix: ReadinessFix) => void;
  watchlists: readonly string[];
}

const CRORE = 1e7;

const SERIES_CHOICES: [Series, string][] = [
  ['EQ', 'Ordinary shares'],
  ['BE', 'Trade-for-trade (BE)'],
  ['SME', 'SME'],
];

/** A number field that keeps what is being typed and reports a number, or null when empty. */
function NumberField({ value, onChange, scale = 1, label, min, placeholder }: {
  value: number | null;
  onChange: (v: number | null) => void;
  scale?: number;
  label: string;
  min?: number;
  placeholder?: string;
}) {
  return (
    <input
      className="python-input"
      type="number"
      step="any"
      min={min}
      aria-label={label}
      placeholder={placeholder}
      value={value === null || !Number.isFinite(value) ? '' : Number((value / scale).toPrecision(10))}
      onChange={(e) => {
        const v = e.currentTarget.valueAsNumber;
        onChange(e.currentTarget.value === '' ? null : Number.isFinite(v) ? v * scale : Number.NaN);
      }}
    />
  );
}

/** Windows in bars, typed as a list: "252, 126, 63, 21". Applied when the field is left. */
function WindowsField({ value, onChange, label }: { value: number[]; onChange: (v: number[]) => void; label: string }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText([...value].sort((a, b) => b - a).join(', ')), [value]);
  return (
    <span className="study-windows">
      <input
        className="python-input"
        value={text}
        aria-label={label}
        spellCheck={false}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={() => onChange(text.split(/[\s,]+/).filter(Boolean).map(Number))}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      <span className="muted small">{value.filter(Number.isFinite).map(windowLabel).join(' · ')}</span>
    </span>
  );
}

function Section({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="study-section">
      <h3>{title}</h3>
      {hint && <p className="muted small study-hint">{hint}</p>}
      {children}
    </section>
  );
}

/** The Study Builder: every part of the specification as a form, the plain-language reading of it,
 *  and the data readiness check. Editing never runs anything. */
export function StudyBuilder({ draft, onChange, problem, readiness, onApplyFix, watchlists }: Props) {
  const metricListId = useId();
  const [newMetric, setNewMetric] = useState('');
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  // The snapshot sections start open only for a Study that measures nothing over time.
  const [snapshotOpen, setSnapshotOpen] = useState(() => draft.measures.length === 0);
  const set = (patch: Partial<StudySpec>) => onChange({ ...draft, ...patch });
  const u = draft.universe;
  const setUniverse = (patch: Partial<StudySpec['universe']>) => set({ universe: { ...u, ...patch } });
  let interpretation: ReturnType<typeof interpret> | null = null;
  try {
    interpretation = problem ? null : interpret(normalizeSpec(draft));
  } catch {
    interpretation = null;
  }

  const addMetric = () => {
    const key = canonicalFeature(newMetric);
    if (key && !draft.metrics.includes(key)) set({ metrics: [...draft.metrics, key] });
    setNewMetric('');
  };

  return (
    <div className="study-builder">
      <div className="study-form">
        <Section title="Study">
          <label className="study-field">
            <span>Name</span>
            <input className="python-input" value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} />
          </label>
          <label className="study-field">
            <span>Question</span>
            <textarea
              className="python-input study-textarea"
              rows={2}
              maxLength={500}
              placeholder="What do you want to know? It is shown above the answer."
              value={draft.question}
              onChange={(e) => set({ question: e.currentTarget.value })}
            />
          </label>
          <label className="study-field">
            <span>Description</span>
            <textarea className="python-input study-textarea" rows={2} value={draft.description} onChange={(e) => set({ description: e.currentTarget.value })} />
          </label>
        </Section>

        <Section title="Universe" hint="Which stocks are studied. Size filters are judged at each event, never with later data.">
          <div className="study-row">
            <label className="study-field">
              <span>From</span>
              <select className="python-input" value={u.source} onChange={(e) => setUniverse({ source: e.currentTarget.value as StudySpec['universe']['source'] })}>
                <option value="instruments">Broker instrument list</option>
                <option value="watchlist">A watchlist</option>
                <option value="symbols">Symbols I list</option>
              </select>
            </label>
            {u.source === 'instruments' && (
              <>
                <label className="study-field">
                  <span>Broker</span>
                  <select className="python-input" value={u.provider} onChange={(e) => setUniverse({ provider: e.currentTarget.value as 'india' })}>
                    <option value="india">Indian markets</option>
                                      </select>
                </label>
                <fieldset className="study-field study-checks">
                  <legend>Exchanges</legend>
                  {(['NSE', 'BSE'] as const).map((ex) => (
                    <label key={ex}>
                      <input
                        type="checkbox"
                        checked={u.exchanges.includes(ex)}
                        onChange={(e) =>
                          setUniverse({ exchanges: e.currentTarget.checked ? [...u.exchanges, ex] : u.exchanges.filter((x) => x !== ex) })
                        }
                      />
                      {ex}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="study-field study-checks" title="Bonds, SGBs, G-secs, T-bills and funds are always left out">
                  <legend>Listings</legend>
                  {SERIES_CHOICES.map(([id, label]) => (
                    <label key={id}>
                      <input
                        type="checkbox"
                        checked={u.series.includes(id)}
                        onChange={(e) => setUniverse({ series: e.currentTarget.checked ? [...u.series, id] : u.series.filter((x) => x !== id) })}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {u.source === 'watchlist' && (
              <label className="study-field">
                <span>Watchlist</span>
                <select className="python-input" value={u.watchlist ?? ''} onChange={(e) => setUniverse({ watchlist: e.currentTarget.value || null })}>
                  <option value="">Choose…</option>
                  {watchlists.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {u.source === 'symbols' && (
            <label className="study-field">
              <span>Symbols, one per line (india:NSE:RELIANCE)</span>
              <textarea
                className="python-input study-textarea"
                rows={4}
                spellCheck={false}
                value={u.symbols.join('\n')}
                onChange={(e) => setUniverse({ symbols: e.currentTarget.value.split(/\s+/).filter(Boolean) })}
              />
            </label>
          )}
          <div className="study-row">
            <label className="study-field">
              <span>Market cap above (₹ Cr)</span>
              <NumberField value={u.market_cap_min} scale={CRORE} min={0} label="Minimum market cap in crore" placeholder="Unavailable" onChange={(v) => setUniverse({ market_cap_min: v })} />
            </label>
            <label className="study-field">
              <span>Avg traded value above (₹ Cr/day)</span>
              <NumberField value={u.min_avg_traded_value} scale={CRORE} min={0} label="Minimum average traded value in crore a day" onChange={(v) => setUniverse({ min_avg_traded_value: v })} />
            </label>
            <label className="study-field">
              <span>Price above (₹)</span>
              <NumberField value={u.min_price} min={0} label="Minimum price" onChange={(v) => setUniverse({ min_price: v })} />
            </label>
            <label className="study-field">
              <span>Only the first N symbols</span>
              <NumberField value={u.max_symbols} min={1} label="Symbol limit" placeholder="All" onChange={(v) => setUniverse({ max_symbols: v })} />
            </label>
          </div>
        </Section>

        <Section title="Study period" hint="Events are looked for between these dates. History before the start is loaded for the look-back.">
          <div className="study-row">
            <label className="study-field">
              <span>From</span>
              <input className="python-input" type="date" value={draft.period.start} onChange={(e) => set({ period: { ...draft.period, start: e.currentTarget.value } })} />
            </label>
            <label className="study-field">
              <span>To (blank: latest)</span>
              <input className="python-input" type="date" value={draft.period.end ?? ''} onChange={(e) => set({ period: { ...draft.period, end: e.currentTarget.value || null } })} />
            </label>
          </div>
        </Section>

        <Section title="Event" hint="The event is the first day all of these hold together. Find every such day in history, not just today.">
          <label className="study-field">
            <span>Label</span>
            <input className="python-input" value={draft.event.label} onChange={(e) => set({ event: { ...draft.event, label: e.currentTarget.value } })} />
          </label>
          <ConditionList<Condition>
            items={draft.event.conditions}
            onChange={(conditions) => set({ event: { ...draft.event, conditions } })}
            make={() => ({ left: 'return_252', op: 'crosses_above', right: 1 })}
            addLabel="Add a condition (AND)"
          />
          <label className="study-field study-inline">
            <span>After an event, ignore the same stock for</span>
            <NumberField value={draft.event.cooldown_days} min={1} label="Cooldown in bars" onChange={(v) => set({ event: { ...draft.event, cooldown_days: v ?? Number.NaN } })} />
            <span className="muted">bars</span>
          </label>
        </Section>

        <Section title="Pre-event conditions" hint="Only keep events where these held a number of bars before (0 = on the event day).">
          <ConditionList<PreEventFilter>
            items={draft.pre_event_filters}
            onChange={(pre_event_filters) => set({ pre_event_filters })}
            make={() => ({ left: 'close', op: '>', right: 'ema_200', at: 63 })}
            withAt
            addLabel="Add a pre-event condition"
          />
        </Section>

        <Section
          title="What to measure"
          hint="One number per event over a stretch of days: the journey to the event, what came after, or an episode such as the run from its 12-month low. The answer leads with the headline measures."
        >
          <MeasureList items={draft.measures} onChange={(measures) => set({ measures })} />
        </Section>

        <details className="study-snapshot" open={snapshotOpen} onToggle={(e) => setSnapshotOpen(e.currentTarget.open)}>
          <summary>
            Event-day snapshot <span className="muted small">— what each stock looked like on single days around the event</span>
          </summary>

        <Section title="Observation and forward windows" hint="In trading days: 21 ≈ 1 month, 63 ≈ 3, 126 ≈ 6, 252 ≈ 12.">
          <label className="study-field">
            <span>Observe before the event at</span>
            <WindowsField value={draft.lookback_windows} label="Look-back windows" onChange={(lookback_windows) => set({ lookback_windows })} />
          </label>
          <label className="study-field">
            <span>Measure what happened after</span>
            <WindowsField value={draft.forward_windows} label="Forward windows" onChange={(forward_windows) => set({ forward_windows })} />
          </label>
        </Section>

        <Section title="Metrics" hint="Measured at every observation point. Any feature name works: return_63, ema_200, rsi_14, dist_high_252, rvol_20…">
          <div className="study-chips">
            {draft.metrics.map((m) => (
              <span key={m} className={`study-chip${canonicalFeature(m) ? '' : ' invalid'}`} title={m}>
                {featureLabel(m)}
                <button type="button" aria-label={`Remove ${m}`} onClick={() => set({ metrics: draft.metrics.filter((x) => x !== m) })}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
          <div className="study-row">
            <datalist id={metricListId}>
              {SUGGESTED_METRICS.filter((m) => !draft.metrics.includes(m)).map((m) => (
                <option key={m} value={m}>
                  {featureLabel(m)}
                </option>
              ))}
            </datalist>
            <input
              className="python-input"
              list={metricListId}
              value={newMetric}
              placeholder="Add a metric…"
              spellCheck={false}
              aria-label="Add a metric"
              onChange={(e) => setNewMetric(e.currentTarget.value)}
              onKeyDown={(e) => e.key === 'Enter' && addMetric()}
            />
            <button type="button" className="btn btn-tiny" onClick={addMetric} disabled={!canonicalFeature(newMetric)}>
              <Plus size={13} />
              Add
            </button>
          </div>
        </Section>

        <Section title="Characteristics" hint="Yes/no traits counted at every observation point, e.g. Above 200 EMA.">
          <ConditionList<Condition>
            items={draft.characteristics}
            onChange={(characteristics) => set({ characteristics })}
            make={() => ({ label: 'Above 50 EMA', left: 'close', op: '>', right: 'ema_50' })}
            withLabel
            addLabel="Add a characteristic"
          />
        </Section>
        </details>

        <Section title="Comparison">
          <label className="study-field">
            <span>Benchmark index for relative strength</span>
            <input
              className="python-input"
              value={draft.benchmark ?? ''}
              placeholder="india:NSE:NIFTY_500"
              spellCheck={false}
              onChange={(e) => set({ benchmark: e.currentTarget.value.trim() || null })}
            />
          </label>
          <label className="study-check">
            <input
              type="checkbox"
              checked={draft.outcome !== null}
              onChange={(e) => set({ outcome: e.currentTarget.checked ? { window: 126, min_return: 0.3 } : null })}
            />
            Compare events that went on to a gain with those that didn’t
          </label>
          {draft.outcome ? (
            <div className="study-row">
              <label className="study-field">
                <span>Gain of at least (%)</span>
                <NumberField value={draft.outcome.min_return} scale={0.01} label="Outcome gain in percent" onChange={(v) => set({ outcome: { ...draft.outcome!, min_return: v ?? Number.NaN } })} />
              </label>
              <label className="study-field">
                <span>Within (bars)</span>
                <NumberField value={draft.outcome.window} min={1} label="Outcome window in bars" onChange={(v) => set({ outcome: { ...draft.outcome!, window: v ?? Number.NaN } })} />
              </label>
            </div>
          ) : (
            <>
              <label className="study-check">
                <input
                  type="checkbox"
                  checked={draft.control_group.enabled}
                  onChange={(e) => set({ control_group: { ...draft.control_group, enabled: e.currentTarget.checked } })}
                />
                Control group of random non-event dates from the same universe
              </label>
              {draft.control_group.enabled && (
                <div className="study-row">
                  <label className="study-field">
                    <span>Dates per event</span>
                    <NumberField value={draft.control_group.samples_per_event} min={1} label="Control dates per event" onChange={(v) => set({ control_group: { ...draft.control_group, samples_per_event: v ?? Number.NaN } })} />
                  </label>
                  <label className="study-field">
                    <span>Random seed</span>
                    <NumberField value={draft.control_group.seed} min={0} label="Random seed" onChange={(v) => set({ control_group: { ...draft.control_group, seed: v ?? Number.NaN } })} />
                  </label>
                </div>
              )}
            </>
          )}
          <label className="study-field">
            <span>Events kept in the table (statistics use all)</span>
            <NumberField value={draft.output.max_events} min={1} label="Events in the table" onChange={(v) => set({ output: { max_events: v ?? Number.NaN } })} />
          </label>
        </Section>

        <Section title="Specification (JSON)" hint="The Study Specification is what is saved and run. Advanced: edit it directly.">
          {jsonOpen ? (
            <>
              <textarea className="python-input study-textarea study-json" rows={16} spellCheck={false} value={jsonText} onChange={(e) => setJsonText(e.currentTarget.value)} />
              {jsonError && <p className="study-problem small">{jsonError}</p>}
              <div className="study-row">
                <button
                  type="button"
                  className="btn btn-tiny btn-primary"
                  onClick={() => {
                    try {
                      onChange(normalizeSpec(JSON.parse(jsonText)));
                      setJsonOpen(false);
                      setJsonError(null);
                    } catch (err) {
                      setJsonError(err instanceof Error ? err.message : String(err));
                    }
                  }}
                >
                  Apply
                </button>
                <button type="button" className="btn btn-tiny" onClick={() => setJsonOpen(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-tiny"
              onClick={() => {
                setJsonText(JSON.stringify(draft, null, 2));
                setJsonError(null);
                setJsonOpen(true);
              }}
            >
              Edit JSON
            </button>
          )}
        </Section>
      </div>

      <aside className="study-aside">
        {readiness && (
          <div className="study-card">
            <h3>
              Data readiness <span className={`study-score${readiness.ready ? '' : ' blocked'}`}>{readiness.score}%</span>
            </h3>
            <table className="study-readiness">
              <tbody>
                {readiness.items.map((item) => (
                  <tr key={item.field} className={item.blocking ? 'blocking' : undefined}>
                    <td className="study-readiness-icon">
                      {item.status === 'available' ? (
                        <CheckCircle2 size={14} className="study-profit" />
                      ) : item.status === 'unavailable' ? (
                        item.blocking ? <CircleSlash size={14} className="study-loss" /> : <CircleSlash size={14} className="muted" />
                      ) : item.status === 'warning' ? (
                        <AlertTriangle size={14} className="study-warn" />
                      ) : (
                        <Info size={14} className="muted" />
                      )}
                    </td>
                    <td className="study-readiness-field">{item.field}</td>
                    <td>
                      <div>{item.status === 'available' ? 'Available' : item.status === 'unavailable' ? 'Unavailable' : item.status === 'warning' ? 'Caution' : 'Not used'}</div>
                      <div className="muted small">{item.detail}</div>
                      {item.fix && (
                        <button type="button" className="btn btn-tiny study-fix" onClick={() => onApplyFix(item.fix!.id)}>
                          {item.fix.label}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {readiness.notes.map((note, i) => (
              <p key={i} className="muted small">
                {note}
              </p>
            ))}
          </div>
        )}
        <div className="study-card">
          <h3>Study interpretation</h3>
          {problem ? (
            <p className="study-problem">{problem}</p>
          ) : (
            interpretation?.map((part) => (
              <div key={part.heading} className="study-interp">
                <div className="study-interp-heading">{part.heading}</div>
                {part.lines.map((line, i) => (
                  <div key={i} className="study-interp-line">
                    {line}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
}
