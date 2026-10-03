import { useMemo, useState } from 'react';
import { LineChart, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import { confirmDelete } from '../../lib/dialogs';
import { createIndicesWatchlist, createWatchlist, deleteWatchlist, errorMessage, renameWatchlist, type WatchlistSummary } from '../../lib/ipc';
import { MAX_QUICK_LISTS } from '../../lib/quickLists';
import { useProviderState } from '../providers/useProviderState';
import { toggleQuickListPin, useQuickLists } from './quickLists';

interface Props {
  lists: readonly WatchlistSummary[];
  activeId: number | null;
  /** Shows a list in the panel (and closes the dialog). */
  onOpen: (id: number) => void;
  /** The lists changed here: made, renamed or deleted. */
  onChanged: () => Promise<void>;
  onClose: () => void;
  say: (text: string, kind: 'success' | 'error' | 'info') => void;
}

/** Every watchlist in one place: find one, open it, pin it for quick access, rename or delete it,
 *  make a new one, or make the Indices list from a broker's instrument list. */
export function WatchlistBrowserDialog({ lists, activeId, onOpen, onChanged, onClose, say }: Props) {
  const pins = useQuickLists();
  const { providers } = useProviderState();
  const brokers = providers.filter((p) => p.id === 'zerodha' && p.enabled && p.configured).map(() => 'zerodha' as const);
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...lists].filter((l) => !q || l.name.toLowerCase().includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  }, [lists, query]);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    try {
      await what();
      await onChanged();
    } catch (err) {
      say(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pin = (list: WatchlistSummary) => {
    if (!toggleQuickListPin(list.id)) say(`Up to ${MAX_QUICK_LISTS} watchlists can have quick access. Unpin one first.`, 'info');
  };

  const remove = async (list: WatchlistSummary) => {
    if (!(await confirmDelete(`Delete the watchlist "${list.name}" and all its symbols?`))) return;
    await run(() => deleteWatchlist(list.id));
  };

  const rename = () => {
    const target = renaming;
    const name = target?.name.trim();
    if (!target || !name) return;
    void run(async () => {
      await renameWatchlist(target.id, name);
      setRenaming(null);
    });
  };

  const create = () => {
    const name = newName?.trim();
    if (!name) return;
    void run(async () => {
      const made = await createWatchlist(name);
      setNewName(null);
      onOpen(made.id);
    });
  };

  const createIndices = (provider: 'zerodha') =>
    void run(async () => {
      const made = await createIndicesWatchlist(provider);
      say(`Made “${made.name}”: ${made.items.length} indices in ${made.sections.length} sections.`, 'success');
      onOpen(made.id);
    });

  return (
    <Dialog
      title="Watchlists"
      onClose={onClose}
      wide
      footer={
        <>
          {newName === null ? (
            <button type="button" className="btn" onClick={() => setNewName('')} disabled={busy}>
              <Plus size={14} />
              New watchlist
            </button>
          ) : (
            <span className="wl-browser-new">
              <input
                className="python-input"
                autoFocus
                value={newName}
                placeholder="Name, then Enter"
                aria-label="New watchlist name"
                onChange={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setNewName(null);
                  }
                }}
              />
              <button type="button" className="btn btn-primary" onClick={create} disabled={busy || !newName.trim()}>
                Create
              </button>
            </span>
          )}
          {brokers.map((b) => (
            <button
              key={b}
              type="button"
              className="btn"
              onClick={() => createIndices(b)}
              disabled={busy}
              title="The broad market, sector and thematic indices, grouped in sections, from your broker's instrument list"
            >
              <LineChart size={14} />
              Create Indices watchlist
            </button>
          ))}
          <div className="grow" />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <input
        className="python-input wl-browser-search"
        value={query}
        placeholder="Search watchlists"
        aria-label="Search watchlists"
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <p className="muted small wl-browser-hint">
        Star up to {MAX_QUICK_LISTS} watchlists for quick access: they appear at the top of the watchlist panel, and first in a chart’s right-click “Add to watchlist” list.
        {brokers.length === 0 && ' Connect Zerodha (Data providers) to make an Indices watchlist.'}
      </p>
      <ul className="wl-browser-list">
        {shown.length === 0 && <li className="muted small">{lists.length === 0 ? 'No watchlists yet.' : `No watchlist matches “${query.trim()}”.`}</li>}
        {shown.map((l) => {
          const pinned = pins.includes(l.id);
          return (
            <li key={l.id} className={`wl-browser-row${l.id === activeId ? ' active' : ''}`}>
              <button
                type="button"
                className={`icon-button wl-browser-star${pinned ? ' on' : ''}`}
                aria-pressed={pinned}
                aria-label={pinned ? `Remove ${l.name} from quick access` : `Add ${l.name} to quick access`}
                title={pinned ? 'Remove from quick access' : 'Add to quick access'}
                onClick={() => pin(l)}
              >
                <Star size={14} fill={pinned ? 'currentColor' : 'none'} />
              </button>
              {renaming?.id === l.id ? (
                <input
                  className="python-input grow"
                  autoFocus
                  value={renaming.name}
                  aria-label="New name"
                  onChange={(e) => setRenaming({ id: l.id, name: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') rename();
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setRenaming(null);
                    }
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <button type="button" className="wl-browser-name grow" onClick={() => onOpen(l.id)} title="Show this watchlist">
                  {l.name}
                </button>
              )}
              <span className="muted small wl-browser-count">
                {l.itemCount} symbol{l.itemCount === 1 ? '' : 's'}
              </span>
              <button type="button" className="icon-button" aria-label={`Rename ${l.name}`} title="Rename" onClick={() => setRenaming({ id: l.id, name: l.name })}>
                <Pencil size={13} />
              </button>
              <button type="button" className="icon-button" aria-label={`Delete ${l.name}`} title="Delete" onClick={() => void remove(l)} disabled={busy}>
                <Trash2 size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
