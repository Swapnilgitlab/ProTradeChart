import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  FileUp,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useDismiss } from '../../components/useDismiss';
import { useToast } from '../../components/Toasts';
import { effectiveDefaultProvider } from '../../data/providerStatus';
import { fetchQuotes, quoteRefreshMs, type QuoteView } from '../../data/quotes';
import { confirmDelete } from '../../lib/dialogs';
import { formatPercent, formatPrice } from '../../lib/format';
import {
  addWatchlistItems,
  createWatchlist,
  deleteWatchlist,
  errorMessage,
  getPreference,
  getWatchlist,
  listWatchlists,
  removeWatchlistItems,
  renameWatchlist,
  setPreference,
  type WatchlistDetail,
  type WatchlistItem,
  type WatchlistSummary,
} from '../../lib/ipc';
import { displayTicker, providerLabel, splitSymbol } from '../../lib/symbols';
import { parseWatchlistFile } from '../../lib/watchlistImport';
import { SymbolSearchBox, type PickedSymbol } from '../search/SymbolSearchBox';

interface Props {
  /** The active chart's symbol, highlighted in the list when present. */
  activeSymbol: string;
  onSelectSymbol: (symbol: string) => void;
}

type SortKey = 'symbol' | 'last' | 'chg';
type SortDir = 'asc' | 'desc';
type FormMode = 'create' | 'rename' | null;

/** Regaining window focus refreshes prices, but not if they were fetched this recently. */
const FOCUS_REFRESH_MIN_GAP_MS = 10_000;
const PREF_ACTIVE = 'watchlist_active';
const PREF_COLLAPSED = 'watchlist_collapsed';

function sortItems(items: WatchlistItem[], quotes: Map<string, QuoteView>, key: SortKey | null, dir: SortDir): WatchlistItem[] {
  if (!key) return items; // insertion order — the order the user built the list in
  const sign = dir === 'asc' ? 1 : -1;
  const value = (i: WatchlistItem) => (key === 'last' ? quotes.get(i.symbol)?.price : quotes.get(i.symbol)?.changePercent);
  return [...items].sort((a, b) => {
    if (key === 'symbol') return sign * displayTicker(a.symbol).localeCompare(displayTicker(b.symbol));
    // Symbols with no quote always sink to the bottom, whichever way it's sorted.
    const [va, vb] = [value(a), value(b)];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return sign * (va - vb);
  });
}

/** Watchlists, stored locally, with live-ish prices. Docks on the right of the
 *  chart: a switcher between lists, sortable columns, a search box to add
 *  symbols, and import from a TradingView-style export. */
export function WatchlistPanel({ activeSymbol, onSelectSymbol }: Props) {
  const toast = useToast();
  const [watchlists, setWatchlists] = useState<WatchlistSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<WatchlistDetail | null>(null);
  const [quotes, setQuotes] = useState<Map<string, QuoteView>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [formName, setFormName] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const switcherRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const quoteToken = useRef(0);

  useDismiss(switcherRef, switcherOpen, () => setSwitcherOpen(false));
  useDismiss(moreRef, moreOpen, () => setMoreOpen(false));

  const fail = useCallback((err: unknown) => setError(errorMessage(err)), []);

  const selectWatchlist = useCallback(
    async (id: number) => {
      setActiveId(id);
      setSwitcherOpen(false);
      setError(null);
      setPreference(PREF_ACTIVE, String(id)).catch(() => {});
      try {
        setDetail(await getWatchlist(id));
      } catch (err) {
        fail(err);
      }
    },
    [fail],
  );

  // Initial load: restore the last-used list and collapsed state.
  useEffect(() => {
    (async () => {
      try {
        const [lists, savedActive, savedCollapsed] = await Promise.all([
          listWatchlists(),
          getPreference(PREF_ACTIVE),
          getPreference(PREF_COLLAPSED),
        ]);
        setWatchlists(lists);
        setCollapsed(savedCollapsed === '1');
        const preferred = lists.find((l) => String(l.id) === savedActive) ?? lists[0];
        if (preferred) await selectWatchlist(preferred.id);
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectWatchlist, fail]);

  // Live prices for whatever's on screen: on load, every 30s (slower for long
  // lists of symbols that are quoted one request at a time), and when the
  // window regains focus after a short while. Skipped while the window is hidden.
  const symbolsKey = detail?.items.map((i) => i.symbol).join('|') ?? '';
  useEffect(() => {
    if (collapsed || !symbolsKey) {
      setQuotes(new Map());
      return;
    }
    const symbols = symbolsKey.split('|');
    let lastRefresh = 0;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      lastRefresh = Date.now();
      const token = ++quoteToken.current;
      const fresh = await fetchQuotes(symbols);
      if (token === quoteToken.current) setQuotes(fresh);
    };
    const refreshOnFocus = () => {
      if (Date.now() - lastRefresh >= FOCUS_REFRESH_MIN_GAP_MS) void refresh();
    };
    void refresh();
    const timer = window.setInterval(refresh, quoteRefreshMs(symbols));
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      quoteToken.current++;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [symbolsKey, collapsed]);

  const visibleItems = useMemo(
    () => sortItems(detail?.items ?? [], quotes, sortKey, sortDir),
    [detail, quotes, sortKey, sortDir],
  );

  // Arrow keys scrub through the list and load each symbol as you go. Ignored
  // while typing in a field so it never fights the search box or a name input.
  useEffect(() => {
    if (collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || visibleItems.length === 0) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      // Vela's own keyboard handling owns arrows while a chart has focus.
      if (el?.closest('.single-chart-canvas')) return;
      e.preventDefault();
      const idx = visibleItems.findIndex((i) => i.symbol === activeSymbol);
      const next = e.key === 'ArrowUp' ? visibleItems[Math.max(0, idx - 1)] : visibleItems[Math.min(visibleItems.length - 1, idx + 1)];
      if (next && next.symbol !== activeSymbol) onSelectSymbol(next.symbol);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, visibleItems, activeSymbol, onSelectSymbol]);

  function setCollapsedPersisted(value: boolean) {
    setCollapsed(value);
    setPreference(PREF_COLLAPSED, value ? '1' : '0').catch(() => {});
  }

  function cycleSort(key: SortKey) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir('asc');
    } else if (sortDir === 'asc') {
      setSortDir('desc');
    } else {
      setSortKey(null); // third click returns to the list's own order
    }
  }

  function upsertSummary(d: WatchlistDetail) {
    setWatchlists((prev) => {
      const summary = { id: d.id, name: d.name, createdAt: d.createdAt, itemCount: d.items.length };
      return prev.some((w) => w.id === d.id) ? prev.map((w) => (w.id === d.id ? summary : w)) : [...prev, summary];
    });
  }

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    const name = formName.trim();
    if (!name) return;
    try {
      if (formMode === 'create') {
        const created = await createWatchlist(name);
        upsertSummary(created);
        setActiveId(created.id);
        setDetail(created);
        setPreference(PREF_ACTIVE, String(created.id)).catch(() => {});
      } else if (formMode === 'rename' && detail) {
        await renameWatchlist(detail.id, name);
        setDetail({ ...detail, name });
        setWatchlists((prev) => prev.map((w) => (w.id === detail.id ? { ...w, name } : w)));
      }
      setFormMode(null);
      setFormName('');
      setError(null);
    } catch (err) {
      fail(err);
    }
  }

  async function handleDelete() {
    if (!detail) return;
    setMoreOpen(false);
    if (!(await confirmDelete(`Delete the watchlist "${detail.name}" and all its symbols?`))) return;
    try {
      await deleteWatchlist(detail.id);
      const remaining = watchlists.filter((w) => w.id !== detail.id);
      setWatchlists(remaining);
      if (remaining[0]) await selectWatchlist(remaining[0].id);
      else {
        setActiveId(null);
        setDetail(null);
      }
    } catch (err) {
      fail(err);
    }
  }

  async function handleAdd(picked: PickedSymbol) {
    if (activeId == null) return;
    try {
      const updated = await addWatchlistItems(activeId, [{ symbol: picked.symbol, name: picked.name ?? null }]);
      setDetail(updated);
      upsertSummary(updated);
      if (updated.added === 0) toast(`${displayTicker(picked.symbol)} is already in this list.`);
    } catch (err) {
      fail(err);
    }
  }

  async function handleRemove(symbol: string) {
    if (!detail) return;
    try {
      await removeWatchlistItems(detail.id, [symbol]);
      const next = { ...detail, items: detail.items.filter((i) => i.symbol !== symbol) };
      setDetail(next);
      upsertSummary(next);
    } catch (err) {
      fail(err);
    }
  }

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      // With a broker as the default provider, an NSE:RELIANCE in the file means that broker's RELIANCE.
      const preferred = effectiveDefaultProvider();
      const indianProvider = preferred === 'dhan' || preferred === 'zerodha' ? preferred : 'yahoo';
      const { items, skipped } = parseWatchlistFile(await file.text(), { indianProvider });
      if (items.length === 0) {
        toast('No symbols were found in that file.', 'error');
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'Imported watchlist';
      const created = await createWatchlist(name);
      const filled = await addWatchlistItems(created.id, items.map((i) => ({ symbol: i.symbol, name: i.name ?? null })));
      upsertSummary(filled);
      setActiveId(filled.id);
      setDetail(filled);
      setPreference(PREF_ACTIVE, String(filled.id)).catch(() => {});
      toast(
        `Imported ${filled.items.length} symbols into “${name}”${skipped.length ? ` (${skipped.length} couldn't be mapped)` : ''}.`,
        'success',
      );
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  if (collapsed) {
    return (
      <div className="watchlist-panel collapsed">
        <button type="button" className="icon-button" aria-label="Expand watchlist" title="Show watchlist" onClick={() => setCollapsedPersisted(false)}>
          <ChevronsLeft size={16} />
        </button>
      </div>
    );
  }

  const sortMark = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <aside className="watchlist-panel" aria-label="Watchlist">
      <div className="watchlist-header">
        <div className="menu-anchor" ref={switcherRef}>
          <button type="button" className="menu-trigger" onClick={() => setSwitcherOpen((v) => !v)} aria-haspopup="menu" aria-expanded={switcherOpen}>
            <span>{detail?.name ?? 'Watchlists'}</span>
            <ChevronDown size={14} />
          </button>
          {switcherOpen && (
            <div className="menu left" role="menu">
              {watchlists.map((w) => (
                <button key={w.id} type="button" role="menuitem" className={`menu-item${w.id === activeId ? ' active' : ''}`} onClick={() => selectWatchlist(w.id)}>
                  <span className="grow">{w.name}</span>
                  <span className="muted small">{w.itemCount}</span>
                </button>
              ))}
              {watchlists.length === 0 && <div className="menu-empty small">No watchlists yet.</div>}
            </div>
          )}
        </div>

        <div className="watchlist-header-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="New watchlist"
            title="New watchlist"
            onClick={() => {
              setFormMode('create');
              setFormName('');
            }}
          >
            <Plus size={15} />
          </button>
          <div className="menu-anchor" ref={moreRef}>
            <button type="button" className="icon-button" aria-label="Watchlist actions" title="More" onClick={() => setMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={moreOpen}>
              <MoreHorizontal size={15} />
            </button>
            {moreOpen && (
              <div className="menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMoreOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <FileUp size={14} />
                  <span className="grow">Import from file…</span>
                </button>
                {detail && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setMoreOpen(false);
                        setFormMode('rename');
                        setFormName(detail.name);
                      }}
                    >
                      <Pencil size={14} />
                      <span className="grow">Rename</span>
                    </button>
                    <div className="menu-divider" />
                    <button type="button" role="menuitem" className="menu-item danger" onClick={handleDelete}>
                      <Trash2 size={14} />
                      <span className="grow">Delete watchlist</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <button type="button" className="icon-button" aria-label="Collapse watchlist" title="Hide watchlist" onClick={() => setCollapsedPersisted(true)}>
            <ChevronsRight size={16} />
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFilePicked} />
        </div>
      </div>

      {formMode && (
        <form className="watchlist-toolbar" onSubmit={submitForm}>
          <input
            autoFocus
            type="text"
            style={{ width: '100%' }}
            value={formName}
            onChange={(e) => setFormName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFormMode(null)}
            placeholder={formMode === 'create' ? 'Watchlist name, then Enter' : 'New name, then Enter'}
          />
        </form>
      )}

      {loading && <p className="muted small" style={{ padding: 12 }}>Loading…</p>}
      {error && <p className="error-text small" style={{ padding: '8px 12px', margin: 0 }}>{error}</p>}

      {!loading && !detail && (
        <div className="panel-empty">
          <ListPlus size={22} />
          <span>Create a watchlist to keep the symbols you follow one click away.</span>
          <button type="button" className="btn btn-primary" onClick={() => setFormMode('create')}>
            <Plus size={14} /> New watchlist
          </button>
        </div>
      )}

      {detail && (
        <>
          <div className="watchlist-toolbar">
            <SymbolSearchBox block onSelect={handleAdd} placeholder="Add symbol…" />
          </div>

          <div className="watchlist-columns">
            <button type="button" className={`watchlist-column${sortKey === 'symbol' ? ' sorted' : ''}`} onClick={() => cycleSort('symbol')}>
              Symbol{sortMark('symbol')}
            </button>
            <button type="button" className={`watchlist-column${sortKey === 'last' ? ' sorted' : ''}`} onClick={() => cycleSort('last')}>
              Last{sortMark('last')}
            </button>
            <button type="button" className={`watchlist-column${sortKey === 'chg' ? ' sorted' : ''}`} onClick={() => cycleSort('chg')}>
              Chg%{sortMark('chg')}
            </button>
            <span />
          </div>

          <div className="watchlist-items">
            {visibleItems.length === 0 ? (
              <p className="muted small" style={{ padding: 12 }}>No symbols yet — search above to add one.</p>
            ) : (
              visibleItems.map((item) => {
                const q = quotes.get(item.symbol);
                const change = q?.changePercent ?? null;
                return (
                  <div
                    key={item.symbol}
                    className={`watchlist-row${item.symbol === activeSymbol ? ' selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSelectSymbol(item.symbol)}
                    onKeyDown={(e) => e.key === 'Enter' && onSelectSymbol(item.symbol)}
                  >
                    <div className="watchlist-symbol">
                      <span className="ticker">{displayTicker(item.symbol)}</span>
                      <span className="sub">{item.name ?? providerLabel(splitSymbol(item.symbol).provider)}</span>
                    </div>
                    <span className="watchlist-num">{formatPrice(q?.price)}</span>
                    <span className={`watchlist-num ${change == null ? 'muted' : change < 0 ? 'neg' : 'pos'}`}>{formatPercent(change)}</span>
                    <button
                      type="button"
                      className="icon-button watchlist-remove"
                      aria-label={`Remove ${displayTicker(item.symbol)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(item.symbol);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </aside>
  );
}
