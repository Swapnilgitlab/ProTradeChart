import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useDismiss } from '../../components/useDismiss';
import { effectiveDefaultProvider } from '../../data/providerStatus';
import { searchSymbols, type SymbolResult } from '../../data/search';
import { displayTicker, providerLabel, resolveTypedSymbol } from '../../lib/symbols';

export interface PickedSymbol {
  symbol: string;
  name?: string;
}

interface Props {
  onSelect: (picked: PickedSymbol) => void;
  placeholder?: string;
  /** Fill the parent's width and drop the dropdown to match (used in panels). */
  block?: boolean;
}

const DEBOUNCE_MS = 250;

/** Groups results by provider while keeping first-seen order, and returns the
 *  flat list in display order so keyboard indices match what's on screen. */
function groupResults(results: SymbolResult[]): { provider: string; items: SymbolResult[] }[] {
  const groups = new Map<string, SymbolResult[]>();
  for (const r of results) groups.set(r.provider, [...(groups.get(r.provider) ?? []), r]);
  return [...groups].map(([provider, items]) => ({ provider, items }));
}

/** Live symbol search across every data source, with keyboard navigation.
 *  Nothing is cached or mirrored locally except what each provider already
 *  holds (see data/providers): every query is answered fresh. */
export const SymbolSearchBox = forwardRef<HTMLInputElement, Props>(function SymbolSearchBox(
  { onSelect, placeholder, block },
  inputRef,
) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SymbolResult[]>([]);
  const [resultsFor, setResultsFor] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const requestId = useRef(0);

  useDismiss(rootRef, open, () => setOpen(false));

  const groups = useMemo(() => groupResults(results), [results]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      requestId.current++;
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++requestId.current;
    const timer = window.setTimeout(async () => {
      const found = await searchSymbols(q);
      if (id !== requestId.current) return; // a newer query superseded this one
      setResults(found);
      setResultsFor(q);
      setActive(0);
      setLoading(false);
      setOpen(true);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  function reset() {
    requestId.current++;
    setQuery('');
    setResults([]);
    setOpen(false);
    setLoading(false);
  }

  function pick(r: SymbolResult) {
    onSelect({ symbol: r.symbol, name: r.name });
    reset();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    // Only trust the highlighted result if it belongs to what's typed now;
    // otherwise (Enter pressed before results landed) load the typed text.
    if (open && flat[active] && resultsFor === query.trim()) return pick(flat[active]);
    const typed = resolveTypedSymbol(query, effectiveDefaultProvider());
    if (typed) {
      onSelect({ symbol: typed });
      reset();
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || flat.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    }
  }

  let index = -1;
  return (
    <div
      className={`search-box${block ? ' block' : ''}`}
      ref={rootRef}
      onBlur={(e) => {
        // Tabbing away leaves no pointer event for useDismiss to see.
        if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <form onSubmit={submit}>
        <div className="search-input-wrap">
          <Search size={14} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onFocus={() => flat.length > 0 && setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? 'Search symbol…  (Ctrl+K)'}
            aria-label="Search symbols"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </form>

      {open && query.trim() !== '' && (
        <div className="search-dropdown" role="listbox">
          {groups.map((group) => (
            <div key={group.provider}>
              <div className="search-group">{providerLabel(group.provider)}</div>
              {group.items.map((r) => {
                index++;
                const i = index;
                return (
                  <button
                    key={r.symbol}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={`search-row${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r)}
                  >
                    <span className="ticker">{displayTicker(r.symbol)}</span>
                    <span className="name">{r.name}</span>
                    {r.tag && <span className="tag">{r.tag}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 && (
            <div className="search-status">
              {loading ? 'Searching…' : `No matches. Press Enter to load “${query.trim().toUpperCase()}” as a ticker.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
