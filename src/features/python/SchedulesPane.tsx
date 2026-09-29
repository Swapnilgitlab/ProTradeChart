import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { CalendarClock, ChevronDown, ChevronRight, CirclePlay, Pencil, Plus, Square, Trash2 } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { confirmDelete } from '../../lib/dialogs';
import {
  deleteSchedule,
  errorMessage,
  listScheduleRuns,
  listSchedules,
  runScheduleNow,
  saveSchedule,
  stopScheduleRun,
  type Schedule,
  type ScheduleRule,
  type ScheduleRun,
} from '../../lib/ipc';
import {
  DAY_NAMES,
  defaultRule,
  describeRule,
  EVERY_DAY,
  minutesToText,
  ruleProblem,
  STATUS_LABEL,
  textToMinutes,
  WEEKDAYS,
  whenText,
} from '../../python/schedules';

interface Props {
  /** The scripts that can be scheduled. */
  scripts: readonly string[];
  /** The script open in the editor: what a new schedule starts on. */
  currentScript: string | null;
  /** Bumped by the toolbar's Schedule button to open a new schedule for the current script. */
  newRequest: number;
}

interface Draft {
  id: string;
  script: string;
  rule: ScheduleRule;
  enabled: boolean;
  isNew: boolean;
}

/** Scripts the user scheduled to run by themselves, with what happened each time. A schedule is
 *  made only here; it runs only while the app is open, and a run that came due while it wasn't is
 *  recorded as missed, never made up. */
export function SchedulesPane({ scripts, currentScript, newRequest }: Props) {
  const toast = useToast();
  const say = useCallback((level: 'info' | 'error', text: string) => toast(text, level), [toast]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<ScheduleRun[]>([]);
  const [shownOutput, setShownOutput] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      setSchedules(await listSchedules());
      if (open) setHistory(await listScheduleRuns(open));
    } catch (err) {
      say('error', errorMessage(err));
    }
  }, [open, say]);

  useEffect(() => {
    void reload();
    let cancelled = false;
    let off: (() => void) | null = null;
    void listen('schedules-changed', () => void reload()).then((stop) => {
      if (cancelled) stop();
      else off = stop;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const startNew = useCallback(() => {
    const script = currentScript ?? scripts[0];
    if (!script) {
      say('info', 'Make a script first; then it can be scheduled.');
      return;
    }
    setDraft({ id: crypto.randomUUID(), script, rule: defaultRule(), enabled: true, isNew: true });
  }, [currentScript, scripts, say]);

  useEffect(() => {
    if (newRequest > 0) startNew();
    // Only a new press opens the form, not a change of script.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newRequest]);

  const save = async (d: Draft) => {
    try {
      await saveSchedule(d.id, d.script, d.rule, d.enabled);
      setDraft(null);
      await reload();
    } catch (err) {
      say('error', errorMessage(err));
    }
  };

  const act = async (what: () => Promise<void>) => {
    try {
      await what();
      await reload();
    } catch (err) {
      say('error', errorMessage(err));
    }
  };

  const toggleHistory = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    setShownOutput(null);
    try {
      setHistory(await listScheduleRuns(id));
    } catch (err) {
      say('error', errorMessage(err));
    }
  };

  const remove = async (s: Schedule) => {
    if (!(await confirmDelete(`Delete the schedule for ${s.script} (${describeRule(s.rule)}) and its history?`))) return;
    await act(() => deleteSchedule(s.id));
  };

  return (
    <div className="schedules">
      <div className="schedules-head">
        <span className="muted small">
          Scheduled scripts run by themselves, as if you had pressed Run, while the app is open. Times are IST. A run that comes due while the app is
          closed or the computer is asleep is recorded as missed, not made up.
        </span>
        <button type="button" className="btn btn-tiny" onClick={startNew} disabled={draft !== null}>
          <Plus size={13} />
          New schedule
        </button>
      </div>

      {draft && <ScheduleForm draft={draft} scripts={scripts} onChange={setDraft} onSave={(d) => void save(d)} onCancel={() => setDraft(null)} />}

      {schedules.length === 0 && !draft && (
        <p className="muted small schedules-empty">
          No schedules. A script that calls <code>pt.set_watchlist(name, symbols)</code> can keep a watchlist up to date: schedule it for after the close.
        </p>
      )}

      <ul className="schedules-list">
        {schedules.map((s) => {
          const running = s.lastRun?.status === 'running';
          const last = s.lastRun;
          return (
            <li key={s.id} className={`schedule${s.enabled ? '' : ' off'}`}>
              <div className="schedule-row">
                <button type="button" className="icon-button" aria-label={open === s.id ? 'Hide history' : 'Show history'} onClick={() => void toggleHistory(s.id)}>
                  {open === s.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <label className="schedule-toggle" title={s.enabled ? 'Switch off' : 'Switch on'}>
                  <input type="checkbox" checked={s.enabled} onChange={(e) => void act(() => saveSchedule(s.id, s.script, s.rule, e.currentTarget.checked))} />
                </label>
                <span className="schedule-script">{s.script}</span>
                <span className="schedule-rule muted small">{describeRule(s.rule)}</span>
                <span className="schedule-next small">
                  {running ? 'Running now' : s.enabled && s.nextRunAt !== null ? `Next ${whenText(s.nextRunAt, now)}` : 'Off'}
                </span>
                {last && !running && (
                  <span className={`schedule-last small ${last.status === 'ok' ? 'study-profit' : last.status === 'failed' ? 'study-loss' : 'muted'}`} title={last.message || undefined}>
                    {STATUS_LABEL[last.status]} {whenText(last.startedAt ?? last.dueAt, now)}
                  </span>
                )}
                <div className="pine-toolbar-spacer" />
                {running ? (
                  <button type="button" className="btn btn-tiny python-stop" onClick={() => void act(() => stopScheduleRun(s.id))}>
                    <Square size={12} />
                    Stop
                  </button>
                ) : (
                  <button type="button" className="btn btn-tiny" onClick={() => void act(() => runScheduleNow(s.id))} title="Run it now, and record it with the schedule">
                    <CirclePlay size={13} />
                    Run now
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Edit"
                  title="Edit"
                  disabled={draft !== null}
                  onClick={() => setDraft({ id: s.id, script: s.script, rule: structuredClone(s.rule), enabled: s.enabled, isNew: false })}
                >
                  <Pencil size={13} />
                </button>
                <button type="button" className="icon-button" aria-label="Delete" title="Delete" onClick={() => void remove(s)}>
                  <Trash2 size={13} />
                </button>
              </div>
              {open === s.id && (
                <div className="schedule-history">
                  {history.length === 0 && <p className="muted small">It hasn’t come due yet.</p>}
                  {history.map((r) => (
                    <div key={r.id} className="schedule-run">
                      <button
                        type="button"
                        className="schedule-run-line small"
                        onClick={() => setShownOutput((v) => (v === r.id ? null : r.id))}
                        disabled={!r.output}
                        title={r.output ? 'Show what it printed' : undefined}
                      >
                        <span className={r.status === 'ok' ? 'study-profit' : r.status === 'failed' ? 'study-loss' : r.status === 'running' ? '' : 'muted'}>
                          {STATUS_LABEL[r.status]}
                        </span>
                        <span className="muted">
                          {r.status === 'missed' || r.status === 'skipped' ? `due ${whenText(r.dueAt, now)}` : whenText(r.startedAt ?? r.dueAt, now)}
                          {r.startedAt !== null && r.finishedAt !== null && ` · ${Math.max(1, Math.round((r.finishedAt - r.startedAt) / 1000))} s`}
                        </span>
                        {r.message && <span className="schedule-run-message">{r.message}</span>}
                      </button>
                      {shownOutput === r.id && <pre className="study-log schedule-output">{r.output}</pre>}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScheduleForm({ draft, scripts, onChange, onSave, onCancel }: {
  draft: Draft;
  scripts: readonly string[];
  onChange: (d: Draft) => void;
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const rule = draft.rule;
  const setRule = (next: ScheduleRule) => onChange({ ...draft, rule: next });
  const problem = ruleProblem(rule);
  const timeField = (label: string, value: number, set: (m: number) => void) => (
    <input
      className="python-input"
      type="time"
      aria-label={label}
      value={minutesToText(value)}
      onChange={(e) => {
        const m = textToMinutes(e.currentTarget.value);
        if (m !== null) set(m);
      }}
    />
  );

  return (
    <div className="schedule-form" role="group" aria-label={draft.isNew ? 'New schedule' : 'Edit schedule'}>
      <div className="study-row">
        <label className="study-field">
          <span>Script</span>
          <select className="python-input" value={draft.script} onChange={(e) => onChange({ ...draft, script: e.currentTarget.value })}>
            {!scripts.includes(draft.script) && <option value={draft.script}>{draft.script} (missing)</option>}
            {scripts.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="study-field study-checks">
          <legend>Days</legend>
          {DAY_NAMES.map((d, i) => (
            <label key={d}>
              <input type="checkbox" checked={rule.days[i]} onChange={(e) => setRule({ ...rule, days: rule.days.map((v, k) => (k === i ? e.currentTarget.checked : v)) })} />
              {d}
            </label>
          ))}
          <button type="button" className="btn btn-tiny" onClick={() => setRule({ ...rule, days: [...WEEKDAYS] })}>
            Weekdays
          </button>
          <button type="button" className="btn btn-tiny" onClick={() => setRule({ ...rule, days: [...EVERY_DAY] })}>
            Every day
          </button>
        </fieldset>
      </div>
      <div className="study-row">
        <label className="study-check">
          <input type="radio" name="schedule-kind" checked={rule.kind === 'daily'} onChange={() => setRule({ days: rule.days, kind: 'daily', at: 16 * 60 })} />
          Once, at
        </label>
        {rule.kind === 'daily' && timeField('Time', rule.at, (at) => setRule({ ...rule, at }))}
        <label className="study-check">
          <input
            type="radio"
            name="schedule-kind"
            checked={rule.kind === 'every'}
            onChange={() => setRule({ days: rule.days, kind: 'every', minutes: 15, from: 9 * 60 + 15, until: 15 * 60 + 30 })}
          />
          Repeatedly
        </label>
        {rule.kind === 'every' && (
          <span className="schedule-every">
            every
            <input
              className="python-input"
              type="number"
              min={5}
              max={720}
              aria-label="Minutes between runs"
              value={rule.minutes}
              onChange={(e) => setRule({ ...rule, minutes: e.currentTarget.valueAsNumber })}
            />
            min, from {timeField('First run', rule.from, (from) => setRule({ ...rule, from }))}
            to {timeField('Last run', rule.until, (until) => setRule({ ...rule, until }))}
          </span>
        )}
        <span className="muted small">IST</span>
      </div>
      <p className={`small ${problem ? 'study-problem' : 'muted'}`}>
        {problem ?? `${draft.script} will run on its own (${describeRule(rule)}), with your permissions, as if you had pressed Run.`}
      </p>
      <div className="study-row">
        <label className="study-check">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ ...draft, enabled: e.currentTarget.checked })} />
          Switched on
        </label>
        <div className="pine-toolbar-spacer" />
        <button type="button" className="btn btn-tiny" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary btn-tiny" onClick={() => onSave(draft)} disabled={problem !== null}>
          <CalendarClock size={13} />
          {draft.isNew ? 'Create schedule' : 'Save schedule'}
        </button>
      </div>
    </div>
  );
}
