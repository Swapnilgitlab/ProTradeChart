import { useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { confirmReplace } from '../../lib/dialogs';
import { errorMessage, exportStudyFile, listPythonScripts, savePythonScript } from '../../lib/ipc';
import { generatePython, scriptName } from '../../studies/codegen';
import type { StudySpec } from '../../studies/spec';
import { CodeEditor } from '../pine/CodeEditor';
import { pythonExtensions } from '../python/pythonLanguage';

interface Props {
  spec: StudySpec;
  onClose: () => void;
  /** Shows the Python tab, where the saved script can be run. */
  onOpenPython: () => void;
  say: (kind: 'success' | 'error' | 'info', text: string) => void;
}

/** "Generate Python": the Study as a script to read and change. Saved to the scripts folder or
 *  exported only when asked, and never run from here. */
export function PythonDialog({ spec, onClose, onOpenPython, say }: Props) {
  const [code, setCode] = useState(() => generatePython(spec));
  const [busy, setBusy] = useState(false);
  const name = scriptName(spec);

  const saveToScripts = async () => {
    setBusy(true);
    try {
      const existing = await listPythonScripts();
      if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase()) && !(await confirmReplace(`Replace ${name} in your Python scripts?`))) return;
      await savePythonScript(name, code);
      say('success', `Saved ${name} to your Python scripts.`);
      onClose();
      onOpenPython();
    } catch (err) {
      say('error', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Generated Python"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" disabled={busy} onClick={() => exportStudyFile(name.replace(/\.py$/, ''), 'py', code).catch((err) => say('error', errorMessage(err)))}>
            Export .py
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveToScripts()}>
            Save to Python scripts
          </button>
        </>
      }
    >
      <p className="muted small">
        The Study Specification stays the source of truth; this is one way to run it, one step at a time. Change it as you like — it runs
        only when you press Run in the Python tab.
      </p>
      <div className="study-code">
        <CodeEditor value={code} onChange={setCode} onSave={() => void saveToScripts()} onRun={() => {}} language={pythonExtensions} placeholderText="" />
      </div>
    </Dialog>
  );
}
