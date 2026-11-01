import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, FilePlus2, KeyRound, Loader2, MessageSquarePlus, Send, Sparkles, X } from 'lucide-react';
import {
  aiPythonAssist,
  emailStatus,
  errorMessage,
  fyersStatus,
  getChartLayouts,
  getMarketSource,
  listDatasets,
  listProviders,
  listSchedules,
  listWatchlists,
  marketDataStatus,
  pythonProbePackages,
  savedPricesStatus,
  type PythonEnvStatus,
} from '../../lib/ipc';
import { confirmReplace } from '../../lib/dialogs';
import { BROKER_LABELS } from '../../lib/symbols';
import {
  assistHistory,
  describeSetup,
  newScriptName,
  parseAssistAnswer,
  runReport,
  todayInIndia,
  type LastRun,
  type SetupFacts,
} from '../../python/assistant';
import { diffCounts, hunks, lineDiff } from '../../python/lineDiff';
import { pythonApiReference } from '../../python/reference';
import { describeRule } from '../../python/schedules';
import { progressText } from '../../studies/assistant';
import { useAiRequest } from '../studies/useAiRequest';
import { AiProvidersDialog, aiCompany, useAiProviders } from '../ai/AiProvidersDialog';
import { AiPromptDialog } from './AiPromptDialog';

type Say = (text: string, kind: 'success' | 'error' | 'info') => void;

const FIX_QUESTION = 'Fix the error from the last run.';
/** The key a conversation is kept under while no script is open. */
const NO_SCRIPT = '';

type ProposalState = 'pending' | 'applied' | 'saved' | 'discarded';

interface Proposal {
  /** The script as it was when the question was sent: what a change is shown against, and what Apply
   *  checks the editor still holds. */
  base: string;
  code: string;
  name: string | null;
  /** A script of its own (the AI named one, or nothing was open), shown whole rather than as changes. */
  isNew: boolean;
  state: ProposalState;
  savedAs?: string;
}

interface Exchange {
  id: number;
  question: string;
  /** What went with the question besides the script, shown under it. */
  attached: string[];
  reply: string | null;
  proposal: Proposal | null;
  error: string | null;
}

interface Props {
  visible: boolean;
  current: string | null;
  /** The editor's text now, unsaved changes included. */
  source: string;
  scriptNames: string[];
  env: PythonEnvStatus | null;
  lastRun: LastRun | null;
  /** Bumped by Fix with AI: sends the fix request with the last run's error. */
  fixRequest: number;
  onApply: (code: string) => void;
  /** Saves `code` as a new script and opens it; false when it couldn't. */
  onSaveAsNew: (name: string, code: string) => Promise<boolean>;
  onClose: () => void;
  say: Say;
}

// ---- What the AI is told about this user's setup -------------------------------------------------

/** The packages each interpreter has, asked once a session: it starts Python, and they rarely change. */
const packagesByPython = new Map<string, Promise<{ name: string; version: string | null }[]>>();

function packagesOf(python: string | null) {
  const key = python ?? '';
  let found = packagesByPython.get(key);
  if (!found) {
    found = pythonProbePackages();
    packagesByPython.set(key, found);
    found.catch(() => packagesByPython.delete(key));
  }
  return found;
}

/** Everything the app can find out, each piece on its own: one that fails is simply left out. */
async function gatherSetup(current: string | null, scriptNames: readonly string[], env: PythonEnvStatus | null): Promise<SetupFacts> {
  const settle = async <T,>(p: Promise<T>): Promise<T | undefined> => p.then((v) => v, () => undefined);
  const [source, providers, market, saved, watchlists, layouts, datasets, email, schedules, packages] = await Promise.all([
    settle(getMarketSource()),
    settle(listProviders()),
    settle(marketDataStatus()),
    settle(savedPricesStatus()),
    settle(listWatchlists()),
    settle(getChartLayouts()),
    settle(listDatasets()),
    settle(emailStatus()),
    settle(listSchedules()),
    env?.state === 'ready' ? settle(packagesOf(env.python)) : Promise.resolve(undefined),
  ]);
  const facts: SetupFacts = {};
  if (source) {
    const info = providers?.find((p) => p.id === source.broker);
    facts.broker = { id: source.broker, label: BROKER_LABELS[source.broker], configured: !!info && info.enabled && info.configured };
    if (source.broker === 'fyers' && facts.broker.configured) {
      const fyers = await settle(fyersStatus());
      if (fyers) Object.assign(facts.broker, { fyersPlan: fyers.plan, requestsToday: fyers.requestsToday, dailyLimit: fyers.dailyLimit });
    }
  }
  if (market) facts.keepLoaded = market.keepLoaded;
  if (saved) facts.savedPrices = saved.on && saved.open;
  if (watchlists) facts.watchlists = watchlists.map((w) => ({ name: w.name, count: w.itemCount }));
  if (layouts) facts.layouts = layouts.map((l) => l.name);
  if (datasets) facts.datasets = datasets.map((d) => ({ ticker: d.ticker, interval: d.baseTf }));
  if (email) facts.emailReady = email.settings !== null && email.passwordSaved;
  facts.scripts = scriptNames.filter((n) => n !== current);
  if (schedules && current) {
    facts.schedules = schedules.flatMap((s) => {
      const step = s.scripts.indexOf(current);
      return step < 0 ? [] : [{ name: s.name, step: step + 1, steps: s.scripts.length, when: describeRule(s.rule), enabled: s.enabled }];
    });
  }
  if (env) facts.python = { version: env.version, custom: env.custom };
  if (packages) facts.packages = packages;
  return facts;
}

/** The prompt for an outside AI: the same reference and setup the in-app assistant gets. */
function outsidePrompt(setup: string): string {
  return `You are helping write a Python script for ProTradeChart. Use only what this reference documents.\n\n${pythonApiReference()}${
    setup ? `\n\n## This user's setup\n\n${setup}` : ''
  }`;
}

// ---- A proposal, as changes ----------------------------------------------------------------------

function ChangeCard({
  proposal,
  hasScript,
  suggestedName,
  onApply,
  onSave,
  onDiscard,
}: {
  proposal: Proposal;
  hasScript: boolean;
  suggestedName: string;
  onApply: () => void;
  onSave: (name: string) => void;
  onDiscard: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [naming, setNaming] = useState(!hasScript || proposal.isNew);
  const [name, setName] = useState(suggestedName);
  const from = proposal.isNew ? '' : proposal.base;
  const diff = useMemo(() => lineDiff(from, proposal.code), [from, proposal.code]);
  const counts = diffCounts(diff);
  const shown = useMemo(() => hunks(diff), [diff]);
  const pending = proposal.state === 'pending';

  return (
    <div className={`assist-change${pending ? '' : ' done'}`}>
      <button type="button" className="assist-change-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{proposal.isNew ? 'A new script' : 'Changes to the script'}</span>
        <span className="assist-count add">+{counts.added}</span>
        <span className="assist-count del">−{counts.removed}</span>
        <span className="assist-change-state small muted">
          {proposal.state === 'applied' && 'Applied — not saved yet'}
          {proposal.state === 'saved' && `Saved as ${proposal.savedAs}`}
          {proposal.state === 'discarded' && 'Discarded'}
        </span>
      </button>
      {open && (
        <div className="assist-diff" role="region" aria-label="Proposed changes">
          {shown.hunks.map((h, i) => (
            <div key={i}>
              {h.skipped > 0 && <div className="assist-diff-skip">⋯ {h.skipped} unchanged line{h.skipped === 1 ? '' : 's'}</div>}
              {h.lines.map((l, j) => (
                <div key={j} className={`assist-diff-line ${l.kind}`}>
                  <span className="assist-diff-no">{l.kind === 'add' ? l.newNo : l.oldNo}</span>
                  <span className="assist-diff-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                  <span className="assist-diff-text">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          ))}
          {shown.trailing > 0 && <div className="assist-diff-skip">⋯ {shown.trailing} unchanged line{shown.trailing === 1 ? '' : 's'}</div>}
        </div>
      )}
      {pending && !naming && (
        <div className="assist-change-buttons">
          {hasScript && !proposal.isNew && (
            <button type="button" className="btn btn-tiny btn-primary" onClick={onApply} title="Put this version in the editor. It isn't saved or run; Ctrl+Z undoes it.">
              <Check size={12} />
              Apply
            </button>
          )}
          <button type="button" className={`btn btn-tiny${proposal.isNew ? ' btn-primary' : ''}`} onClick={() => setNaming(true)}>
            <FilePlus2 size={12} />
            Save as new script…
          </button>
          {hasScript && proposal.isNew && (
            <button type="button" className="btn btn-tiny" onClick={onApply} title="Replace the open script with this one in the editor. It isn't saved or run; Ctrl+Z undoes it.">
              <Check size={12} />
              Apply to this script
            </button>
          )}
          <button type="button" className="btn btn-tiny" onClick={onDiscard}>
            <X size={12} />
            Discard
          </button>
        </div>
      )}
      {pending && naming && (
        <div className="assist-change-buttons">
          <input
            className="python-input assist-name"
            value={name}
            aria-label="New script name"
            spellCheck={false}
            autoFocus
            onChange={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onSave(name);
              if (e.key === 'Escape' && hasScript) setNaming(false);
            }}
          />
          <button type="button" className="btn btn-tiny btn-primary" disabled={!name.trim()} onClick={() => onSave(name)}>
            Save
          </button>
          {hasScript ? (
            <button type="button" className="btn btn-tiny" onClick={() => setNaming(false)}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-tiny" onClick={onDiscard}>
              Discard
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---- The pane ------------------------------------------------------------------------------------

/** The Python tab's AI assistant: writes or changes the open script. Its answers are proposals — shown as
 *  changes, and only Apply (into the editor, unsaved) or Save as new script does anything with them. It
 *  never saves the open script, runs one, or schedules one. Stays mounted while hidden, so a conversation
 *  survives closing the pane; one conversation per script, kept while the app is open. */
export function AssistantPane({ visible, current, source, scriptNames, env, lastRun, fixRequest, onApply, onSaveAsNew, onClose, say }: Props) {
  const [providers, reloadProviders] = useAiProviders();
  const [keyDialog, setKeyDialog] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [byScript, setByScript] = useState<Record<string, Exchange[]>>({});
  const [question, setQuestion] = useState('');
  const [withErrors, setWithErrors] = useState(true);
  const [withOutput, setWithOutput] = useState(false);
  const [lastSetup, setLastSetup] = useState<string | null>(null);
  const ai = useAiRequest();
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);
  const configured = !!providers?.active;
  const key = current ?? NO_SCRIPT;
  const exchanges = byScript[key] ?? [];

  // A run of the open script is what can go with a question; a run of another one isn't.
  const run = lastRun && lastRun.script === current ? lastRun : null;
  useEffect(() => {
    setWithErrors(true);
    setWithOutput(false);
  }, [lastRun]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [exchanges.length, ai.busy]);

  const update = useCallback(
    (script: string, id: number, patch: (e: Exchange) => Exchange) =>
      setByScript((all) => ({ ...all, [script]: (all[script] ?? []).map((e) => (e.id === id ? patch(e) : e)) })),
    [],
  );

  const send = useCallback(
    async (text: string, opts: { errors: boolean; output: boolean }) => {
      const q = text.trim();
      if (!q || ai.busy) return;
      const script = key;
      const base = source;
      const report = runReport(run, opts.errors && !!run?.failed, opts.output && !!run);
      const attached = [
        ...(report?.errors ? ['the last run’s error'] : []),
        ...(report?.output !== null && report?.output !== undefined ? ['its output'] : []),
      ];
      const id = nextId.current++;
      const history = assistHistory((byScript[script] ?? []).map((e) => ({ ...e, proposed: e.proposal !== null })));
      setByScript((all) => ({ ...all, [script]: [...(all[script] ?? []), { id, question: q, attached, reply: null, proposal: null, error: null }] }));
      setQuestion('');
      setWithOutput(false);
      try {
        const setup = describeSetup(await gatherSetup(current, scriptNames, env));
        setLastSetup(setup);
        const answer = await ai.call((requestId) =>
          aiPythonAssist(
            { question: q, scriptName: current, source: base, reference: pythonApiReference(), setup, run: report, history, today: todayInIndia() },
            requestId,
          ),
        );
        const parsed = parseAssistAnswer(answer.answer, base);
        update(script, id, (e) => ({
          ...e,
          reply: parsed.reply || null,
          proposal: parsed.code ? { base, code: parsed.code, name: parsed.name, isNew: parsed.name !== null || !base.trim(), state: 'pending' } : null,
        }));
      } catch (err) {
        update(script, id, (e) => ({ ...e, error: errorMessage(err) }));
      }
    },
    [ai, key, source, run, byScript, current, scriptNames, env, update],
  );

  // Fix with AI: the panel's button bumps this.
  const sendRef = useRef(send);
  sendRef.current = send;
  const handledFix = useRef(fixRequest);
  useEffect(() => {
    if (fixRequest === handledFix.current) return;
    handledFix.current = fixRequest;
    if (configured) void sendRef.current(FIX_QUESTION, { errors: true, output: false });
  }, [fixRequest, configured]);

  const apply = async (e: Exchange) => {
    const p = e.proposal;
    if (!p) return;
    if (source !== p.base && !(await confirmReplace('The script changed since you asked. Replace it with this version? Ctrl+Z in the editor undoes it.'))) return;
    onApply(p.code);
    update(key, e.id, (x) => ({ ...x, proposal: x.proposal && { ...x.proposal, state: 'applied' } }));
  };

  const saveAs = async (e: Exchange, name: string) => {
    const p = e.proposal;
    if (!p) return;
    const typed = name.trim().replace(/\.py$/i, '') + '.py';
    if (await onSaveAsNew(typed, p.code)) {
      update(key, e.id, (x) => ({ ...x, proposal: x.proposal && { ...x.proposal, state: 'saved', savedAs: typed } }));
    }
  };

  const copyPrompt = async () => {
    const setup = describeSetup(await gatherSetup(current, scriptNames, env));
    setPrompt(outsidePrompt(setup));
  };

  const company = aiCompany(providers);

  return (
    <aside className={`python-assist${visible ? '' : ' is-hidden'}`} aria-label="AI assistant" aria-hidden={!visible}>
      <div className="python-side-header">
        <Sparkles size={13} />
        <span>AI assistant</span>
        <div className="pine-toolbar-spacer" />
        <button type="button" className="icon-button" aria-label="Copy prompt" title="Copy a prompt with the same context, for an outside AI" onClick={() => void copyPrompt()}>
          <Copy size={13} />
        </button>
        <button type="button" className="icon-button" aria-label="AI provider" title="AI provider: which one, and its API key" onClick={() => setKeyDialog(true)}>
          <KeyRound size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="New conversation"
          title="New conversation about this script"
          disabled={ai.busy || exchanges.length === 0}
          onClick={() => setByScript((all) => ({ ...all, [key]: [] }))}
        >
          <MessageSquarePlus size={13} />
        </button>
        <button type="button" className="icon-button" aria-label="Close the assistant" title="Close" onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      {!configured && providers && (
        <div className="study-ai-setup python-assist-setup">
          <p className="small">
            Ask it to write a script, change this one, or fix an error. It knows this app’s <code>protrade</code> package and your setup, and shows
            what it would change for you to apply. It needs your own API key for an AI provider (Claude or GPT).
          </p>
          <button type="button" className="btn btn-primary btn-tiny" onClick={() => setKeyDialog(true)}>
            <KeyRound size={13} />
            Add an API key
          </button>
          <button type="button" className="btn btn-tiny" onClick={() => void copyPrompt()}>
            <Copy size={13} />
            Copy a prompt for an outside AI instead
          </button>
        </div>
      )}

      {configured && (
        <>
          <div className="python-assist-conversation">
            {exchanges.length === 0 && (
              <div className="study-ai-list">
                <h4>{current ? `About ${current}` : 'A new script'}</h4>
                <ul>
                  <li>“Screen my Nifty 50 watchlist for RSI below 30 and show the matches.”</li>
                  <li>“Add a 200-day moving average filter to this.”</li>
                  <li>“Email me the result as a CSV and save a chart of the top match.”</li>
                  <li>“Why does this print an empty table?”</li>
                </ul>
                <p className="small muted">
                  What it writes is shown as changes. Apply puts them in the editor without saving; you save and run the script yourself.
                </p>
              </div>
            )}
            {exchanges.map((e) => (
              <div key={e.id} className="study-ai-exchange">
                <div className="study-ai-question">{e.question}</div>
                {e.attached.length > 0 && <div className="assist-attached small muted">With {e.attached.join(' and ')}</div>}
                {e.error ? (
                  <p className="study-problem small">{e.error}</p>
                ) : e.reply === null && !e.proposal ? (
                  <p className="small muted">
                    <Loader2 size={12} className="spin" /> {progressText(ai.progress)}
                  </p>
                ) : (
                  <div className="study-ai-answer">
                    {e.reply && <p className="assist-reply">{e.reply}</p>}
                    {e.proposal && (
                      <ChangeCard
                        proposal={e.proposal}
                        hasScript={current !== null}
                        suggestedName={newScriptName(e.proposal.name, current, scriptNames)}
                        onApply={() => void apply(e)}
                        onSave={(name) => void saveAs(e, name)}
                        onDiscard={() => update(key, e.id, (x) => ({ ...x, proposal: x.proposal && { ...x.proposal, state: 'discarded' } }))}
                      />
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <div className="python-assist-ask">
            <div className="assist-chips">
              <span className="assist-chip" title="The editor's text, unsaved changes included">
                {current ? `Script: ${current}` : 'No script open: it writes a new one'}
              </span>
              {run?.failed && withErrors && (
                <span className="assist-chip">
                  Last run’s error
                  <button type="button" aria-label="Don’t send the last run’s error" title="Don’t send it" onClick={() => setWithErrors(false)}>
                    <X size={11} />
                  </button>
                </span>
              )}
              {run && (
                <label className="assist-output small" title="What the script printed. It can contain broker prices, so it's sent only when ticked, for this message only.">
                  <input type="checkbox" checked={withOutput} onChange={(e) => setWithOutput(e.currentTarget.checked)} />
                  Include output
                </label>
              )}
            </div>
            <div className="study-ai-ask">
              <textarea
                className="python-input"
                rows={3}
                maxLength={4000}
                value={question}
                disabled={ai.busy}
                placeholder={current ? 'Ask for a change, a fix, or a new script…' : 'Describe the script you want…'}
                onChange={(e) => setQuestion(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(question, { errors: withErrors, output: withOutput });
                }}
              />
              <button
                type="button"
                className="btn btn-primary pine-btn"
                disabled={ai.busy || !question.trim()}
                onClick={() => void send(question, { errors: withErrors, output: withOutput })}
                title="Send (Ctrl+Enter)"
              >
                {ai.busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                Send
              </button>
            </div>
            <details className="assist-sent small muted">
              <summary>What’s sent</summary>
              <p>
                Your question, this script, the app’s Python reference and a description of your setup (broker, settings, the names of your watchlists,
                layouts and scripts — not what’s in them) go to {company} under your account, and each request is billed to it. The last run’s error goes
                only while its chip is shown, and what the script printed only when you tick Include output. Never your credentials or email address.
              </p>
              {lastSetup !== null && <pre className="assist-setup-text">{lastSetup || 'Nothing could be found out about the setup.'}</pre>}
            </details>
          </div>
        </>
      )}

      {keyDialog && <AiProvidersDialog providers={providers} onClose={() => setKeyDialog(false)} onChanged={reloadProviders} say={say} />}
      {prompt !== null && <AiPromptDialog text={prompt} onClose={() => setPrompt(null)} />}
    </aside>
  );
}
