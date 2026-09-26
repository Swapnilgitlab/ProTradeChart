import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, FlaskConical, GitCompare, Trash2, X } from 'lucide-react';
import { confirmDelete } from '../../lib/dialogs';
import {
  deleteNotebook,
  errorMessage,
  getNotebook,
  removeNotebookItem,
  saveNotebook,
  setNotebookItemNote,
  setNotebookOrder,
  type NotebookDetail,
  type NotebookItem,
} from '../../lib/ipc';

interface Props {
  notebookId: string;
  onOpenStudy: (id: string) => void;
  onOpenResult: (id: string) => void;
  onCompareResult: (id: string) => void;
  /** The notebook's name or entries changed (the sidebar lists them). */
  onChanged: () => void;
  onDeleted: () => void;
  onClose: () => void;
  say: (text: string, kind: 'error' | 'success' | 'info') => void;
}

/** A Research Notebook: a named collection of Studies and results with the user's notes, in the
 *  order they chose. Notes are plain text and drawn as text. */
export function NotebookView({ notebookId, onOpenStudy, onOpenResult, onCompareResult, onChanged, onDeleted, onClose, say }: Props) {
  const [notebook, setNotebook] = useState<NotebookDetail | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [itemNotes, setItemNotes] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const nb = await getNotebook(notebookId);
      setNotebook(nb);
      if (nb) {
        setName(nb.name);
        setNotes(nb.notes);
        setItemNotes(Object.fromEntries(nb.items.map((i) => [i.id, i.note])));
      }
    } catch (err) {
      say(errorMessage(err), 'error');
    }
  }, [notebookId, say]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!notebook) return <div className="study-empty muted small">Opening the notebook…</div>;

  const saveHeader = async () => {
    if (name === notebook.name && notes === notebook.notes) return;
    if (!name.trim()) {
      setName(notebook.name);
      return;
    }
    try {
      await saveNotebook(notebook.id, name, notes);
      setNotebook({ ...notebook, name: name.trim(), notes });
      onChanged();
    } catch (err) {
      say(errorMessage(err), 'error');
    }
  };

  const saveItemNote = async (item: NotebookItem) => {
    const note = itemNotes[item.id] ?? '';
    if (note === item.note) return;
    try {
      await setNotebookItemNote(item.id, note);
      await load();
    } catch (err) {
      say(errorMessage(err), 'error');
    }
  };

  const move = async (index: number, by: number) => {
    const ids = notebook.items.map((i) => i.id);
    const j = index + by;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    try {
      await setNotebookOrder(notebook.id, ids);
      await load();
    } catch (err) {
      say(errorMessage(err), 'error');
    }
  };

  const remove = async (item: NotebookItem) => {
    try {
      await removeNotebookItem(item.id);
      await load();
      onChanged();
    } catch (err) {
      say(errorMessage(err), 'error');
    }
  };

  const removeNotebook = async () => {
    if (!(await confirmDelete(`Delete the notebook “${notebook.name}”? Its Studies and results stay where they are.`))) return;
    try {
      await deleteNotebook(notebook.id);
      onDeleted();
    } catch (err) {
      say(errorMessage(err), 'error');
    }
  };

  return (
    <div className="study-results">
      <header className="study-block-head">
        <BookOpen size={16} aria-hidden="true" />
        <input
          className="python-input study-notebook-name"
          value={name}
          aria-label="Notebook name"
          onChange={(e) => setName(e.currentTarget.value)}
          onBlur={() => void saveHeader()}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        />
        <div className="pine-toolbar-spacer" />
        <button type="button" className="btn btn-tiny" onClick={() => void removeNotebook()}>
          <Trash2 size={13} />
          Delete notebook
        </button>
        <button type="button" className="icon-button" aria-label="Close the notebook" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      <section className="study-block">
        <h3>Notes</h3>
        <textarea
          className="python-input study-textarea study-notebook-notes"
          rows={5}
          value={notes}
          placeholder="What is this research about? What have you found so far?"
          onChange={(e) => setNotes(e.currentTarget.value)}
          onBlur={() => void saveHeader()}
        />
      </section>

      <section className="study-block">
        <h3>Studies and results</h3>
        {notebook.items.length === 0 && (
          <p className="muted small">Nothing here yet. Open a Study or a result and choose Add to notebook.</p>
        )}
        <ol className="study-notebook-items">
          {notebook.items.map((item, i) => {
            const gone = item.title === null;
            return (
              <li key={item.id} className="study-notebook-item">
                <div className="study-notebook-item-head">
                  {item.kind === 'study' ? <FlaskConical size={14} aria-hidden="true" /> : <BookOpen size={14} aria-hidden="true" />}
                  <div className="study-notebook-item-title">
                    <strong>{gone ? 'No longer available' : item.title}</strong>
                    <span className="muted small">
                      {item.kind === 'study' ? 'Study' : 'Result'}
                      {item.detail ? ` · ${item.detail.replace('T', ' ').slice(0, 16)}` : ''}
                    </span>
                  </div>
                  {!gone && (
                    <button
                      type="button"
                      className="btn btn-tiny"
                      onClick={() => (item.kind === 'study' ? onOpenStudy(item.refId) : onOpenResult(item.refId))}
                    >
                      Open
                    </button>
                  )}
                  {!gone && item.kind === 'result' && (
                    <button type="button" className="icon-button" title="Compare with another result" aria-label="Compare with another result" onClick={() => onCompareResult(item.refId)}>
                      <GitCompare size={13} />
                    </button>
                  )}
                  <button type="button" className="icon-button" aria-label="Move up" title="Move up" disabled={i === 0} onClick={() => void move(i, -1)}>
                    <ArrowUp size={13} />
                  </button>
                  <button type="button" className="icon-button" aria-label="Move down" title="Move down" disabled={i === notebook.items.length - 1} onClick={() => void move(i, 1)}>
                    <ArrowDown size={13} />
                  </button>
                  <button type="button" className="icon-button" aria-label="Remove from the notebook" title="Remove from the notebook" onClick={() => void remove(item)}>
                    <X size={13} />
                  </button>
                </div>
                <textarea
                  className="python-input study-textarea"
                  rows={2}
                  value={itemNotes[item.id] ?? ''}
                  placeholder="A note on this one"
                  aria-label="Note"
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setItemNotes((n) => ({ ...n, [item.id]: value }));
                  }}
                  onBlur={() => void saveItemNote(item)}
                />
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
