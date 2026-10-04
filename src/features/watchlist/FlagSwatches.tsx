import { WATCHLIST_FLAGS, type WatchlistFlag } from '../../lib/ipc';

/** The flag colours as swatches; the one already set removes the flag. Shared by a watchlist row's flag
 *  button and its right-click menu, and by the Screener's results. */
export function FlagSwatches({ current, onFlag }: { current: WatchlistFlag | null; onFlag: (flag: WatchlistFlag | null) => void }) {
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
