import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowUpToLine,
  Bell,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileUp,
  Flag,
  LayoutList,
  ListPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  SeparatorHorizontal,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { openAlerts } from '../../alerts/ui';
import { ContextMenu } from '../../components/ContextMenu';
import { useDismiss } from '../../components/useDismiss';
import { useToast } from '../../components/Toasts';
import { effectiveDefaultProvider, isProviderUsable } from '../../data/providerStatus';
import { fetchQuotes, quoteRefreshMs, type QuoteView } from '../../data/quotes';
import { confirmDelete } from '../../lib/dialogs';
import { formatPercent, formatPrice } from '../../lib/format';
import {
  addWatchlistItems,
  addWatchlistSection,
  createWatchlist,
  deleteWatchlist,
  deleteWatchlistSection,
  errorMessage,
  flagOfList,
  getPreference,
  getSymbolNames,
  getWatchlist,
  listFlagLists,
  listWatchlists,
  removeWatchlistItems,
  renameWatchlist,
  renameWatchlistSection,
  setPreference,
  setSymbolFlag,
  setWatchlistOrder,
  setWatchlistSectionCollapsed,
  WATCHLIST_FLAGS,
  type RowRef,
  type WatchlistDetail,
  type WatchlistFlag,
  type WatchlistSummary,
} from '../../lib/ipc';
import { mergeQuotes, quoteTargets, rowWindow, SMALL_LIST } from '../../lib/listWindow';
import { displayTicker } from '../../lib/symbols';
import { parseWatchlistFile } from '../../lib/watchlistImport';
import {
  buildRows,
  fullIndex,
  isItem,
  moveRows,
  refOf,
  rowKey,
  sectionSize,
  visibleRows,
  withPositions,
  type ItemRow,
  type Row,
  type SectionRow,
} from '../../lib/watchlistRows';
import { useProviderState } from '../providers/useProviderState';
import { SymbolSearchBox, type PickedSymbol } from '../search/SymbolSearchBox';
import { useRowDrag } from './useRowDrag';
import { MAX_QUICK_LISTS } from '../../lib/quickLists';
import { loadQuickLists, toggleQuickListPin, useQuickLists } from './quickLists';
import { WatchlistBrowserDialog } from './WatchlistBrowserDialog';
import { subscribeWatchlistsChanged } from './watchlistBus';

interface Props {
  /** Whether the panel is showing. It stays mounted while another panel (or none) is: the list, its sort and
   *  its scroll position are kept, and it simply stops fetching prices. */
  visible: boolean;
  /** The active chart's symbol, highlighted in the list when present. */
  activeSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  /** "Open in new tab" from a row's menu. */
  onOpenInNewTab: (symbol: string) => void;
}

type SortKey = 'symbol' | 'last' | 'chg';
type SortDir = 'asc' | 'desc';
type FormMode = 'create' | 'rename' | null;

/** Regaining window focus refreshes prices, but not if they were fetched this recently. */
const FOCUS_REFRESH_MIN_GAP_MS = 10_000;
const PREF_ACTIVE = 'watchlist_active';
/** The flag colour a plain click on a row's flag applies: the last one chosen. */
const PREF_LAST_FLAG = 'watchlist_last_flag';
/** Rows rendered beyond the visible ones, so a short scroll never shows a gap. */
const OVERSCAN_ROWS = 8;
/** A row's height until the first one is measured. */
const DEFAULT_ROW_HEIGHT = 35;
/** While a price sort needs every row priced, each refresh also quotes this many more (three requests). */
const FULL_LIST_CHUNK = 60;
/** How long the list must sit still after a scroll before its new rows are fetched. */
const SCROLL_SETTLE_MS = 250;
/** Keeps a row with no name yet as tall as the others, which the windowing relies on. */
const NO_NAME = ' ';
/** How long a price that just moved stays tinted. */
const FLASH_MS = 900;
const NEW_SECTION_NAME = 'New section';

function sortItems<T extends { symbol: string }>(items: T[], quotes: Map<string, QuoteView>, key: SortKey, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (i: T) => (key === 'last' ? quotes.get(i.symbol)?.price : quotes.get(i.symbol)?.changePercent);
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
 *  symbols, and import from a TradingView-style export. Rows can be flagged with
 *  a colour, grouped under section headings and dragged into any order; a
 *  right-click opens a menu of what can be done with one. */
export function WatchlistPanel({ visible, activeSymbol, onSelectSymbol, onOpenInNewTab }: Props) {
  const toast = useToast();
  const [watchlists, setWatchlists] = useState<WatchlistSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<WatchlistDetail | null>(null);
  const [quotes, setQuotes] = useState<Map<string, QuoteView>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  /** The row whose flag button was pressed: its colour choices open under the button. */
  const [flagPicker, setFlagPicker] = useState<{ x: number; y: number; key: string } | null>(null);
  const pins = useQuickLists();
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [formName, setFormName] = useState('');
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  /** The section whose name is being typed in place. */
  const [editingSection, setEditingSection] = useState<number | null>(null);
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

  useEffect(() => {
    void loadQuickLists();
  }, []);

  /** The six colour lists (every symbol flagged with a colour), for the list selector. */
  const [flagLists, setFlagLists] = useState<WatchlistSummary[]>([]);
  const refreshFlagLists = useCallback(() => {
    listFlagLists().then(setFlagLists).catch(() => {});
  }, []);
  /** The colour one click on an unflagged row's flag applies: the last one chosen. */
  const [lastFlag, setLastFlag] = useState<WatchlistFlag>('red');
  useEffect(() => {
    getPreference(PREF_LAST_FLAG)
      .then((v) => {
        if (v && (WATCHLIST_FLAGS as readonly string[]).includes(v)) setLastFlag(v as WatchlistFlag);
      })
      .catch(() => {});
  }, []);
  const rememberFlag = useCallback((flag: WatchlistFlag) => {
    setLastFlag(flag);
    setPreference(PREF_LAST_FLAG, flag).catch(() => {});
  }, []);

  const selectWatchlist = useCallback(
    async (id: number) => {
      setActiveId(id);
      setSwitcherOpen(false);
      setError(null);
      setEditingSection(null);
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

  // Initial load: restore the last-used list.
  useEffect(() => {
    (async () => {
      try {
        const [lists, colours, savedActive] = await Promise.all([listWatchlists(), listFlagLists(), getPreference(PREF_ACTIVE)]);
        setWatchlists(lists);
        setFlagLists(colours);
        const preferred = [...lists, ...colours].find((l) => String(l.id) === savedActive) ?? lists[0];
        if (preferred) await selectWatchlist(preferred.id);
      } catch (err) {
        fail(err);
      } finally {
        setLoading(false);
      }
    })();
  }, [selectWatchlist, fail]);

  // Something else changed the lists (a Python script adding its results to one).
  useEffect(
    () =>
      subscribeWatchlistsChanged(() => {
        refreshFlagLists();
        listWatchlists()
          .then(async (lists) => {
            setWatchlists(lists);
            const current = activeId ?? lists[0]?.id;
            if (current !== undefined) setDetail(await getWatchlist(current));
          })
          .catch(fail);
      }),
    [activeId, fail, refreshFlagLists],
  );

  // The list as rows: symbols and section headings in one sequence, and — for what is on screen — with
  // the symbols under a collapsed heading left out, or, while sorted by a column, just the symbols.
  const rows = useMemo(() => (detail ? buildRows(detail.items, detail.sections) : []), [detail]);
  const rowByKey = useMemo(() => new Map(rows.map((r) => [rowKey(r), r])), [rows]);
  const sectionCounts = useMemo(() => {
    const counts = new Map<number, number>();
    rows.forEach((row, i) => {
      if (row.kind === 'section') counts.set(row.id, sectionSize(rows, i));
    });
    return counts;
  }, [rows]);
  const sortedRows = useMemo(
    () => (sortKey ? sortItems(rows.filter(isItem), quotes, sortKey, sortDir) : null),
    [rows, quotes, sortKey, sortDir],
  );
  const shown: Row[] = useMemo(() => sortedRows ?? visibleRows(rows), [sortedRows, rows]);
  const shownItems = useMemo(() => shown.filter(isItem), [shown]);
  const symbolsKey = detail?.items.map((i) => i.symbol).join('|') ?? '';

  // Only the rows on screen are rendered: a 1,000-row list costs what a screenful does.
  const win = rowWindow(viewport.top, viewport.height || 600, rowHeight, shown.length, OVERSCAN_ROWS);
  const windowRows = useMemo(() => shown.slice(win.start, win.end), [shown, win.start, win.end]);
  const windowSymbols = useMemo(() => windowRows.filter(isItem).map((r) => r.symbol), [windowRows]);
  const visibleKey = windowSymbols.join('|');
  const priceSort = sortKey === 'last' || sortKey === 'chg';
  const needsAll = priceSort && shownItems.length > SMALL_LIST;
  useEffect(() => {
    quoteView.current = { all: shownItems.map((i) => i.symbol), visible: windowSymbols, needsAll, known: quotes };
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
  }, [visible, hasDetail]);

  // Rows are one fixed height (both text lines are single-line), measured once
  // rendered so the spacers above and below the visible rows are exact.
  useLayoutEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>('.watchlist-row');
    const height = row?.getBoundingClientRect().height;
    if (height && Math.abs(height - rowHeight) > 0.5) setRowHeight(height);
  });

  // Prices, for the rows on screen: on load, every 20s, when the window regains
  // focus after a short while, and for rows scrolled into view. Skipped while the
  // window is hidden or the panel isn't showing. A long list isn't quoted whole — that
  // would spend a data source's request limits and starve the charts — except while
  // sorted by price.
  useEffect(() => {
    if (!visible || !symbolsKey) return;
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
      const { all, visible: onScreen, needsAll: walkAll, known } = quoteView.current;
      let target: string[];
      if (reason === 'tick') {
        const planned = quoteTargets(all, onScreen, walkAll, cursor, FULL_LIST_CHUNK);
        cursor = planned.next;
        target = planned.symbols;
        lastRefresh = Date.now();
      } else {
        // Only rows that have never been priced: a price sort reshuffles the rows
        // on every refresh, and re-quoting whatever lands on screen would never stop.
        target = onScreen.filter((s) => !known.has(s));
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
  }, [symbolsKey, visible, usableProviders]);

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
    const index = shown.findIndex((r) => r.kind === 'item' && r.symbol === activeSymbol);
    if (!el || index < 0) return;
    const top = index * rowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    // Only when the choice changes: re-sorting shouldn't yank the list around.
  }, [activeSymbol]);

  const pricedCount = useMemo(
    () => (needsAll ? shownItems.filter((i) => quotes.get(i.symbol)?.price != null).length : 0),
    [needsAll, shownItems, quotes],
  );

  // Arrow keys scrub through the list and load each symbol as you go. Ignored
  // while typing in a field so it never fights the search box or a name input.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || shownItems.length === 0) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return;
      // Vela's own keyboard handling owns arrows while a chart has focus.
      if (el?.closest('.single-chart-canvas')) return;
      e.preventDefault();
      const idx = shownItems.findIndex((i) => i.symbol === activeSymbol);
      const next = e.key === 'ArrowUp' ? shownItems[Math.max(0, idx - 1)] : shownItems[Math.min(shownItems.length - 1, idx + 1)];
      if (next && next.symbol !== activeSymbol) onSelectSymbol(next.symbol);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, shownItems, activeSymbol, onSelectSymbol]);

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

  /** Reads the lists again after the browse dialog changed them, staying on the current one if it
   *  still exists. */
  async function refreshLists() {
    const lists = await listWatchlists();
    setWatchlists(lists);
    if (activeId !== null && lists.some((l) => l.id === activeId)) setDetail(await getWatchlist(activeId));
    else if (lists[0]) await selectWatchlist(lists[0].id);
    else {
      setActiveId(null);
      setDetail(null);
    }
  }

  function togglePin(id: number) {
    if (!toggleQuickListPin(id)) toast(`Up to ${MAX_QUICK_LISTS} watchlists can have quick access. Unpin one first.`, 'info');
  }

  function upsertSummary(d: WatchlistDetail) {
    // A colour's list isn't one of the watchlists; its count comes with the colour lists.
    if (flagOfList(d.id)) {
      refreshFlagLists();
      return;
    }
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
      if (pins.includes(detail.id)) toggleQuickListPin(detail.id);
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

  /** Runs a change the screen already shows: if the backend refuses it, the list is read again so the screen
   *  says what is really stored. */
  async function saveOrReload(save: () => Promise<unknown>) {
    if (!detail) return;
    try {
      await save();
    } catch (err) {
      fail(err);
      getWatchlist(detail.id).then(setDetail).catch(() => {});
    }
  }

  /** Flags a symbol — on every list, since a flag is the symbol's — and makes a chosen colour the one
   *  a plain click applies next time. On a colour's list, a symbol given another colour (or none) leaves it. */
  function setFlag(symbol: string, flag: WatchlistFlag | null) {
    if (!detail) return;
    if (flag) rememberFlag(flag);
    const colour = flagOfList(detail.id);
    const items =
      colour && flag !== colour ? detail.items.filter((i) => i.symbol !== symbol) : detail.items.map((i) => (i.symbol === symbol ? { ...i, flag } : i));
    setDetail({ ...detail, items });
    void saveOrReload(async () => {
      await setSymbolFlag(symbol, flag);
      refreshFlagLists();
    });
  }

  /** Puts the rows in a new order — on screen at once, then in the database. */
  function applyOrder(next: readonly Row[]) {
    if (!detail) return;
    const { items, sections } = withPositions(next);
    setDetail({ ...detail, items, sections });
    void saveOrReload(() => setWatchlistOrder(detail.id, next.map(refOf)));
  }

  function moveToTop(row: Row) {
    const from = rows.indexOf(row);
    if (from > 0) applyOrder(moveRows(rows, from, 0));
  }

  /** A row was let go over the shown row `insertion` (an index into `shown`). */
  function dropRow(row: Row, insertion: number) {
    const from = rows.findIndex((r) => rowKey(r) === rowKey(row));
    const next = moveRows(rows, from, fullIndex(rows, shown, insertion));
    if (next !== rows) applyOrder(next);
  }

  async function addSection(before: RowRef | null) {
    if (!detail) return;
    setSortKey(null); // headings aren't shown in a sorted list
    try {
      const known = new Set(detail.sections.map((s) => s.id));
      const updated = await addWatchlistSection(detail.id, NEW_SECTION_NAME, before);
      setDetail(updated);
      // Its name is asked for in place, where it now sits.
      setEditingSection(updated.sections.find((s) => !known.has(s.id))?.id ?? null);
    } catch (err) {
      fail(err);
    }
  }

  function toggleSection(id: number) {
    if (!detail) return;
    const collapsed = !detail.sections.find((s) => s.id === id)?.collapsed;
    setDetail({ ...detail, sections: detail.sections.map((s) => (s.id === id ? { ...s, collapsed } : s)) });
    void saveOrReload(() => setWatchlistSectionCollapsed(id, collapsed));
  }

  /** The name typed for a section, or `null` when it was abandoned. */
  function finishRename(id: number, name: string | null) {
    setEditingSection(null);
    const clean = name?.trim();
    const current = detail?.sections.find((s) => s.id === id)?.name;
    if (!detail || !clean || clean === current) return;
    setDetail({ ...detail, sections: detail.sections.map((s) => (s.id === id ? { ...s, name: clean } : s)) });
    void saveOrReload(() => renameWatchlistSection(id, clean));
  }

  function removeSection(id: number) {
    if (!detail) return;
    setDetail({ ...detail, sections: detail.sections.filter((s) => s.id !== id) });
    void saveOrReload(() => deleteWatchlistSection(id));
  }

  /** The colour, when the list showing is a colour's list: newest flag first, no sections, no reordering. */
  const colourList = flagOfList(detail?.id);
  const canReorder = detail != null && sortKey === null && colourList === null;
  const { drag, onRowPointerDown, consumeClick } = useRowDrag({
    listRef,
    rowHeight,
    shown,
    enabled: canReorder && editingSection === null,
    onDrop: dropRow,
  });

  // Where the dragged row would land, unless that is where it already is.
  const dropAt = useMemo(() => {
    if (!drag || drag.insertion === null) return null;
    const from = rows.findIndex((r) => rowKey(r) === rowKey(drag.row));
    return moveRows(rows, from, fullIndex(rows, shown, drag.insertion)) === rows ? null : drag.insertion;
  }, [drag, rows, shown]);
  const draggedKey = drag ? rowKey(drag.row) : null;

  // Rows are memoised, so they get callbacks that never change identity.
  const latest = useRef({ onSelectSymbol, handleRemove, rowByKey, toggleSection, finishRename, setFlag, lastFlag });
  latest.current = { onSelectSymbol, handleRemove, rowByKey, toggleSection, finishRename, setFlag, lastFlag };
  const selectRow = useCallback(
    (symbol: string) => {
      if (!consumeClick()) latest.current.onSelectSymbol(symbol);
    },
    [consumeClick],
  );
  const removeRow = useCallback((symbol: string) => void latest.current.handleRemove(symbol), []);
  const toggleRow = useCallback(
    (id: number) => {
      if (!consumeClick()) latest.current.toggleSection(id);
    },
    [consumeClick],
  );
  const renameRow = useCallback((id: number, name: string | null) => latest.current.finishRename(id, name), []);
  const pressRow = useCallback(
    (e: ReactPointerEvent, key: string) => {
      const row = latest.current.rowByKey.get(key);
      if (row) onRowPointerDown(e, row);
    },
    [onRowPointerDown],
  );
  const openMenu = useCallback((e: ReactMouseEvent, key: string) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, key });
  }, []);
  const openFlagPicker = useCallback((e: ReactMouseEvent, key: string) => {
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    setFlagPicker({ x: box.left, y: box.bottom + 4, key });
  }, []);
  /** A click on a row's flag: an unflagged symbol gets the last colour used, at once; a flagged one opens
   *  the colour choices (to change or remove it). A right-click always opens them (`openFlagPicker`). */
  const clickFlag = useCallback(
    (e: ReactMouseEvent, key: string) => {
      const row = latest.current.rowByKey.get(key);
      if (row?.kind !== 'item') return;
      if (row.flag) openFlagPicker(e, key);
      else latest.current.setFlag(row.symbol, latest.current.lastFlag);
    },
    [openFlagPicker],
  );

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

  const sortMark = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const menuRow = menu ? rowByKey.get(menu.key) : undefined;
  const pickedRow = flagPicker ? rowByKey.get(flagPicker.key) : undefined;
  const flagRow = pickedRow?.kind === 'item' ? pickedRow : undefined;
  const closeMenu = () => setMenu(null);
  // The row a menu was opened on is gone (removed from elsewhere, another list opened): so is the menu.
  useEffect(() => {
    if (menu && !menuRow) setMenu(null);
  }, [menu, menuRow]);
  /** Closes the menu, then does what its item said. */
  const choose = (action: () => void) => () => {
    setMenu(null);
    action();
  };

  return (
    <aside className={`watchlist-panel${visible ? '' : ' is-hidden'}`} aria-label="Watchlist" aria-hidden={!visible}>
      <div className="watchlist-header">
        <div className="menu-anchor" ref={switcherRef}>
          <button type="button" className="menu-trigger" onClick={() => setSwitcherOpen((v) => !v)} aria-haspopup="menu" aria-expanded={switcherOpen}>
            {colourList && <Flag size={13} fill="currentColor" style={{ color: `var(--flag-${colourList})` }} aria-hidden="true" />}
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
              {/* A list per colour: every symbol flagged with it, on any watchlist. */}
              <div className="menu-divider" />
              <div className="menu-heading">Flagged</div>
              {flagLists.map((w) => {
                const colour = flagOfList(w.id);
                return (
                  <button key={w.id} type="button" role="menuitem" className={`menu-item${w.id === activeId ? ' active' : ''}`} onClick={() => selectWatchlist(w.id)}>
                    <Flag size={13} fill="currentColor" style={{ color: `var(--flag-${colour})` }} aria-hidden="true" />
                    <span className="grow">{w.name}</span>
                    <span className="muted small">{w.itemCount}</span>
                  </button>
                );
              })}
              <div className="menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setSwitcherOpen(false);
                  setBrowseOpen(true);
                }}
              >
                <LayoutList size={14} />
                <span className="grow">Browse all watchlists…</span>
              </button>
            </div>
          )}
        </div>

        <div className="watchlist-header-actions">
          <button type="button" className="icon-button" aria-label="Browse all watchlists" title="All watchlists" onClick={() => setBrowseOpen(true)}>
            <LayoutList size={15} />
          </button>
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
                {/* A colour's list is simply what is flagged with it: nothing here applies to it. */}
                {colourList && <div className="menu-empty small">Flag or unflag symbols to change this list.</div>}
                {!colourList && (
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
                )}
                {detail && !colourList && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setMoreOpen(false);
                        void addSection(null);
                      }}
                    >
                      <SeparatorHorizontal size={14} />
                      <span className="grow">Add section</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="menu-item"
                      onClick={() => {
                        setMoreOpen(false);
                        togglePin(detail.id);
                      }}
                    >
                      <Star size={14} />
                      <span className="grow">{pins.includes(detail.id) ? 'Remove from quick access' : 'Add to quick access'}</span>
                    </button>
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
          <input ref={fileInputRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFilePicked} />
        </div>
      </div>

      {pins.length > 0 && (
        <div className="watchlist-quick" role="tablist" aria-label="Quick-access watchlists">
          {pins.map((id) => {
            const list = watchlists.find((w) => w.id === id);
            return (
              list && (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={id === activeId}
                  className={`watchlist-quick-tab${id === activeId ? ' active' : ''}`}
                  title={`${list.name} (${list.itemCount})`}
                  onClick={() => void selectWatchlist(id)}
                >
                  {list.name}
                </button>
              )
            );
          })}
        </div>
      )}

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
          {needsAll && pricedCount < shownItems.length && (
            <p className="watchlist-note muted small">
              Sorting by the prices loaded so far: {pricedCount} of {shownItems.length}.
            </p>
          )}
          {sortKey && detail.sections.length > 0 && (
            <p className="watchlist-note muted small">Sections are hidden, and rows can't be dragged, while the list is sorted.</p>
          )}

          <div className="watchlist-items" ref={listRef}>
            {detail.items.length === 0 && shown.length === 0 ? (
              <p className="muted small" style={{ padding: 12 }}>No symbols yet — search above to add one.</p>
            ) : (
              <>
                <div style={{ height: win.start * rowHeight }} aria-hidden="true" />
                {windowRows.map((row, k) => {
                  const index = win.start + k;
                  const dropEdge =
                    dropAt === null ? null : dropAt === index ? 'before' : dropAt === shown.length && index === shown.length - 1 ? 'after' : null;
                  const key = rowKey(row);
                  return row.kind === 'section' ? (
                    <SectionHeading
                      key={key}
                      rowKey={key}
                      id={row.id}
                      name={row.name}
                      collapsed={row.collapsed}
                      count={sectionCounts.get(row.id) ?? 0}
                      editing={editingSection === row.id}
                      height={rowHeight}
                      dragging={draggedKey === key}
                      dropEdge={dropEdge}
                      onToggle={toggleRow}
                      onRename={renameRow}
                      onMenu={openMenu}
                      onPress={pressRow}
                    />
                  ) : (
                    <WatchlistRow
                      key={key}
                      rowKey={key}
                      symbol={row.symbol}
                      name={row.name ?? names.get(row.symbol) ?? null}
                      flag={row.flag}
                      quote={quotes.get(row.symbol)}
                      selected={row.symbol === activeSymbol}
                      dragging={draggedKey === key}
                      dropEdge={dropEdge}
                      onSelect={selectRow}
                      onRemove={removeRow}
                      onMenu={openMenu}
                      defaultFlag={lastFlag}
                      onFlagClick={clickFlag}
                      onFlagMenu={openFlagPicker}
                      onPress={pressRow}
                    />
                  );
                })}
                <div style={{ height: (shown.length - win.end) * rowHeight }} aria-hidden="true" />
              </>
            )}
          </div>
        </>
      )}

      {flagPicker && flagRow && (
        <ContextMenu x={flagPicker.x} y={flagPicker.y} label={`Flag ${displayTicker(flagRow.symbol)}`} onClose={() => setFlagPicker(null)}>
          <FlagSwatches
            current={flagRow.flag}
            onFlag={(flag) => {
              setFlagPicker(null);
              setFlag(flagRow.symbol, flag);
            }}
          />
          {flagRow.flag && (
            <button
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setFlagPicker(null);
                setFlag(flagRow.symbol, null);
              }}
            >
              <X size={14} />
              <span className="grow">Remove flag</span>
            </button>
          )}
        </ContextMenu>
      )}

      {menu && menuRow && (
        <ContextMenu x={menu.x} y={menu.y} label={menuRow.kind === 'item' ? displayTicker(menuRow.symbol) : menuRow.name} onClose={closeMenu}>
          {menuRow.kind === 'item' ? (
            <ItemMenu
              row={menuRow}
              canReorder={canReorder}
              isFirst={rows[0] === menuRow}
              onOpenInNewTab={choose(() => onOpenInNewTab(menuRow.symbol))}
              onAddAlert={choose(() => openAlerts({ symbol: menuRow.symbol }))}
              onFlag={(flag) => choose(() => setFlag(menuRow.symbol, flag))()}
              onMoveToTop={choose(() => moveToTop(menuRow))}
              onAddSection={choose(() => void addSection(refOf(menuRow)))}
              onRemove={choose(() => void handleRemove(menuRow.symbol))}
            />
          ) : (
            <SectionMenu
              row={menuRow}
              canReorder={canReorder}
              onRename={choose(() => setEditingSection(menuRow.id))}
              onToggle={choose(() => toggleSection(menuRow.id))}
              onAddSection={choose(() => void addSection(refOf(menuRow)))}
              onDelete={choose(() => removeSection(menuRow.id))}
            />
          )}
        </ContextMenu>
      )}
      {browseOpen && (
        <WatchlistBrowserDialog
          lists={watchlists}
          activeId={activeId}
          onOpen={(id) => {
            setBrowseOpen(false);
            void refreshLists().then(() => selectWatchlist(id));
          }}
          onChanged={() => refreshLists().catch(fail)}
          onClose={() => setBrowseOpen(false)}
          say={toast}
        />
      )}
    </aside>
  );
}

function withNames(prev: Map<string, string>, found: Record<string, string>): Map<string, string> {
  const fresh = Object.entries(found).filter(([symbol, name]) => prev.get(symbol) !== name);
  return fresh.length ? new Map([...prev, ...fresh]) : prev;
}

type DropEdge = 'before' | 'after' | null;

const dropClass = (edge: DropEdge) => (edge ? ` drop-${edge}` : '');

/** A price that just moved, and which way: for a moment it is tinted green (up) or red (down). */
function useTickFlash(price: number | null | undefined): 'up' | 'down' | null {
  const previous = useRef(price);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = price;
    if (before == null || price == null || before === price) return;
    setFlash(price > before ? 'up' : 'down');
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [price]);
  return flash;
}

interface RowProps {
  rowKey: string;
  symbol: string;
  name: string | null;
  flag: WatchlistFlag | null;
  quote: QuoteView | undefined;
  selected: boolean;
  dragging: boolean;
  dropEdge: DropEdge;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onMenu: (e: ReactMouseEvent, key: string) => void;
  /** The colour a click on the flag of an unflagged row applies. */
  defaultFlag: WatchlistFlag;
  /** A click on the flag: the default colour if unflagged, the colour choices if flagged. */
  onFlagClick: (e: ReactMouseEvent, key: string) => void;
  /** A right-click on the flag: the colour choices. */
  onFlagMenu: (e: ReactMouseEvent, key: string) => void;
  onPress: (e: ReactPointerEvent, key: string) => void;
}

/** One watchlist row: the ticker (with its colour flag), the company name beneath it, price and change.
 *  Memoised, so a refresh re-renders only the rows whose price moved. */
const WatchlistRow = memo(function WatchlistRow({ rowKey: key, symbol, name, flag, quote, selected, dragging, dropEdge, onSelect, onRemove, onMenu, defaultFlag, onFlagClick, onFlagMenu, onPress }: RowProps) {
  const change = quote?.changePercent ?? null;
  const ticker = displayTicker(symbol);
  const flash = useTickFlash(quote?.price);
  return (
    <div
      className={`watchlist-row${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${dropClass(dropEdge)}`}
      role="button"
      tabIndex={0}
      title={name ? `${ticker} — ${name}` : ticker}
      onClick={() => onSelect(symbol)}
      onKeyDown={(e: ReactKeyboardEvent) => e.key === 'Enter' && onSelect(symbol)}
      onContextMenu={(e) => onMenu(e, key)}
      onPointerDown={(e) => onPress(e, key)}
    >
      <div className="watchlist-symbol">
        <span className="ticker">
          {/* Always there, so a flag is one click away: coloured when set, an outline (in the colour a
              click would give) on hover when not. A right-click offers every colour. */}
          <button
            type="button"
            className={`watchlist-flag${flag ? ' on' : ''}`}
            style={{ color: `var(--flag-${flag ?? defaultFlag})` }}
            aria-label={flag ? `${ticker}: ${flag} flag — change or remove it` : `Flag ${ticker} ${defaultFlag}`}
            title={flag ? 'Change or remove the flag (right-click for colours)' : `Flag ${defaultFlag} (right-click for other colours)`}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onFlagClick(e, key);
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              onFlagMenu(e, key);
            }}
          >
            <Flag size={11} fill={flag ? 'currentColor' : 'none'} />
          </button>
          <span className="ticker-text">{ticker}</span>
        </span>
        <span className="sub">{name ?? NO_NAME}</span>
      </div>
      <span className={`watchlist-num${flash ? ` flash-${flash}` : ''}`}>{formatPrice(quote?.price)}</span>
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

interface SectionProps {
  rowKey: string;
  id: number;
  name: string;
  collapsed: boolean;
  /** How many symbols it holds. */
  count: number;
  editing: boolean;
  height: number;
  dragging: boolean;
  dropEdge: DropEdge;
  onToggle: (id: number) => void;
  /** The name typed, or `null` when the edit was abandoned. */
  onRename: (id: number, name: string | null) => void;
  onMenu: (e: ReactMouseEvent, key: string) => void;
  onPress: (e: ReactPointerEvent, key: string) => void;
}

/** A section heading: click to fold the symbols under it away, right-click for the rest, drag to move it
 *  (with its symbols). It is exactly one row tall, which the windowing relies on. */
const SectionHeading = memo(function SectionHeading({ rowKey: key, id, name, collapsed, count, editing, height, dragging, dropEdge, onToggle, onRename, onMenu, onPress }: SectionProps) {
  return (
    <div
      className={`watchlist-section${dragging ? ' dragging' : ''}${dropClass(dropEdge)}`}
      style={{ height }}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={() => !editing && onToggle(id)}
      onKeyDown={(e: ReactKeyboardEvent) => {
        if (editing || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onToggle(id);
      }}
      onContextMenu={(e) => onMenu(e, key)}
      onPointerDown={(e) => onPress(e, key)}
    >
      {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      {editing ? <SectionNameInput initial={name} onDone={(typed) => onRename(id, typed)} /> : <span className="watchlist-section-name">{name}</span>}
      <span className="watchlist-section-count">{count}</span>
    </div>
  );
});

/** The name of a section being typed in place: Enter or leaving the field keeps it, Escape drops it. It reports
 *  once — removing the field can itself blur it, and that must not undo an Escape. */
function SectionNameInput({ initial, onDone }: { initial: string; onDone: (typed: string | null) => void }) {
  const settled = useRef(false);
  const settle = (typed: string | null) => {
    if (settled.current) return;
    settled.current = true;
    onDone(typed);
  };
  return (
    <input
      autoFocus
      type="text"
      className="watchlist-section-input"
      defaultValue={initial}
      maxLength={60}
      aria-label="Section name"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') settle(e.currentTarget.value);
        else if (e.key === 'Escape') settle(null);
      }}
      onBlur={(e) => settle(e.currentTarget.value)}
    />
  );
}

/** The flag colours as swatches; the one already set removes the flag. Shared by the row's flag
 *  button and its right-click menu. */
function FlagSwatches({ current, onFlag }: { current: WatchlistFlag | null; onFlag: (flag: WatchlistFlag | null) => void }) {
  return (
    <div className="menu-flags" role="group" aria-label="Flag">
      <span className="menu-flags-label">Flag</span>
      {WATCHLIST_FLAGS.map((flag) => (
        <button
          key={flag}
          type="button"
          role="menuitemradio"
          aria-checked={current === flag}
          aria-label={flag}
          title={current === flag ? `Remove the ${flag} flag` : `Flag ${flag}`}
          className={`flag-swatch${current === flag ? ' on' : ''}`}
          style={{ background: `var(--flag-${flag})` }}
          onClick={() => onFlag(current === flag ? null : flag)}
        />
      ))}
    </div>
  );
}

interface ItemMenuProps {
  row: ItemRow;
  canReorder: boolean;
  isFirst: boolean;
  onOpenInNewTab: () => void;
  onAddAlert: () => void;
  onFlag: (flag: WatchlistFlag | null) => void;
  onMoveToTop: () => void;
  onAddSection: () => void;
  onRemove: () => void;
}

/** What can be done with one symbol of the list. */
function ItemMenu({ row, canReorder, isFirst, onOpenInNewTab, onAddAlert, onFlag, onMoveToTop, onAddSection, onRemove }: ItemMenuProps) {
  return (
    <>
      <button type="button" role="menuitem" className="menu-item" onClick={onOpenInNewTab}>
        <ExternalLink size={14} />
        <span className="grow">Open in new tab</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={onAddAlert}>
        <Bell size={14} />
        <span className="grow">Add alert…</span>
      </button>
      <FlagSwatches current={row.flag} onFlag={onFlag} />
      {canReorder && (
        <>
          {!isFirst && (
            <button type="button" role="menuitem" className="menu-item" onClick={onMoveToTop}>
              <ArrowUpToLine size={14} />
              <span className="grow">Move to top</span>
            </button>
          )}
          <button type="button" role="menuitem" className="menu-item" onClick={onAddSection}>
            <SeparatorHorizontal size={14} />
            <span className="grow">Add section above</span>
          </button>
        </>
      )}
      <div className="menu-divider" />
      <button type="button" role="menuitem" className="menu-item danger" onClick={onRemove}>
        <Trash2 size={14} />
        <span className="grow">Remove</span>
      </button>
    </>
  );
}

interface SectionMenuProps {
  row: SectionRow;
  canReorder: boolean;
  onRename: () => void;
  onToggle: () => void;
  onAddSection: () => void;
  onDelete: () => void;
}

/** What can be done with a section heading. */
function SectionMenu({ row, canReorder, onRename, onToggle, onAddSection, onDelete }: SectionMenuProps) {
  return (
    <>
      <button type="button" role="menuitem" className="menu-item" onClick={onRename}>
        <Pencil size={14} />
        <span className="grow">Rename</span>
      </button>
      <button type="button" role="menuitem" className="menu-item" onClick={onToggle}>
        {row.collapsed ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="grow">{row.collapsed ? 'Expand' : 'Collapse'}</span>
      </button>
      {canReorder && (
        <button type="button" role="menuitem" className="menu-item" onClick={onAddSection}>
          <SeparatorHorizontal size={14} />
          <span className="grow">Add section above</span>
        </button>
      )}
      <div className="menu-divider" />
      <button type="button" role="menuitem" className="menu-item danger" onClick={onDelete}>
        <Trash2 size={14} />
        <span className="grow">Delete section (keep its symbols)</span>
      </button>
    </>
  );
}
