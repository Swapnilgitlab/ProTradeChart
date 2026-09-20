import { ask } from '@tauri-apps/plugin-dialog';

/** Native OS confirmation for destructive actions — looks like part of the
 *  operating system rather than a stock browser `confirm()`. */
export function confirmDelete(message: string): Promise<boolean> {
  return ask(message, { title: 'ProTradeChart', kind: 'warning' });
}

/** Native OS confirmation before unsaved work is thrown away. */
export function confirmDiscard(message: string): Promise<boolean> {
  return ask(message, { title: 'ProTradeChart', kind: 'warning', okLabel: 'Discard', cancelLabel: 'Keep editing' });
}
