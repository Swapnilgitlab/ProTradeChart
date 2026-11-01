import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { ArrowDown, ArrowUp, CalendarClock, ChevronDown, ChevronRight, CirclePlay, Mail, Pencil, Plus, Square, Trash2, X } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { confirmDelete } from '../../lib/dialogs';
import {
  deleteSchedule,
  emailStatus,
  errorMessage,
  listPythonScripts,
  listScheduleRuns,
  listSchedules,
  runScheduleNow,
  saveSchedule,
  stopScheduleRun,
  type Schedule,
  type ScheduleRule,
  type ScheduleRun,
  type ScheduleRunStatus,
} from '../../lib/ipc';
import {
  DAY_NAMES,
  defaultRule,
  describeRule,
  EVERY_DAY,
  MAX_SCRIPTS,
  minutesToText,
  moveScript,
  removeScript,
  scheduleProblem,
  STATUS_LABEL,
  textToMinutes,
  WEEKDAYS,
  whenText,
} from '../../python/schedules';
import { EmailSettingsDialog } from './EmailSettingsDialog';

interface Props {
  /** Shown now: the scripts are listed again, in case the Python tab made one. */
  visible: boolean;
  /** Bumped (with the script to start on) by "Schedule this script" in the Python tab. */
  request: { script: string | null; n: number };
  onOpenPython: () => void;
}

interface Draft {
  id: string;
  name: string;
  scripts: string[];
  rule: ScheduleRule;
  enabled: boolean;
  emailOnFailure: boolean;
  isNew: boolean;
}

const tone = (status: ScheduleRunStatus) =>
  status === 'ok' ? 'study-profit' : status === 'failed' ? 'study-loss' : status === 'running' ? '' : 'muted';

const seconds = (from: number | null, to: number | null) =>
  from !== null && to !== null ? ` · ${Math.max(1, Math.round((to - from) / 1000))} s` : '';

/** Schedules: sequences of Python scripts that run by themselves, one after another, while the app is
 *  open. A schedule is made only here, by the user. A script that fails stops the run, and the ones
 *  after it aren't run; a run that came due while the app was closed is recorded as missed, never
 *  made up. */
export function SchedulerPanel({ visible, request, onOpenPython }: Props) {
  const toast = useToast();
  const say = useCallback((level: 'info' | 'error', text: string) => toast(text, level), [toast]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [scripts, setScripts] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [history, setHistory] = useState<ScheduleRun[]>([]);
  const [shownOutput, setShownOutput] = useState<string | null>(null);
  const [emailReady, setEmailReady] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    try {
      setSchedules(await listSchedules());
      if (open) setHistory(await listScheduleRuns(open));
    } catch (err) {
      say('error', errorMessage(err));
    }
  }, [open, say]);

  const loadScripts = useCallback(async () => {
    try {
      setScripts((await listPythonScripts()).map((s) => s.name));
      const email = await emailStatus();
      setEmailReady(email.settings !== null && email.passwordSaved);
    } catch {
      // Python not set up yet: no scripts to offer, which the form says.
    }
  }, []);

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
    if (visible) void loadScripts();
  }, [visible, loadScripts]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const startNew = useCallback(
    (script: string | null) => {
      const first = script ?? scripts[0] ?? null;
      setDraft({
        id: crypto.randomUUID(),
        name: first ? first.replace(/\.py$/i, '') : 'New schedule',
        scripts: first ? [first] : [],
        rule: defaultRule(),
        enabled: true,
        emailOnFailure: false,
        isNew: true,
      });
    },
    [scripts],
  );

  useEffect(() => {
    if (request.n > 0) startNew(request.script);
    // Only a new press opens the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.n]);

  const save = async (d: Draft) => {
    try {
      await saveSchedule(d);
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
    if (!(await confirmDelete(`Delete the schedule "${s.name}" and its history? Its scripts stay.`))) return;
    await act(() => deleteSchedule(s.id));
  };

  return (
    <div className="scheduler-page">
      <div className="schedules">
        <div className="schedules-head">
          <span className="muted small">
            A schedule runs a sequence of your Python scripts by themselves, one after another, as if you had pressed Run, while the app is open. Times are
            IST. A script that fails stops the run. A run that comes due while the app is closed or the computer is asleep is recorded as missed, not made
            up.
          </span>
          <div className="scheduler-head-actions">
            <button type="button" className="btn btn-tiny" onClick={() => setEmailOpen(true)} title="The account scripts and failure notes email you from">
              <Mail size={13} />
              Email settings
            </button>
            <button type="button" className="btn btn-tiny btn-primary" onClick={() => startNew(null)} disabled={draft !== null}>
              <Plus size={13} />
              New schedule
            </button>
          </div>
        </div>

        {draft && (
          <ScheduleForm
            draft={draft}
            scripts={scripts}
            emailReady={emailReady}
            onChange={setDraft}
            onSave={(d) => void save(d)}
            onCancel={() => setDraft(null)}
            onOpenPython={onOpenPython}
            onOpenEmail={() => setEmailOpen(true)}
          />
        )}

        {schedules.length === 0 && !draft && (
          <p className="muted small schedules-empty">
            No schedules yet. Write the scripts in the Python tab — one to screen, one to update a watchlist with <code>pt.sql</code> or{' '}
            <code>pt.set_watchlist</code>, one to save charts with <code>pt.screenshot</code>, one to email you with <code>pt.send_email</code> — then put
            them in order here.
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
                    <input type="checkbox" checked={s.enabled} onChange={(e) => void act(() => saveSchedule({ ...s, enabled: e.currentTarget.checked }))} />
                  </label>
                  <span className="schedule-script">{s.name}</span>
                  <span className="schedule-sequence muted small" title={s.scripts.join(' → ')}>
                    {s.scripts.join(' → ')}
                  </span>
                  <span className="schedule-rule muted small">{describeRule(s.rule)}</span>
                  <span className="schedule-next small">
                    {running ? 'Running now' : s.enabled && s.nextRunAt !== null ? `Next ${whenText(s.nextRunAt, now)}` : 'Off'}
                  </span>
                  {last && !running && (
                    <span className={`schedule-last small ${tone(last.status)}`} title={last.message || undefined}>
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
                    <button type="button" className="btn btn-tiny" onClick={() => void act(() => runScheduleNow(s.id))} title="Run its scripts now, and record it with the schedule">
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
                    onClick={() =>
                      setDraft({
                        id: s.id,
                        name: s.name,
                        scripts: [...s.scripts],
                        rule: structuredClone(s.rule),
                        enabled: s.enabled,
                        emailOnFailure: s.emailOnFailure,
                        isNew: false,
                      })
                    }
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
                        <div className="schedule-run-line small">
                          <span className={tone(r.status)}>{STATUS_LABEL[r.status]}</span>
                          <span className="muted">
                            {r.status === 'missed' || r.status === 'skipped' ? `due ${whenText(r.dueAt, now)}` : whenText(r.startedAt ?? r.dueAt, now)}
                            {seconds(r.startedAt, r.finishedAt)}
                          </span>
                          {r.message && <span className="schedule-run-message">{r.message}</span>}
                        </div>
                        {r.steps.length > 0 ? (
                          <ol className="schedule-steps">
                            {r.steps.map((step) => {
                              const key = `${r.id}/${step.step}`;
                              return (
                                <li key={key}>
                                  <button
                                    type="button"
                                    className="schedule-run-line small"
                                    onClick={() => setShownOutput((v) => (v === key ? null : key))}
                                    disabled={!step.output}
                                    title={step.output ? 'Show what it printed' : undefined}
                                  >
                                    <span className="schedule-step-script">{step.script}</span>
                                    <span className={tone(step.status)}>{STATUS_LABEL[step.status]}</span>
                                    <span className="muted">{seconds(step.startedAt, step.finishedAt).replace(' · ', '')}</span>
                                    {step.message && <span className="schedule-run-message">{step.message}</span>}
                                  </button>
                                  {shownOutput === key && <pre className="study-log schedule-output">{step.output}</pre>}
                                </li>
                              );
                            })}
                          </ol>
                        ) : (
                          r.output && (
                            <>
                              <button type="button" className="btn btn-tiny" onClick={() => setShownOutput((v) => (v === `${r.id}` ? null : `${r.id}`))}>
                                {shownOutput === `${r.id}` ? 'Hide output' : 'Show output'}
                              </button>
                              {shownOutput === `${r.id}` && <pre className="study-log schedule-output">{r.output}</pre>}
                            </>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {emailOpen && (
        <EmailSettingsDialog
          onClose={() => {
            setEmailOpen(false);
            void loadScripts();
          }}
        />
      )}
    </div>
  );
}

function ScheduleForm({ draft, scripts, emailReady, onChange, onSave, onCancel, onOpenPython, onOpenEmail }: {
  draft: Draft;
  scripts: readonly string[];
  emailReady: boolean;
  onChange: (d: Draft) => void;
  onSave: (d: Draft) => void;
  onCancel: () => void;
  onOpenPython: () => void;
  onOpenEmail: () => void;
}) {
  const rule = draft.rule;
  const setRule = (next: ScheduleRule) => onChange({ ...draft, rule: next });
  const setScripts = (next: string[]) => onChange({ ...draft, scripts: next });
  const problem = scheduleProblem(draft.name, draft.scripts, scripts, rule);
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
        <label className="study-field scheduler-name">
          <span>Name</span>
          <input className="python-input" value={draft.name} maxLength={100} onChange={(e) => onChange({ ...draft, name: e.currentTarget.value })} />
        </label>
      </div>

      <div className="scheduler-sequence">
        <div className="scheduler-sequence-head small">
          <span>Scripts, in the order they run</span>
          <span className="muted">The next starts when the one before it ends well; a failure stops the run.</span>
        </div>
        {scripts.length === 0 && (
          <p className="small muted">
            There are no Python scripts yet.{' '}
            <button type="button" className="link-button" onClick={onOpenPython}>
              Open the Python tab
            </button>{' '}
            to write one.
          </p>
        )}
        <ol className="scheduler-steps">
          {draft.scripts.map((script, i) => (
            <li key={i} className="scheduler-step">
              <span className="scheduler-step-n">{i + 1}</span>
              <select
                className="python-input"
                aria-label={`Script ${i + 1}`}
                value={script}
                onChange={(e) => setScripts(draft.scripts.map((s, k) => (k === i ? e.currentTarget.value : s)))}
              >
                {!scripts.includes(script) && <option value={script}>{script} (missing)</option>}
                {scripts.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button type="button" className="icon-button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => setScripts(moveScript(draft.scripts, i, -1))}>
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-button"
                aria-label="Move down"
                title="Move down"
                disabled={i === draft.scripts.length - 1}
                onClick={() => setScripts(moveScript(draft.scripts, i, 1))}
              >
                <ArrowDown size={13} />
              </button>
              <button type="button" className="icon-button" aria-label="Remove from the sequence" title="Remove" onClick={() => setScripts(removeScript(draft.scripts, i))}>
                <X size={13} />
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="btn btn-tiny"
          disabled={scripts.length === 0 || draft.scripts.length >= MAX_SCRIPTS}
          onClick={() => setScripts([...draft.scripts, scripts[0]])}
        >
          <Plus size={13} />
          Add script
        </button>
      </div>

      <div className="study-row">
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
        {problem ??
          `${draft.scripts.length === 1 ? draft.scripts[0] : `${draft.scripts.length} scripts`} will run on ${draft.scripts.length === 1 ? 'its' : 'their'} own (${describeRule(rule)}), with your permissions, as if you had pressed Run.`}
      </p>
      <div className="study-row">
        <label className="study-check">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ ...draft, enabled: e.currentTarget.checked })} />
          Switched on
        </label>
        <label className="study-check" title={emailReady ? undefined : 'Set up email first (Email settings)'}>
          <input type="checkbox" checked={draft.emailOnFailure} onChange={(e) => onChange({ ...draft, emailOnFailure: e.currentTarget.checked })} />
          Email me if a run fails
        </label>
        {draft.emailOnFailure && !emailReady && (
          <button type="button" className="link-button small" onClick={onOpenEmail}>
            Set up email
          </button>
        )}
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
