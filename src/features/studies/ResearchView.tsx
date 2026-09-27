import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, CheckCircle2, CircleDashed, CirclePlay, KeyRound, Loader2, Pencil, Sparkles, Square, XCircle } from 'lucide-react';
import {
  addNotebookItem,
  aiPlanResearch,
  aiSynthesizeResearch,
  errorMessage,
  getNotebook,
  getStudyResult,
  saveNotebook,
  saveStudy,
  setNotebookItemNote,
  type AiSynthesisRequest,
  type NotebookItemKind,
} from '../../lib/ipc';
import { explainSummary, progressText, specReference } from '../../studies/assistant';
import { formatDuration, loadFrom, type Readiness, type UniverseEstimate } from '../../studies/readiness';
import {
  appendNotes,
  finished,
  isRunning,
  newQueue,
  parsePlan,
  parseSynthesis,
  queue,
  roundNotes,
  synthesisContext,
  synthesisNotes,
  type ItemStatus,
  type QueueAction,
  type QueueItem,
  type ResearchPlan,
  type Synthesis,
} from '../../studies/research';
import { parseStudyResult } from '../../studies/result';
import { interpret, type StudySpec } from '../../studies/spec';
import { ApiKeyDialog, PRIVACY, useKeyStatus } from './AssistantPanel';
import { estimateUniverse } from './estimate';
import { useAiRequest } from './useAiRequest';
import type { RunOutcome } from './useStudyRunner';

type Say = (text: string, kind: 'success' | 'error' | 'info') => void;

interface Round {
  question: string;
  plan: ResearchPlan;
  items: QueueItem[];
  /** Per planned Study: its readiness and seconds of fetching, once the universe's cost is known. */
  readiness: ({ readiness: Readiness; seconds: number } | null)[];
  synthesis: Synthesis | null;
  /** The Studies the synthesis covers, by index into the plan. */
  synthesised: number[];
}

interface Props {
  /** Runs one Study and settles when it has finished (`useStudyRunner().start`). */
  startRun: (spec: StudySpec, studyId: string) => Promise<RunOutcome>;
  stopRun: () => void;
  /** Whether a Study (from here or from Run Study) is running. */
  busyRunning: boolean;
  readinessOf: (spec: StudySpec, estimate: UniverseEstimate | null) => Readiness;
  watchlistRows: readonly { id: number; name: string }[];
  onOpenResult: (id: string) => void;
  onOpenInBuilder: (spec: StudySpec) => void;
  onOpenNotebook: (id: string) => void;
  /** Studies, results or notebooks were saved: re-read the lists. */
  onChanged: () => void;
  say: Say;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const STATUS: Record<ItemStatus, { label: string; icon: typeof CheckCircle2 | null }> = {
  proposed: { label: 'Not approved', icon: null },
  approved: { label: 'Approved', icon: null },
  queued: { label: 'Waiting to run', icon: CircleDashed },
  running: { label: 'Running', icon: Loader2 },
  done: { label: 'Done', icon: CheckCircle2 },
  failed: { label: 'Failed', icon: XCircle },
  skipped: { label: 'Skipped', icon: CircleDashed },
};

/** Sets the note on a notebook's entry for `refId`. */
async function noteEntry(notebookId: string, kind: NotebookItemKind, refId: string, note: string) {
  const nb = await getNotebook(notebookId);
  const item = nb?.items.find((i) => i.kind === kind && i.refId === refId);
  if (item) await setNotebookItemNote(item.id, note.slice(0, 10_000));
}

async function appendToNotebook(notebookId: string, block: string) {
  const nb = await getNotebook(notebookId);
  if (nb) await saveNotebook(nb.id, nb.name, appendNotes(nb.notes, block).slice(0, 100_000));
}

/** The research agent: a question → Claude's plan of Studies → the ones you approve, run one after
 *  another → Claude's synthesis → follow-up questions, each needing its own plan and approval.
 *  Everything is recorded in a Research Notebook as it happens. */
export function ResearchView(props: Props) {
  const { startRun, stopRun, busyRunning, readinessOf, watchlistRows, say } = props;
  const [status, reloadStatus] = useKeyStatus();
  const [keyDialog, setKeyDialog] = useState(false);
  const [question, setQuestion] = useState('');
  const [rounds, setRounds] = useState<Round[]>([]);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ai = useAiRequest();
  const stopping = useRef(false);
  const roundsRef = useRef(rounds);
  roundsRef.current = rounds;

  const update = (index: number, patch: (r: Round) => Partial<Round>) =>
    setRounds((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch(r) } : r)));
  const dispatch = (index: number, action: QueueAction) => update(index, (r) => ({ items: queue(r.items, action) }));

  const latest = rounds[rounds.length - 1] ?? null;
  const running = rounds.some((r) => isRunning(r.items));
  const configured = status?.configured ?? false;

  // Each planned Study's readiness, with what its universe will cost to load.
  const readinessKey = rounds.map((r) => r.plan.studies.length).join(',');
  useEffect(() => {
    rounds.forEach((round, ri) => {
      round.plan.studies.forEach((planned, si) => {
        if (!planned.spec || round.readiness[si]) return;
        const spec = planned.spec;
        estimateUniverse(spec.universe, loadFrom(spec), watchlistRows)
          .catch(() => null)
          .then((estimate) => {
            const check = { readiness: readinessOf(spec, estimate), seconds: estimate?.seconds ?? 0 };
            update(ri, (r) => ({ readiness: r.readiness.map((x, k) => (k === si ? check : x)) }));
          });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readinessKey]);

  const plan = async (q: string, context: string | null) => {
    const text = q.trim();
    if (!text || ai.busy) return;
    if (!configured) {
      setKeyDialog(true);
      return;
    }
    setError(null);
    try {
      const reply = await ai.call((id) =>
        aiPlanResearch({ question: text, reference: specReference(), today: today(), context }, id),
      );
      const parsed = parsePlan(reply.answer);
      if (!parsed.studies.length && !parsed.unavailable.length) throw new Error('Claude proposed no Studies. Try rephrasing the question.');
      setRounds((rs) => [
        ...rs,
        { question: text, plan: parsed, items: newQueue(parsed), readiness: parsed.studies.map(() => null), synthesis: null, synthesised: [] },
      ]);
      setQuestion('');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  /** Saves the approved Studies into the notebook, then runs them one by one. The only place a run starts. */
  const runApproved = async (ri: number) => {
    const round = roundsRef.current[ri];
    const approved = round.items.flatMap((it, i) => (it.status === 'approved' ? [i] : []));
    if (!approved.length || running || busyRunning) return;
    stopping.current = false;
    setError(null);
    let nb = notebookId;
    const ids: (string | null)[] = round.items.map(() => null);
    try {
      const block = roundNotes(ri + 1, round.question, round.plan, today());
      if (!nb) {
        nb = crypto.randomUUID();
        await saveNotebook(nb, `Research: ${round.question}`.slice(0, 200), block);
        setNotebookId(nb);
      } else {
        await appendToNotebook(nb, block);
      }
      for (const i of approved) {
        const spec = round.plan.studies[i].spec!;
        const id = crypto.randomUUID();
        await saveStudy({ id, name: spec.name, specJson: JSON.stringify(spec), createdAt: '', updatedAt: '' });
        await addNotebookItem(nb, 'study', id);
        if (round.plan.studies[i].purpose) await noteEntry(nb, 'study', id, round.plan.studies[i].purpose);
        ids[i] = id;
      }
    } catch (err) {
      setError(`Couldn’t record the plan in a notebook: ${errorMessage(err)}`);
      props.onChanged();
      return;
    }
    props.onChanged();
    dispatch(ri, { type: 'queue', studyIds: ids });

    for (const i of approved) {
      if (stopping.current) break;
      dispatch(ri, { type: 'running', index: i });
      const outcome = await startRun(round.plan.studies[i].spec!, ids[i]!);
      if (outcome.resultId) {
        dispatch(ri, { type: 'done', index: i, resultId: outcome.resultId });
        await addNotebookItem(nb, 'result', outcome.resultId).catch(() => {});
      } else {
        dispatch(ri, { type: 'failed', index: i, error: outcome.error ?? 'The Study didn’t produce a result.' });
      }
    }
    if (stopping.current) dispatch(ri, { type: 'stop' });
    props.onChanged();
  };

  const stop = () => {
    stopping.current = true;
    stopRun();
    rounds.forEach((_, ri) => dispatch(ri, { type: 'stop' }));
  };

  const synthesise = async (ri: number) => {
    const round = roundsRef.current[ri];
    const done = finished(round.items);
    if (!done.length || ai.busy) return;
    setError(null);
    try {
      const studies: AiSynthesisRequest['studies'] = [];
      for (const i of done) {
        const row = await getStudyResult(round.items[i].resultId!);
        const data = row ? parseStudyResult(JSON.parse(row.resultJson)) : null;
        if (!data) throw new Error(`The result of “${round.plan.studies[i].spec?.name}” is no longer stored.`);
        studies.push({ purpose: round.plan.studies[i].purpose, spec: data.spec, summary: explainSummary(data), warnings: data.warnings.map((w) => w.message) });
      }
      const reply = await ai.call((id) => aiSynthesizeResearch({ question: round.question, studies }, id));
      const synthesis = parseSynthesis(reply.answer, done.length);
      if (!synthesis) throw new Error('Claude’s synthesis was empty.');
      update(ri, () => ({ synthesis, synthesised: done }));
      if (notebookId) {
        await appendToNotebook(notebookId, synthesisNotes(ri + 1, synthesis));
        for (const [k, i] of done.entries()) {
          const note = synthesis.notes[k];
          if (note) await noteEntry(notebookId, 'result', round.items[i].resultId!, note);
        }
        props.onChanged();
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const reset = () => {
    setRounds([]);
    setNotebookId(null);
    setError(null);
  };

  return (
    <div className="study-research">
      <div className="study-research-head">
        <h2>
          <Sparkles size={16} />
          Research with Claude
        </h2>
        <div className="pine-toolbar-spacer" />
        {notebookId && (
          <button type="button" className="btn btn-tiny" onClick={() => props.onOpenNotebook(notebookId)}>
            <BookOpen size={13} />
            Open the notebook
          </button>
        )}
        {rounds.length > 0 && !running && (
          <button type="button" className="btn btn-tiny" onClick={reset}>
            New research
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Claude API key" title="Claude API key" onClick={() => setKeyDialog(true)}>
          <KeyRound size={14} />
        </button>
      </div>
      <p className="muted small">
        Ask a research question. Claude proposes a few Studies that together answer it; you choose which to run, and they run one after
        another. Then Claude can write a synthesis across the results and suggest what to study next. Everything is kept in a Research
        Notebook. {PRIVACY}
      </p>

      {rounds.map((round, ri) => (
        <RoundView
          key={ri}
          index={ri}
          round={round}
          canRun={!running && !busyRunning}
          aiBusy={ai.busy}
          aiProgress={progressText(ai.progress)}
          onToggle={(i, runnable) => dispatch(ri, { type: 'toggle', index: i, runnable })}
          onRun={() => void runApproved(ri)}
          onStop={stop}
          onSynthesise={() => void synthesise(ri)}
          onFollowUp={(q) => void plan(q, round.synthesis ? synthesisContext(round.synthesis) : null)}
          onOpenResult={props.onOpenResult}
          onOpenInBuilder={props.onOpenInBuilder}
          isLatest={ri === rounds.length - 1}
        />
      ))}

      {error && <p className="study-problem small">{error}</p>}

      {(!latest || latest.synthesis || latest.plan.studies.length === 0) && (
        <div className="study-ai-ask">
          <textarea
            className="python-input"
            rows={2}
            maxLength={4000}
            value={question}
            disabled={ai.busy}
            placeholder={
              rounds.length
                ? 'Ask a follow-up question, or pick one of the suggestions above.'
                : 'e.g. “What do NSE stocks look like before they double within a year, and does it differ for those that keep going?”'
            }
            onChange={(e) => setQuestion(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void plan(question, latest?.synthesis ? synthesisContext(latest.synthesis) : null);
            }}
          />
          <button
            type="button"
            className="btn btn-primary pine-btn"
            disabled={ai.busy || !question.trim()}
            onClick={() => void plan(question, latest?.synthesis ? synthesisContext(latest.synthesis) : null)}
          >
            {ai.busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {ai.busy ? progressText(ai.progress) : 'Plan Studies'}
          </button>
        </div>
      )}

      {keyDialog && <ApiKeyDialog status={status} onClose={() => setKeyDialog(false)} onChanged={reloadStatus} say={say} />}
    </div>
  );
}

interface RoundProps {
  index: number;
  round: Round;
  canRun: boolean;
  aiBusy: boolean;
  aiProgress: string;
  isLatest: boolean;
  onToggle: (index: number, runnable: boolean) => void;
  onRun: () => void;
  onStop: () => void;
  onSynthesise: () => void;
  onFollowUp: (question: string) => void;
  onOpenResult: (id: string) => void;
  onOpenInBuilder: (spec: StudySpec) => void;
}

function RoundView({ index, round, canRun, aiBusy, aiProgress, isLatest, ...on }: RoundProps) {
  const { plan, items, readiness } = round;
  const approved = items.flatMap((it, i) => (it.status === 'approved' ? [i] : []));
  const seconds = approved.reduce((sum, i) => sum + (readiness[i]?.seconds ?? 0), 0);
  const active = isRunning(items);
  const done = finished(items);
  const started = items.some((it) => it.status !== 'proposed' && it.status !== 'approved');

  return (
    <section className="study-research-round" aria-label={`Round ${index + 1}`}>
      <div className="study-ai-question">{round.question}</div>
      {plan.summary && <p>{plan.summary}</p>}
      {plan.unavailable.length > 0 && (
        <div className="study-ai-list warning">
          <h4>Can’t be studied with the data available</h4>
          <ul>
            {plan.unavailable.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      <ol className="study-research-plan">
        {plan.studies.map((planned, i) => {
          const item = items[i];
          const ready = readiness[i]?.readiness;
          const blocking = ready?.items.filter((r) => r.blocking) ?? [];
          const runnable = !!planned.spec && !!ready?.ready;
          const Icon = STATUS[item.status].icon;
          return (
            <li key={i} className={`study-card study-research-study ${item.status}`}>
              <div className="study-research-study-head">
                {item.status === 'proposed' || item.status === 'approved' ? (
                  <label className="study-research-approve">
                    <input
                      type="checkbox"
                      checked={item.status === 'approved'}
                      disabled={!runnable || active}
                      onChange={() => on.onToggle(i, runnable)}
                    />
                    Approve
                  </label>
                ) : (
                  <span className={`study-research-status ${item.status}`}>
                    {Icon && <Icon size={13} className={item.status === 'running' ? 'spin' : undefined} />}
                    {STATUS[item.status].label}
                  </span>
                )}
                <strong>{planned.spec?.name ?? `Study ${i + 1}`}</strong>
                <div className="pine-toolbar-spacer" />
                {item.resultId && (
                  <button type="button" className="btn btn-tiny" onClick={() => on.onOpenResult(item.resultId!)}>
                    Open result
                  </button>
                )}
                {planned.spec && (
                  <button type="button" className="icon-button" aria-label="Open in the builder" title="Open in the builder (as a new Study)" onClick={() => on.onOpenInBuilder(planned.spec!)}>
                    <Pencil size={13} />
                  </button>
                )}
              </div>
              {planned.purpose && <p className="small">{planned.purpose}</p>}
              {planned.problem && (
                <p className="study-problem small">
                  <AlertTriangle size={13} /> Can’t run: {planned.problem}
                </p>
              )}
              {item.error && <p className="study-problem small">{item.error}</p>}
              {planned.spec && (
                <details>
                  <summary className="small">What it studies</summary>
                  <ul className="small">
                    {interpret(planned.spec).map((p) => (
                      <li key={p.heading}>
                        <strong>{p.heading}:</strong> {p.lines.join('; ')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {planned.assumptions.length > 0 && <p className="small muted">Assumes: {planned.assumptions.join(' ')}</p>}
              {planned.unavailable.length > 0 && <p className="small muted">Not studied: {planned.unavailable.join(' ')}</p>}
              {planned.spec && !ready && <p className="small muted">Checking the data…</p>}
              {blocking.length > 0 && (
                <p className="study-problem small">
                  Not ready: {blocking.map((b) => `${b.field} — ${b.detail.replace(/\.$/, '')}`).join('; ')}. Open it in the builder to change it.
                </p>
              )}
              {round.synthesis && round.synthesised.includes(i) && round.synthesis.notes[round.synthesised.indexOf(i)] && (
                <p className="small">
                  <Sparkles size={12} /> {round.synthesis.notes[round.synthesised.indexOf(i)]}
                </p>
              )}
            </li>
          );
        })}
      </ol>

      <div className="study-ai-actions">
        {active ? (
          <button type="button" className="btn pine-btn python-stop" onClick={on.onStop}>
            <Square size={13} />
            Stop
          </button>
        ) : (
          !started && (
            <button type="button" className="btn btn-primary pine-btn" disabled={!approved.length || !canRun} onClick={on.onRun}>
              <CirclePlay size={14} />
              {approved.length
                ? `Run ${approved.length} approved ${approved.length === 1 ? 'Study' : 'Studies'}${seconds > 0 ? ` (${formatDuration(seconds)} of data to fetch)` : ''}`
                : 'Approve the Studies to run'}
            </button>
          )
        )}
        {!active && done.length > 0 && !round.synthesis && (
          <button type="button" className="btn pine-btn" disabled={aiBusy} onClick={on.onSynthesise}>
            {aiBusy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {aiBusy ? aiProgress : `Write the synthesis of ${done.length} result${done.length === 1 ? '' : 's'}`}
          </button>
        )}
        {!started && <span className="muted small">Nothing runs until you press Run.</span>}
      </div>

      {round.synthesis && (
        <div className="study-card study-research-synthesis">
          <h3>
            <Sparkles size={14} />
            Synthesis
          </h3>
          {round.synthesis.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {round.synthesis.caveats.length > 0 && (
            <div className="study-ai-list warning">
              <h4>Caveats</h4>
              <ul>
                {round.synthesis.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted small">Written by Claude from the results’ summaries: historical association, not causation, and not advice.</p>
          {isLatest && round.synthesis.followUps.length > 0 && (
            <div className="study-ai-list">
              <h4>What to study next</h4>
              <ul className="study-research-follow">
                {round.synthesis.followUps.map((f, i) => (
                  <li key={i}>
                    <span>{f}</span>
                    <button type="button" className="btn btn-tiny" disabled={aiBusy} onClick={() => on.onFollowUp(f)}>
                      Plan this
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
