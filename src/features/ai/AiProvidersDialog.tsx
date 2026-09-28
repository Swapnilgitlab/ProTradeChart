import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { confirmDelete } from '../../lib/dialogs';
import {
  aiDeleteKey,
  aiSetKey,
  errorMessage,
  listAiProviders,
  setPreference,
  type AiProviderId,
  type AiProviders,
  type AiProviderStatus,
} from '../../lib/ipc';

type Say = (text: string, kind: 'success' | 'error' | 'info') => void;

/** The UI preference naming which provider is used when more than one has a key (mirrors
 *  `ACTIVE_PROVIDER_PREF` in `ai_commands.rs`). */
export const PREF_AI_ACTIVE_PROVIDER = 'ai_active_provider';

/** Short, sentence-friendly names ("Ask X to…", "Explain with X"), and who a request actually
 *  goes to (for the privacy line) — distinct from `AiProviderStatus.label`, which is what the
 *  dialog's own rows show. */
const SHORT_NAME: Record<AiProviderId, string> = { anthropic: 'Claude', openai: 'GPT' };
const COMPANY: Record<AiProviderId, string> = { anthropic: 'Anthropic', openai: 'OpenAI' };

/** Every provider's status, refetched whenever the dialog changes something. `null` while loading. */
export function useAiProviders(): [AiProviders | null, () => void] {
  const [providers, setProviders] = useState<AiProviders | null>(null);
  const reload = useCallback(() => {
    listAiProviders()
      .then(setProviders)
      .catch(() => setProviders({ providers: [], active: null }));
  }, []);
  useEffect(reload, [reload]);
  return [providers, reload];
}

/** The provider an AI feature will actually use right now, in words — "Claude", "GPT", or a
 *  neutral fallback before any key is configured. */
export function activeProviderName(providers: AiProviders | null): string {
  return providers?.active ? SHORT_NAME[providers.active] : 'the AI';
}

/** Which provider actually answered, from the model name a reply carries (`reply.model`) — more
 *  reliable than the currently-active provider, which may have changed since. Falls back to a
 *  neutral name for a model string that names neither. */
export function providerNameFromModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'Claude';
  if (m.includes('gpt')) return 'GPT';
  return 'the AI';
}

/** What a request sends and to whom, naming whichever provider will actually receive it — a
 *  factual, provider-dependent statement, not just branding. */
export function privacyNote(providers: AiProviders | null): string {
  const company = providers?.active ? COMPANY[providers.active] : 'your chosen AI provider';
  return (
    'Your question, the Study Specification and, when you ask for an explanation, a summary of the result (counts, medians and tests — not the ' +
    `events or prices) are sent to ${company} under your account, and each request is billed to it.`
  );
}

function ProviderRow({ status, onChanged, say }: { status: AiProviderStatus; onChanged: () => void; say: Say }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await aiSetKey(status.id, key);
      setKey('');
      onChanged();
      say(
        next.storage === 'database'
          ? `Key saved in the app’s database: no OS keychain was available.`
          : `${status.label} API key saved.`,
        'success',
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDelete(`Remove the ${status.label} API key from this computer?`))) return;
    try {
      await aiDeleteKey(status.id);
      onChanged();
      say(`${status.label} API key removed.`, 'info');
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <div className="ai-provider-row">
      <div className="ai-provider-row-head">
        <strong>{status.label}</strong>
        {status.configured && <span className="small muted">saved{status.storage === 'database' ? ' — unencrypted, no OS keychain' : ''}</span>}
      </div>
      <div className="ai-key-row">
        <input
          type="password"
          value={key}
          placeholder={status.configured ? '•••••••• saved — paste to replace' : status.id === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKey(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && key.trim() && !busy && void save()}
        />
        <button type="button" className="btn btn-primary btn-tiny" disabled={busy || !key.trim()} onClick={() => void save()}>
          {busy ? 'Checking…' : 'Save'}
        </button>
        {status.configured && (
          <button type="button" className="btn btn-tiny" disabled={busy} onClick={() => void remove()}>
            Remove
          </button>
        )}
      </div>
      {error && <p className="study-problem small">{error}</p>}
    </div>
  );
}

/** Paste, replace or remove either provider's API key. A key goes to Rust, which checks it with
 *  the provider and keeps it in the OS keychain; it never comes back here. Opened from the right
 *  rail and from inside Studies — one dialog, so a key added in either place shows up in both. */
export function AiProvidersDialog({ providers, onClose, onChanged, say }: { providers: AiProviders | null; onClose: () => void; onChanged: () => void; say: Say }) {
  const configuredCount = providers?.providers.filter((p) => p.configured).length ?? 0;

  const choose = async (id: AiProviderId) => {
    await setPreference(PREF_AI_ACTIVE_PROVIDER, id);
    onChanged();
  };

  return (
    <Dialog title="AI providers" onClose={onClose}>
      <p className="small">
        The Study Builder and Ask AI use one of these, with your own API key — nothing here is bundled or shared with other users. Create a key at{' '}
        console.anthropic.com or platform.openai.com. It is checked with the provider, then kept in your operating system’s keychain; the app never
        shows it again.
      </p>
      <p className="small muted">{privacyNote(providers)}</p>
      {providers?.providers.map((status) => <ProviderRow key={status.id} status={status} onChanged={onChanged} say={say} />)}
      {configuredCount > 1 && providers && (
        <div className="field">
          <label htmlFor="ai-active-provider">Use for AI features</label>
          <select id="ai-active-provider" value={providers.active ?? ''} onChange={(e) => void choose(e.currentTarget.value as AiProviderId)}>
            {providers.providers
              .filter((p) => p.configured)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
          </select>
        </div>
      )}
    </Dialog>
  );
}
