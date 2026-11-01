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

/** Native OS confirmation before broker prices are first kept on disk: the terms notice. */
export function confirmSavingPrices(notice: string): Promise<boolean> {
  return ask(notice, { title: 'Save prices on this computer', kind: 'warning', okLabel: 'Save prices', cancelLabel: 'Cancel' });
}

/** Native OS question after a broker's login is forgotten: its terms ask for its data to go too.
 *  `series` is how many saved series hold bars it supplied. */
export function confirmDeleteSavedPrices(broker: string, series: number): Promise<boolean> {
  const which = series === 1 ? 'the 1 stock' : `the ${series.toLocaleString('en-IN')} stocks`;
  return ask(
    `Also delete the saved prices of ${which} ${broker} supplied? ${broker}’s terms ask for its data to be deleted once you stop using it.`,
    { title: 'ProTradeChart', kind: 'warning', okLabel: 'Delete them', cancelLabel: 'Keep them' },
  );
}

/** Native OS confirmation before a file of the user's is overwritten. */
export function confirmReplace(message: string): Promise<boolean> {
  return ask(message, { title: 'ProTradeChart', kind: 'warning', okLabel: 'Replace', cancelLabel: 'Cancel' });
}
