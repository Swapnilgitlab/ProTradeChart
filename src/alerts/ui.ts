/** How the rest of the app asks for the alerts dialog to open. The chart's
 *  right-click menu and toolbar (Vela's own UI, outside React) and the
 *  keyboard shortcut all end up here; the workspace listens and shows the dialog. */

export interface AlertDraft {
  /** The chart's symbol, `provider:TICKER`. */
  symbol: string;
  /** A price to start from — the one under the cursor when the alert was made from the chart. */
  price?: number | null;
}

type Listener = (draft: AlertDraft | null) => void;

const listeners = new Set<Listener>();

/** Opens the alerts dialog: on a new-alert form for `draft`, or on the list when there is none. */
export function openAlerts(draft: AlertDraft | null = null): void {
  listeners.forEach((listener) => listener(draft));
}

export function onOpenAlerts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
