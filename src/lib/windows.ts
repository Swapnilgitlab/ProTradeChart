import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

/** Opens another independent chart window — handy on a multi-monitor setup.
 *  Every window shares the same local database (layouts, watchlists, imported
 *  data) but has its own tabs. */
export function openNewWindow(): void {
  new WebviewWindow(`chart-${Date.now()}`, {
    url: 'index.html',
    title: 'ProTradeChart',
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    decorations: false,
  });
}
