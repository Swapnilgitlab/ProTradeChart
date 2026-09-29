import { useState } from 'react';
import { Copy } from 'lucide-react';
import { useToast } from '../../components/Toasts';
import { Dialog } from '../../components/Dialog';
import { pythonApiReference } from '../../python/reference';

/** "Copy an AI prompt": `protrade`'s API as a block of text for an outside LLM (ChatGPT, Claude.ai, …) that
 *  has never seen this app, so it writes real `pt.bars`/`pt.show` calls instead of guessing at a library it
 *  knows from training. Nothing here is sent anywhere by the app itself — it leaves the machine only if the
 *  user pastes it somewhere themselves, same as anything else they'd copy out of an editor.
 *
 *  Uses the app-wide toast, not the Python tab's own console `say` (console output is for a script's own
 *  run, not for an incidental UI action like this). */
export function AiPromptDialog({ onClose }: { onClose: () => void }) {
  const [text] = useState(pythonApiReference);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Prompt copied — paste it into ChatGPT, Claude.ai or any LLM before asking it for a script.', 'success');
    } catch {
      toast('Couldn’t copy automatically — select the text below and copy it by hand.', 'error');
    }
  };

  return (
    <Dialog
      title="AI prompt for writing scripts"
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
        A general-purpose AI doesn’t know this app’s Python package — left alone, it’ll guess at <code>yfinance</code> or
        an API key of its own. Paste this into one first, then ask it to write or fix your script.
      </p>
      <textarea
        className="python-input ai-prompt-text"
        readOnly
        rows={18}
        value={text}
        onFocus={(e) => e.currentTarget.select()}
      />
    </Dialog>
  );
}
