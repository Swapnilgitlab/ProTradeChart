import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { addWatchlistItems, createWatchlist, errorMessage, listWatchlists, type WatchlistSummary } from '../../lib/ipc';
import { displayTicker } from '../../lib/symbols';
import { notifyWatchlistsChanged } from '../watchlist/watchlistBus';

interface Props {
  symbols: readonly string[];
  onClose: () => void;
  /** Says how it went, in the console the person is already watching. */
  say: (level: 'info' | 'error', text: string) => void;
  /** What a new list is called unless the person changes it. */
  newListName?: string;
  /** Open on "a new list" rather than the first existing one. */
  startWithNewList?: boolean;
}

const NEW_LIST = 'new';

/** Puts symbols on a watchlist: an existing one, or a new one. Used for a screen's or a Study's
 *  results, and for a chart's symbol from its right-click menu. */
export function AddToWatchlistDialog({ symbols, onClose, say, newListName = 'Screen results', startWithNewList = false }: Props) {
  const [lists, setLists] = useState<WatchlistSummary[] | null>(null);
  const [choice, setChoice] = useState<string>(NEW_LIST);
  const [name, setName] = useState(newListName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listWatchlists()
      .then((found) => {
        setLists(found);
        if (found.length > 0 && !startWithNewList) setChoice(String(found[0].id));
      })
      .catch((err) => {
        setLists([]);
        say('error', errorMessage(err));
      });
  }, [say, startWithNewList]);

  const add = async () => {
    setBusy(true);
    try {
      const items = symbols.map((symbol) => ({ symbol, name: null }));
      const target = choice === NEW_LIST ? await createWatchlist(name.trim() || newListName) : { id: Number(choice) };
      const updated = await addWatchlistItems(target.id, items);
      notifyWatchlistsChanged();
      const added = updated.added ?? items.length;
      const already = items.length - added;
      say('info', `Added ${added} of ${items.length} to “${updated.name}”${already > 0 ? ` (${already} already there)` : ''}.`);
      onClose();
    } catch (err) {
      say('error', errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={symbols.length === 1 ? `Add ${displayTicker(symbols[0])} to a watchlist` : `Add ${symbols.length} symbols to a watchlist`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || lists === null} onClick={() => void add()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    >
      {lists === null ? (
        <p className="muted small">Loading your watchlists…</p>
      ) : (
        <div className="python-watchlist-choice">
          <label className="small" htmlFor="python-watchlist-list">
            Which list
          </label>
          <select
            id="python-watchlist-list"
            className="python-input"
            value={choice}
            onChange={(e) => setChoice(e.currentTarget.value)}
            autoFocus
          >
            {lists.map((list) => (
              <option key={list.id} value={String(list.id)}>
                {list.name} ({list.itemCount})
              </option>
            ))}
            <option value={NEW_LIST}>A new list…</option>
          </select>
          {choice === NEW_LIST && (
            <input
              className="python-input"
              value={name}
              aria-label="New watchlist name"
              placeholder="Name for the new list"
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void add();
              }}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}
