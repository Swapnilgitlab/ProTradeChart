import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, MessageSquarePlus, Send, Sparkles, X } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { confirmDelete } from '../../lib/dialogs';
import { aiDeleteKey, aiDraftStudy, aiExplainResult, aiKeyStatus, aiSetKey, errorMessage, type AiKeyStatus } from '../../lib/ipc';
import { explainSummary, parseDraft, parseExplanation, SPEC_SCHEMA, specReference, type Draft, type Explanation, type Turn } from '../../studies/assistant';
import { specChanges } from '../../studies/compare';
import type { StudyResultData } from '../../studies/result';
import { interpret, type StudySpec } from '../../studies/spec';

type Say = (text: string, kind: 'success' | 'error' | 'info') => void;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The key's status, re-read when the dialog changes it. */
function useKeyStatus(): [AiKeyStatus | null, () => void] {
  const [status, setStatus] = useState<AiKeyStatus | null>(null);
  const reload = useCallback(() => {
    aiKeyStatus()
      .then(setStatus)
      .catch(() => setStatus({ configured: false, storage: null }));
  }, []);
  useEffect(reload, [reload]);
  return [status, reload];
}

const PRIVACY =
  'Your question, the Study Specification and, when you ask for an explanation, a summary of the result (counts, medians and tests — not the ' +
  'events or prices) are sent to Anthropic under your account, and each request is billed to it.';

/** Paste, replace or remove the Anthropic API key. The key goes to Rust, which checks it with Anthropic
 *  and keeps it in the OS keychain; it never comes back here. */
export function ApiKeyDialog({ status, onClose, onChanged, say }: { status: AiKeyStatus | null; onClose: () => void; onChanged: () => void; say: Say }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await aiSetKey(key);
      setKey('');
      onChanged();
      say(next.storage === 'database' ? 'Key saved in the app’s database: no OS keychain was available.' : 'Anthropic API key saved.', 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDelete('Remove the Anthropic API key from this computer?'))) return;
    try {
      await aiDeleteKey();
      onChanged();
      say('Anthropic API key removed.', 'info');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      title="Claude API key"
      onClose={onClose}
      footer={
        <>
          {status?.configured && (
            <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>
              Remove key
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || !key.trim()} onClick={() => void save()}>
            {busy ? 'Checking…' : 'Save key'}
          </button>
        </>
      }
    >
      <p className="small">
        The AI Study Builder uses Claude with your own Anthropic API key. Create one at console.anthropic.com (API keys). It is checked with
        Anthropic, then kept in your operating system’s keychain; the app never shows it again.
      </p>
      <p className="small muted">{PRIVACY}</p>
      <div className="field">
        <label htmlFor="ai-key">API key</label>
        <input
          id="ai-key"
          type="password"
          value={key}
          placeholder={status?.configured ? '•••••••• saved — paste to replace' : 'sk-ant-…'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && !busy && void save()}
        />
        {status?.storage === 'database' && <span className="field-hint">Saved unencrypted in the app’s database: no OS keychain is available.</span>}
      </div>
      {error && <p className="study-problem small">{error}</p>}
    </Dialog>
  );
}

interface Exchange {
  question: string;
  /** What the proposal is compared against: the spec it revised, if any. */
  base: StudySpec | null;
  draft: Draft | null;
  /** The answer as Claude sent it, for the conversation's history. */
  raw: string | null;
  error: string | null;
  model: string | null;
}

function Proposal({ exchange, onUse, useLabel }: { exchange: Exchange; onUse: (spec: StudySpec) => void; useLabel: string }) {
  const { draft, base } = exchange;
  if (!draft) return null;
  const changes = draft.spec && base ? specChanges(base, draft.spec) : null;
  return (
    <div className="study-ai-answer">
      {draft.reply && <p>{draft.reply}</p>}
      {draft.problem && (
        <p className="study-problem small">
          <AlertTriangle size={13} /> The proposed spec can’t be used: {draft.problem} Ask again, or describe the fix.
        </p>
      )}
      {draft.unavailable.length > 0 && (
        <div className="study-ai-list warning">
          <h4>Can’t be studied with the data available</h4>
          <ul>
            {draft.unavailable.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.spec && changes && (
        <div className="study-ai-list">
          <h4>What changed</h4>
          {changes.length === 0 ? (
            <p className="small muted">Nothing: the spec is as it was.</p>
          ) : (
            <ul>
              {changes.map((c) => (
                <li key={c.part}>
                  <strong>{c.part}:</strong> {c.b}
                  <span className="muted"> (was: {c.a})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {draft.spec && !changes && (
        <div className="study-ai-list">
          <h4>{draft.spec.name}</h4>
          <ul>
            {interpret(draft.spec).map((p) => (
              <li key={p.heading}>
                <strong>{p.heading}:</strong> {p.lines.join('; ')}
              </li>
            ))}
          </ul>
        </div>
      )}
      {draft.assumptions.length > 0 && (
        <div className="study-ai-list">
          <h4>Assumptions to check</h4>
          <ul>
            {draft.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.spec && (
        <div className="study-ai-actions">
          <button type="button" className="btn btn-primary btn-tiny" onClick={() => onUse(draft.spec!)}>
            {useLabel}
          </button>
          <span className="muted small">Nothing runs until you press Run Study.</span>
        </div>
      )}
    </div>
  );
}

interface Props {
  /** The Study being edited, when it is a valid spec. */
  current: StudySpec | null;
  /** Opens a proposal as a new, unsaved Study. */
  onUseNew: (spec: StudySpec) => void;
  /** Replaces the Study's spec with a proposal (unsaved until Save). */
  onUseRevision: (spec: StudySpec) => void;
  say: Say;
}

/** "Ask Claude": a research question → a proposed Study Specification, or an instruction → a change
 *  to the current one. Every proposal is validated, shown with what it changes and what it assumes,
 *  and only loaded into the builder when the user says so. */
export function AssistantPanel({ current, onUseNew, onUseRevision, say }: Props) {
  const [status, reloadStatus] = useKeyStatus();
  const [open, setOpen] = useState(false);
  const [keyDialog, setKeyDialog] = useState(false);
  const [mode, setMode] = useState<'new' | 'change'>('new');
  const [question, setQuestion] = useState('');
  const [conversation, setConversation] = useState<Exchange[]>([]);
  const [busy, setBusy] = useState(false);

  const restart = (next: 'new' | 'change' = mode) => {
    setMode(next);
    setConversation([]);
  };

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    // A follow-up revises the last proposal; changing the Study starts from the Study as it is now.
    const lastSpec = [...conversation].reverse().find((e) => e.draft?.spec)?.draft?.spec ?? null;
    const base = mode === 'change' ? (lastSpec ?? current) : lastSpec;
    if (mode === 'change' && !base) {
      say('Fix the Study’s problems first, so Claude has a valid spec to change.', 'info');
      return;
    }
    const history: Turn[] = conversation
      .filter((e) => e.raw)
      .flatMap((e) => [
        { role: 'user' as const, text: e.question },
        { role: 'assistant' as const, text: e.raw! },
      ]);
    setBusy(true);
    setQuestion('');
    try {
      const reply = await aiDraftStudy({
        question: q,
        reference: specReference(),
        specSchema: SPEC_SCHEMA,
        currentSpec: base,
        history,
        today: today(),
      });
      setConversation((c) => [...c, { question: q, base, draft: parseDraft(reply.answer), raw: JSON.stringify(reply.answer), error: null, model: reply.model }]);
    } catch (err) {
      setConversation((c) => [...c, { question: q, base, draft: null, raw: null, error: errorMessage(err), model: null }]);
    } finally {
      setBusy(false);
    }
  };

  const configured = status?.configured ?? false;

  return (
    <section className={`study-ai${open ? ' open' : ''}`} aria-label="Ask Claude">
      <div className="study-ai-head">
        <button type="button" className="study-ai-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Sparkles size={14} />
          Ask Claude to draft or change this Study
        </button>
        <div className="pine-toolbar-spacer" />
        {open && conversation.length > 0 && (
          <button type="button" className="btn btn-tiny" onClick={() => restart()} title="Start a new conversation">
            <MessageSquarePlus size={13} />
            New conversation
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Claude API key" title="Claude API key" onClick={() => setKeyDialog(true)}>
          <KeyRound size={14} />
        </button>
      </div>

      {open && !configured && status && (
        <div className="study-ai-setup">
          <p className="small">
            Describe what you want to research — “What did stocks look like before they doubled in a year?” — and Claude drafts a Study
            Specification for you to review. It needs your own Anthropic API key.
          </p>
          <p className="small muted">{PRIVACY}</p>
          <button type="button" className="btn btn-primary btn-tiny" onClick={() => setKeyDialog(true)}>
            <KeyRound size={13} />
            Add an API key
          </button>
        </div>
      )}

      {open && configured && (
        <div className="study-ai-body">
          <div className="study-ai-mode" role="radiogroup" aria-label="What to ask for">
            <label>
              <input type="radio" name="study-ai-mode" checked={mode === 'new'} onChange={() => restart('new')} />A new Study
            </label>
            <label>
              <input type="radio" name="study-ai-mode" checked={mode === 'change'} onChange={() => restart('change')} />
              Change this Study
            </label>
          </div>
          {conversation.map((e, i) => (
            <div key={i} className="study-ai-exchange">
              <div className="study-ai-question">{e.question}</div>
              {e.error ? (
                <p className="study-problem small">{e.error}</p>
              ) : (
                <Proposal exchange={e} useLabel={mode === 'new' ? 'Open as a new Study' : 'Apply to this Study'} onUse={mode === 'new' ? onUseNew : onUseRevision} />
              )}
            </div>
          ))}
          <div className="study-ai-ask">
            <textarea
              className="python-input"
              rows={2}
              maxLength={4000}
              value={question}
              disabled={busy}
              placeholder={
                conversation.length
                  ? 'Ask for a change — “only NSE”, “add RSI a month before”…'
                  : mode === 'new'
                    ? 'What do you want to research? e.g. “What did stocks look like 3 months before a 52-week-high breakout on double volume?”'
                    : 'What should change? e.g. “Use NSE and BSE, and add RSI and ADX a month before the event.”'
              }
              onChange={(e) => setQuestion(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask();
              }}
            />
            <button type="button" className="btn btn-primary pine-btn" disabled={busy || !question.trim()} onClick={() => void ask()} title="Ask (Ctrl+Enter)">
              {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
              {busy ? 'Thinking…' : 'Ask'}
            </button>
          </div>
          <p className="muted small">
            Claude proposes; you decide. Proposals are checked like any spec and flagged where data doesn’t exist. Findings are historical
            associations, not causes.
          </p>
        </div>
      )}

      {keyDialog && <ApiKeyDialog status={status} onClose={() => setKeyDialog(false)} onChanged={reloadStatus} say={say} />}
    </section>
  );
}

/** "Explain with Claude" above a result: the result's summary, explained in plain words. Not stored. */
export function ResultExplainer({ result, say }: { result: StudyResultData; say: Say }) {
  const [status, reloadStatus] = useKeyStatus();
  const [keyDialog, setKeyDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const explain = async () => {
    if (!status?.configured) {
      setKeyDialog(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const reply = await aiExplainResult({
        spec: result.spec,
        summary: explainSummary(result),
        warnings: result.warnings.map((w) => w.message),
      });
      const parsed = parseExplanation(reply.answer);
      if (!parsed) throw new Error('Claude’s explanation was empty.');
      setExplanation(parsed);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="study-ai-explain">
      {!explanation ? (
        <div className="study-ai-actions">
          <button type="button" className="btn pine-btn" disabled={busy} onClick={() => void explain()} title="Send this result’s summary to Claude for a plain-language explanation">
            {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {busy ? 'Explaining…' : 'Explain with Claude'}
          </button>
          {error && <span className="study-problem small">{error}</span>}
        </div>
      ) : (
        <div className="study-card">
          <h3>
            <Sparkles size={14} />
            Claude’s explanation
            <div className="pine-toolbar-spacer" />
            <button type="button" className="icon-button" aria-label="Close the explanation" onClick={() => setExplanation(null)}>
              <X size={13} />
            </button>
          </h3>
          {explanation.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {explanation.caveats.length > 0 && (
            <div className="study-ai-list warning">
              <h4>Caveats</h4>
              <ul>
                {explanation.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted small">
            Written by Claude from this result’s summary. It describes historical associations, not causes, and isn’t advice. Check it against
            the numbers below.
          </p>
        </div>
      )}
      {keyDialog && <ApiKeyDialog status={status} onClose={() => setKeyDialog(false)} onChanged={reloadStatus} say={say} />}
    </div>
  );
}
