import { useState } from 'react';
import { Flag, X } from 'lucide-react';
import { ContextMenu } from '../../components/ContextMenu';
import type { WatchlistFlag } from '../../lib/ipc';
import { displayTicker } from '../../lib/symbols';
import { FlagSwatches } from '../watchlist/FlagSwatches';

interface Props {
  symbol: string;
  flag: WatchlistFlag | null;
  onFlag: (flag: WatchlistFlag | null) => void;
}

/** A result's flag: coloured when the symbol has one, and a click opens the colours. The flag is the
 *  symbol's own, so it is the one every watchlist shows. Clicks stop here: the button sits in a table
 *  row that opens the chart. */
export function ScreenFlag({ symbol, flag, onFlag }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const ticker = displayTicker(symbol);
  const pick = (next: WatchlistFlag | null) => {
    setMenu(null);
    onFlag(next);
  };
  return (
    <span className="screener-flag-wrap" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`watchlist-flag screener-flag${flag ? ' on' : ''}`}
        style={flag ? { color: `var(--flag-${flag})` } : undefined}
        aria-label={flag ? `${ticker}: ${flag} flag — change or remove it` : `Flag ${ticker}`}
        aria-haspopup="menu"
        title={flag ? 'Change or remove the flag' : 'Flag this symbol'}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4 });
        }}
      >
        <Flag size={12} fill={flag ? 'currentColor' : 'none'} />
      </button>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} label={`Flag ${ticker}`} onClose={() => setMenu(null)}>
          <FlagSwatches current={flag} onFlag={pick} />
          {flag && (
            <button type="button" role="menuitem" className="menu-item" onClick={() => pick(null)}>
              <X size={14} />
              <span className="grow">Remove flag</span>
            </button>
          )}
        </ContextMenu>
      )}
    </span>
  );
}
