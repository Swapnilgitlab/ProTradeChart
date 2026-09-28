import { useState } from 'react';
import { Check, KeyRound, Loader2, Send, Sparkles, X } from 'lucide-react';
import type { ActionResult } from '../../chart/ChartView';
import { askAi, errorMessage, listWatchlists, type ProposedAction } from '../../lib/ipc';
import { progressText, type Turn } from '../../studies/assistant';
import { useAiRequest } from '../studies/useAiRequest';
import { prepareAction, type ActionContext, type PreparedAction } from './actions';
import { AiProvidersDialog, privacyNote, useAiProviders } from './AiProvidersDialog';

type Say = (text: string, kind: 'success' | 'error' | 'info') => void;
type ActionState = 'pending' | 'running' | 'done' | 'rejected';

interface TrackedAction {
  prepared: PreparedAction;
  state: ActionState;
  result?: ActionResult;
}

interface Exchange {
  question: string;
  reply: string | null;
  actions: TrackedAction[];
  error: string | null;
}

interface Props {
  visible: boolean;
  activeSymbol: string;
  openTabs: string[];
  /** Read fresh each time a question is sent — not kept as state, since it only matters at that
   *  moment (see `ChartView.getMarket`). */
  getTimeframe: () => string | null;
  say: Say;
}

function ActionCard({ tracked, onApprove, onReject }: { tracked: TrackedAction; onApprove: () => void; onReject: () => void }) {
  return (
    <div className={`ai-action-card${tracked.state === 'rejected' ? ' rejected' : ''}`}>
      <span className="ai-action-summary">{tracked.prepared.summary}</span>
      {tracked.state === 'pending' && (
        <div className="ai-action-buttons">
          <button type="button" className="btn btn-tiny btn-primary" onClick={onApprove}>
            <Check size={12} />
            Approve
          </button>
          <button type="button" className="btn btn-tiny" onClick={onReject}>
            <X size={12} />
            Reject
          </button>
        </div>
      )}
      {tracked.state === 'running' && <Loader2 size={13} className="spin" />}
      {tracked.state === 'done' && (
        <span className={`small ${tracked.result?.ok ? '' : 'study-problem'}`}>{tracked.result?.message}</span>
      )}
      {tracked.state === 'rejected' && <span className="small muted">Not done.</span>}
    </div>
  );
}

/** Ask AI: a question about the app → words, proposed actions, or both. Every action shown here
 *  needs its own Approve before anything runs — see `actions.ts` and "Ask AI" in
 *  `docs/ARCHITECTURE.md`. Stays mounted while another rail panel shows, so the conversation is
 *  still there when you come back (same as the watchlist). */
export function AskAiPanel({ visible, activeSymbol, openTabs, getTimeframe, say, ...ctx }: Props & ActionContext) {
  const [status, reloadStatus] = useAiProviders();
  const [keyDialog, setKeyDialog] = useState(false);
  const [question, setQuestion] = useState('');
  const [conversation, setConversation] = useState<Exchange[]>([]);
  const ai = useAiRequest();
  const busy = ai.busy;
  const configured = !!status?.active;

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    const history: Turn[] = conversation
      .filter((e) => e.reply || e.actions.length > 0)
      .flatMap((e) => [
        { role: 'user' as const, text: e.question },
        { role: 'assistant' as const, text: e.reply || '(proposed an action)' },
      ]);
    setQuestion('');
    let watchlistNames: string[] = [];
    try {
      watchlistNames = (await listWatchlists()).map((w) => w.name);
    } catch {
      // Best-effort context: the assistant still works without the watchlist names.
    }
    try {
      const reply = await ai.call((id) =>
        askAi(
          {
            question: q,
            context: { activeSymbol, activeTimeframe: getTimeframe(), openTabs, watchlistNames },
            history,
          },
          id,
        ),
      );
      const actions: TrackedAction[] = reply.actions
        .map((a: ProposedAction) => prepareAction(a, ctx))
        .filter((p): p is PreparedAction => p !== null)
        .map((prepared) => ({ prepared, state: 'pending' as const }));
      setConversation((c) => [...c, { question: q, reply: reply.reply.trim() || null, actions, error: null }]);
    } catch (err) {
      setConversation((c) => [...c, { question: q, reply: null, actions: [], error: errorMessage(err) }]);
    }
  };

  const setActionState = (exchangeIndex: number, actionIndex: number, patch: Partial<TrackedAction>) =>
    setConversation((c) =>
      c.map((e, i) => (i === exchangeIndex ? { ...e, actions: e.actions.map((a, j) => (j === actionIndex ? { ...a, ...patch } : a)) } : e)),
    );

  const approve = async (exchangeIndex: number, actionIndex: number) => {
    setActionState(exchangeIndex, actionIndex, { state: 'running' });
    const { prepared } = conversation[exchangeIndex].actions[actionIndex];
    const result = await prepared.run().catch((err): ActionResult => ({ ok: false, message: errorMessage(err) }));
    setActionState(exchangeIndex, actionIndex, { state: 'done', result });
    say(result.message, result.ok ? 'success' : 'error');
  };

  return (
    <aside className={`ai-panel${visible ? '' : ' is-hidden'}`} aria-label="Ask AI" aria-hidden={!visible}>
      <div className="panel-title">
        <Sparkles size={14} />
        Ask AI
        <div className="pine-toolbar-spacer" />
        <button type="button" className="icon-button" aria-label="AI provider" title="AI provider: which one, and its API key" onClick={() => setKeyDialog(true)}>
          <KeyRound size={14} />
        </button>
      </div>
      <div className="ai-panel-body">
        {!configured && status && (
          <div className="study-ai-setup">
            <p className="small">
              Ask it to add a symbol to a watchlist, change the chart, or set an alert — it proposes the action and waits for your
              approval before anything happens. It needs your own API key for an AI provider (Claude or GPT).
            </p>
            <p className="small muted">{privacyNote(status)}</p>
            <button type="button" className="btn btn-primary btn-tiny" onClick={() => setKeyDialog(true)}>
              <KeyRound size={13} />
              Add an API key
            </button>
          </div>
        )}
        {configured && (
          <>
            <div className="ai-panel-conversation">
              {conversation.length === 0 && (
                <p className="small muted">
                  Try “Add BTCUSDT to my watchlist”, “Switch to the 1 hour chart”, or “Alert me if this crosses 100”.
                </p>
              )}
              {conversation.map((e, ei) => (
                <div key={ei} className="study-ai-exchange">
                  <div className="study-ai-question">{e.question}</div>
                  {e.error ? (
                    <p className="study-problem small">{e.error}</p>
                  ) : (
                    <div className="study-ai-answer">
                      {e.reply && <p>{e.reply}</p>}
                      {e.actions.map((tracked, actionIndex) => (
                        <ActionCard
                          key={actionIndex}
                          tracked={tracked}
                          onApprove={() => void approve(ei, actionIndex)}
                          onReject={() => setActionState(ei, actionIndex, { state: 'rejected' })}
                        />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="study-ai-ask">
              <textarea
                className="python-input"
                rows={2}
                maxLength={2000}
                value={question}
                disabled={busy}
                placeholder="Ask the assistant to do something, or just ask a question…"
                onChange={(e) => setQuestion(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask();
                }}
              />
              <button type="button" className="btn btn-primary pine-btn" disabled={busy || !question.trim()} onClick={() => void ask()} title="Ask (Ctrl+Enter)">
                {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                {busy ? progressText(ai.progress) : 'Ask'}
              </button>
            </div>
          </>
        )}
      </div>
      {keyDialog && <AiProvidersDialog providers={status} onClose={() => setKeyDialog(false)} onChanged={reloadStatus} say={say} />}
    </aside>
  );
}
