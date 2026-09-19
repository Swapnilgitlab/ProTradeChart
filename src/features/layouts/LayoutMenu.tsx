import { useRef, useState } from 'react';
import { ChevronDown, LayoutTemplate, Plus, Star, Trash2 } from 'lucide-react';
import { useDismiss } from '../../components/useDismiss';
import { confirmDelete } from '../../lib/dialogs';

export interface LayoutSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

interface Props {
  layouts: LayoutSummary[];
  currentLayoutId: string | null;
  onSelect: (id: string) => void;
  onSave: () => void;
  onSaveAsNew: (name: string) => void;
  onSetDefault: () => void;
  onDelete: (id: string) => void;
}

/** Save / switch / default the window's whole session (every open tab's symbol
 *  and Vela state) as a named "layout". This sits one level above Vela's own
 *  multi-chart grid: each tab here is its own single-chart workspace. */
export function LayoutMenu({ layouts, currentLayoutId, onSelect, onSave, onSaveAsNew, onSetDefault, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);

  const close = () => {
    setOpen(false);
    setCreating(false);
    setNewName('');
  };
  useDismiss(anchorRef, open, close);

  const current = layouts.find((l) => l.id === currentLayoutId);

  function submitNew(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    onSaveAsNew(name);
    close();
  }

  async function handleDelete(id: string, name: string) {
    if (!(await confirmDelete(`Delete the layout "${name}"?`))) return;
    onDelete(id);
  }

  return (
    <div className="menu-anchor" ref={anchorRef}>
      <button type="button" className="menu-trigger" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        <LayoutTemplate size={14} />
        <span>{current?.name ?? 'Unsaved layout'}</span>
        <ChevronDown size={14} />
      </button>

      {open && (
        <div className="menu" role="menu">
          {layouts.length === 0 && <div className="menu-empty small">No saved layouts yet.</div>}
          {layouts.map((l) => (
            <div key={l.id} className={`menu-row${l.id === currentLayoutId ? ' active' : ''}`}>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  onSelect(l.id);
                  close();
                }}
              >
                {l.isDefault && <Star size={12} className="default-star" aria-label="Default layout" />}
                <span className="grow">{l.name}</span>
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${l.name}`} onClick={() => handleDelete(l.id, l.name)}>
                <Trash2 size={13} />
              </button>
            </div>
          ))}

          <div className="menu-divider" />

          {current && (
            <>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  onSave();
                  close();
                }}
              >
                <span className="grow">Save “{current.name}”</span>
              </button>
              {!current.isDefault && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    onSetDefault();
                    close();
                  }}
                >
                  <span className="grow">Set as default</span>
                </button>
              )}
            </>
          )}

          {creating ? (
            <form className="inline-form" onSubmit={submitNew}>
              <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.currentTarget.value)} placeholder="Layout name, then Enter" />
            </form>
          ) : (
            <button type="button" role="menuitem" className="menu-item" onClick={() => setCreating(true)}>
              <Plus size={13} />
              <span className="grow">Save as new layout…</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
