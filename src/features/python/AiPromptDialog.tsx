import { Copy } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { Dialog } from '../../components/Dialog';

/** "Copy a prompt": `protrade`'s reference and a description of the user's setup, as a block of text for an
 *  outside AI (ChatGPT, Claude.ai, …) that has never seen this app — the same context the in-app assistant
 *  sends. Nothing here is sent anywhere by the app itself: it leaves the machine only if the user pastes it
 *  somewhere themselves, same as anything else they'd copy out of an editor.
 *
 *  Uses the app-wide toast, not the Python tab's own console (console output is for a script's own run, not
 *  for an incidental UI action like this). */
export function AiPromptDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Prompt copied — paste it into ChatGPT, Claude.ai or any AI before asking it for a script.', 'success');
    } catch {
      toast('Couldn’t copy automatically — select the text below and copy it by hand.', 'error');
    }
  };

  return (
    <Dialog
      title="A prompt for an outside AI"
      onClose={onClose}
      wide
      footer={
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          <Copy size={14} />
          Copy
        </button>
      }
    >
      <p className="small muted">
        A general-purpose AI doesn’t know this app’s Python package — left alone, it’ll guess at <code>yfinance</code> or an API key of its own. This
        is the reference and the description of your setup the built-in assistant uses (names of your watchlists, layouts and scripts, not what’s in
        them). Paste it into one first, then ask it to write or fix your script.
      </p>
      <textarea className="python-input ai-prompt-text" readOnly rows={18} value={text} onFocus={(e) => e.currentTarget.select()} />
    </Dialog>
  );
}
