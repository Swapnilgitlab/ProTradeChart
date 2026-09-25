import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { effectiveDefaultProvider, isProviderUsable } from '../../data/providerStatus';
import { fetchQuotes, quoteRefreshMs, type QuoteView } from '../../data/quotes';
import { confirmDelete } from '../../lib/dialogs';
import { formatPercent, formatPrice } from '../../lib/format';
import {
  addWatchlistItems,
  createWatchlist,
  deleteWatchlist,
  errorMessage,
  getPreference,
  getSymbolNames,
  getWatchlist,
  listWatchlists,
  removeWatchlistItems,
  renameWatchlist,
  setPreference,
  type WatchlistDetail,
  type WatchlistItem,
  type WatchlistSummary,
} from '../../lib/ipc';
import { mergeQuotes, quoteTargets, rowWindow, SMALL_LIST } from '../../lib/listWindow';
import { displayTicker } from '../../lib/symbols';
import { parseWatchlistFile } from '../../lib/watchlistImport';
import { useProviderState } from '../providers/useProviderState';
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
/** Rows rendered beyond the visible ones, so a short scroll never shows a gap. */
const OVERSCAN_ROWS = 8;
/** A row's height until the first one is measured. */
const DEFAULT_ROW_HEIGHT = 35;
/** While a price sort needs every row priced, each refresh also quotes this many more (three requests). */
const FULL_LIST_CHUNK = 60;
/** How long the list must sit still after a scroll before its new rows are fetched. */
const SCROLL_SETTLE_MS = 250;
/** Keeps a row with no name yet as tall as the others, which the windowing relies on. */
const NO_NAME = '\u00a0';

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
  const listRef = useRef<HTMLDivElement>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  /** What the quote refresher reads at the moment it runs, rather than when it was set up. */
  const quoteView = useRef({ all: [] as string[], visible: [] as string[], needsAll: false, known: new Map<string, QuoteView>() });
  const refreshVisible = useRef<() => void>(() => {});
  // Switching a data source on or off re-prices the list straight away.
  const { providers } = useProviderState();
  const usableProviders = providers
    .filter((p) => p.enabled && p.configured)
    .map((p) => p.id)
    .join(',');

  useDismiss(switcherRef, switcherOpen, () => setSwitcherOpen(false));
  useDismiss(moreRef, moreOpen, () => setMoreOpen(false));

  const fail = useCallback((err: unknown) => setError(errorMessage(err)), []);

  const selectWatchlist = useCallback(
    async (id: number) => {
      setActiveId(id);
      setSwitcherOpen(false);
      setError(null);
      if (listRef.current) listRef.current.scrollTop = 0;
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

  const symbolsKey = detail?.items.map((i) => i.symbol).join('|') ?? '';
  const sortedItems = useMemo(() => sortItems(detail?.items ?? [], quotes, sortKey, sortDir), [detail, quotes, sortKey, sortDir]);

  // Only the rows on screen are rendered: a 1,000-row list costs what a screenful does.
  const win = rowWindow(viewport.top, viewport.height || 600, rowHeight, sortedItems.length, OVERSCAN_ROWS);
  const windowSymbols = useMemo(
    () => sortedItems.slice(win.start, win.end).map((i) => i.symbol),
    [sortedItems, win.start, win.end],
  );
  const visibleKey = windowSymbols.join('|');
  const priceSort = sortKey === 'last' || sortKey === 'chg';
  const needsAll = priceSort && sortedItems.length > SMALL_LIST;
  useEffect(() => {
    quoteView.current = { all: sortedItems.map((i) => i.symbol), visible: windowSymbols, needsAll, known: quotes };
  });

  // Follow the list's scroll position and size.
  const hasDetail = detail != null;
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () =>
      setViewport((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
    update();
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      resize.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [collapsed, hasDetail]);

  // Rows are one fixed height (both text lines are single-line), measured once
  // rendered so the spacers above and below the visible rows are exact.
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.watchlist-row');
    const height = row?.getBoundingClientRect().height;
    if (height && Math.abs(height - rowHeight) > 0.5) setRowHeight(height);
  });

  // Prices, for the rows on screen: on load, every 20s, when the window regains
  // focus after a short while, and for rows scrolled into view. Skipped while the
  // window is hidden. A long list isn't quoted whole — that would spend a data source's
  // request limits and starve the charts — except while sorted by price.
  useEffect(() => {
    if (collapsed || !symbolsKey) return;
    let cancelled = false;
    let inFlight = false;
    let queued: 'tick' | 'scroll' | null = null;
    let cursor = 0;
    let lastRefresh = 0;
    const run = async (reason: 'tick' | 'scroll') => {
      if (cancelled || document.visibilityState !== 'visible') return;
      if (inFlight) {
        if (queued !== 'tick') queued = reason;
        return;
      }
      const { all, visible, needsAll: walkAll, known } = quoteView.current;
      let target: string[];
      if (reason === 'tick') {
        const planned = quoteTargets(all, visible, walkAll, cursor, FULL_LIST_CHUNK);
        cursor = planned.next;
        target = planned.symbols;
        lastRefresh = Date.now();
      } else {
        // Only rows that have never been priced: a price sort reshuffles the rows
        // on every refresh, and re-quoting whatever lands on screen would never stop.
        target = visible.filter((s) => !known.has(s));
      }
      if (target.length === 0) return;
      inFlight = true;
      try {
        const fresh = await fetchQuotes(target);
        if (!cancelled) setQuotes((prev) => mergeQuotes(prev, fresh));
      } finally {
        inFlight = false;
        const next = queued;
        queued = null;
        if (next && !cancelled) void run(next);
      }
    };
    refreshVisible.current = () => void run('scroll');
    const tick = () => void run('tick');
    const refreshOnFocus = () => {
      if (Date.now() - lastRefresh >= FOCUS_REFRESH_MIN_GAP_MS) tick();
    };
    tick();
    // Paced by roughly what one refresh quotes: the whole of a short list, a screenful of a long one.
    const timer = window.setInterval(tick, quoteRefreshMs(quoteView.current.all.slice(0, SMALL_LIST)));
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      cancelled = true;
      refreshVisible.current = () => {};
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [symbolsKey, collapsed, usableProviders]);

  useEffect(() => {
    if (!visibleKey) return;
    const timer = window.setTimeout(() => refreshVisible.current(), SCROLL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [visibleKey]);

  // Company names, where the local database has them (the brokers' instrument lists do).
  useEffect(() => {
    if (!symbolsKey) return;
    let cancelled = false;
    getSymbolNames(symbolsKey.split('|'))
      .then((found) => {
        if (!cancelled) setNames((prev) => withNames(prev, found));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [symbolsKey]);

  // Keep the chosen row in view when it changes from the keyboard or a chart.
  useEffect(() => {
    const el = listRef.current;
    const index = sortedItems.findIndex((i) => i.symbol === activeSymbol);
    if (!el || index < 0) return;
    const top = index * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    // Only when the choice changes: re-sorting shouldn't yank the list around.
  }, [activeSymbol]);

  const pricedCount = useMemo(
    () => (needsAll ? sortedItems.filter((i) => quotes.get(i.symbol)?.price != null).length : 0),
    [needsAll, sortedItems, quotes],
  );


  // Arrow keys scrub through the list and load each symbol as you go. Ignored
  // while typing in a field so it never fights the search box or a name input.
  useEffect(() => {
    if (collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || sortedItems.length === 0) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      // Vela's own keyboard handling owns arrows while a chart has focus.
      if (el?.closest('.single-chart-canvas')) return;
      e.preventDefault();
      const idx = sortedItems.findIndex((i) => i.symbol === activeSymbol);
      const next = e.key === 'ArrowUp' ? sortedItems[Math.max(0, idx - 1)] : sortedItems[Math.min(sortedItems.length - 1, idx + 1)];
      if (next && next.symbol !== activeSymbol) onSelectSymbol(next.symbol);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, sortedItems, activeSymbol, onSelectSymbol]);

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


  // Rows are memoised, so they get callbacks that never change identity.
  const latest = useRef({ onSelectSymbol, handleRemove });
  latest.current = { onSelectSymbol, handleRemove };
  const selectRow = useCallback((symbol: string) => latest.current.onSelectSymbol(symbol), []);
  const removeRow = useCallback((symbol: string) => void latest.current.handleRemove(symbol), []);

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = ''; // allow re-picking the same file
    if (!file) return;
    try {
      // NSE and BSE symbols in the file go to the user's own broker: the default provider if it is one,
      // otherwise whichever is set up. With no broker they can't be charted and are reported as skipped.
      const preferred = effectiveDefaultProvider();
      const indianProvider =
        preferred === 'dhan' || preferred === 'zerodha'
          ? preferred
          : (['dhan', 'zerodha'] as const).find((id) => isProviderUsable(id));
      const { items, skipped } = parseWatchlistFile(await file.text(), { indianProvider, defaultProvider: preferred });
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
          {needsAll && pricedCount < sortedItems.length && (
            <p className="watchlist-note muted small">
              Sorting by the prices loaded so far: {pricedCount} of {sortedItems.length}.
            </p>
          )}

          <div className="watchlist-items" ref={listRef}>
            {sortedItems.length === 0 ? (
              <p className="muted small" style={{ padding: 12 }}>No symbols yet — search above to add one.</p>
            ) : (
              <>
                <div style={{ height: win.start * rowHeight }} aria-hidden="true" />
                {sortedItems.slice(win.start, win.end).map((item) => (
                  <WatchlistRow
                    key={item.symbol}
                    symbol={item.symbol}
                    name={item.name ?? names.get(item.symbol) ?? null}
                    quote={quotes.get(item.symbol)}
                    selected={item.symbol === activeSymbol}
                    onSelect={selectRow}
                    onRemove={removeRow}
                  />
                ))}
                <div style={{ height: (sortedItems.length - win.end) * rowHeight }} aria-hidden="true" />
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function withNames(prev: Map<string, string>, found: Record<string, string>): Map<string, string> {
  const fresh = Object.entries(found).filter(([symbol, name]) => prev.get(symbol) !== name);
  return fresh.length ? new Map([...prev, ...fresh]) : prev;
}

interface RowProps {
  symbol: string;
  name: string | null;
  quote: QuoteView | undefined;
  selected: boolean;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

/** One watchlist row: the ticker, the company name beneath it, price and change.
 *  Memoised, so a refresh re-renders only the rows whose price moved. */
const WatchlistRow = memo(function WatchlistRow({ symbol, name, quote, selected, onSelect, onRemove }: RowProps) {
  const change = quote?.changePercent ?? null;
  const ticker = displayTicker(symbol);
  return (
    <div
      className={`watchlist-row${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      title={name ? `${ticker} — ${name}` : ticker}
      onClick={() => onSelect(symbol)}
      onKeyDown={(e) => e.key === 'Enter' && onSelect(symbol)}
    >
      <div className="watchlist-symbol">
        <span className="ticker">{ticker}</span>
        <span className="sub">{name ?? NO_NAME}</span>
      </div>
      <span className="watchlist-num">{formatPrice(quote?.price)}</span>
      <span className={`watchlist-num ${change == null ? 'muted' : change < 0 ? 'neg' : 'pos'}`}>{formatPercent(change)}</span>
      <button
        type="button"
        className="icon-button watchlist-remove"
        aria-label={`Remove ${ticker}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(symbol);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
});
