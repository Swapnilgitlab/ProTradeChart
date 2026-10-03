import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const win = getCurrentWindow();

/** Double-clicking a `data-tauri-drag-region` element (the brand mark, the spacer before the actions)
 *  already toggles maximize on its own — Tauri's `internal_toggle_maximize` command, pre-granted by
 *  `core:window:default`, handles that natively without any JS here. This is only for the Maximize
 *  button itself, which needs the separate `core:window:allow-toggle-maximize` permission
 *  (`src-tauri/capabilities/default.json`) since it isn't the drag region's internal command. */
export const toggleWindowMaximize = () => void win.toggleMaximize();

/** The window has no native title bar (`decorations: false` in `tauri.conf.json`, so the tab bar can
 *  serve as one instead — see `.tab-brand` and `.tab-bar-drag` in app.css): these are its
 *  minimize/maximize/close, since the OS no longer draws any. Each needs its own permission grant
 *  (`core:window:allow-minimize` etc. in `src-tauri/capabilities/default.json`) — `core:default` only
 *  covers read-only window state, not these. Not verified on macOS or Linux, only Windows (see
 *  CLAUDE.md). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      }).catch(() => {});
    };
    refresh();
    const unlisten = win.onResized(refresh);
    return () => {
      cancelled = true;
      void unlisten.then((off) => off());
    };
  }, []);

  return (
    <div className="window-controls">
      <button type="button" className="icon-button" aria-label="Minimize" title="Minimize" onClick={() => void win.minimize()}>
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={toggleWindowMaximize}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button type="button" className="icon-button window-close" aria-label="Close" title="Close" onClick={() => void win.close()}>
        <X size={15} />
      </button>
    </div>
  );
}
