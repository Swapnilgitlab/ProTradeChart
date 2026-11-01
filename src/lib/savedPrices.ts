import type { SavedPricesStatus } from './ipc';

/** What the user agrees to before prices are saved. Shown as it stands in the confirmation, so keep
 *  it plain text; the Help topic `data-terms` says the same. */
export const SAVING_NOTICE =
  'This keeps a copy of your broker’s price history in a file on this computer, so charts open from it and the ' +
  'first screen, Study or script after a launch needs only today’s prices from the broker.\n\n' +
  'Your broker’s terms may not allow it. Zerodha’s Kite Connect terms say you will not “build databases, or ' +
  'otherwise create permanent copies” of its data without its permission, and FYERS’s ask for its consent to ' +
  '“permanent or temporary copies”. Keeping to your broker’s terms is your responsibility: ask Zerodha ' +
  '(kiteconnect@zerodha.com) or FYERS if you are unsure.\n\n' +
  'Switching this off deletes the file. Forgetting a broker’s login offers to delete the prices it supplied too.';

const count = (n: number) => n.toLocaleString('en-IN');

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** "1.5 MB", "230 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** One line on what is saved. */
export function describeSaved(s: SavedPricesStatus): string {
  if (!s.open) return s.bytes > 0 ? `${formatBytes(s.bytes)} saved, not in use` : 'Nothing saved.';
  if (!s.series) return 'Nothing saved yet. Prices are saved as charts, screens and scripts read them.';
  const daily = s.dailySeries ? `, ${count(s.dailySeries)} daily` : '';
  const span = s.fromMs !== null && s.toMs !== null ? ` · daily from ${day(s.fromMs)} to ${day(s.toMs)}` : '';
  return `${count(s.series)} series${daily} · ${formatBytes(s.bytes)}${span}`;
}

/** Which brokers supplied them, when more than one did: "Supplied by Zerodha (2,100) and FYERS (40)". */
export function describeSuppliers(s: SavedPricesStatus): string | null {
  const by = s.supplied.filter((x) => x.series > 0);
  if (by.length < 2) return null;
  const names = by.map((x) => `${x.label} (${count(x.series)})`);
  return `Supplied by ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** How many saved series hold `broker`'s bars. */
export const suppliedBy = (s: SavedPricesStatus | null, broker: string) =>
  s?.supplied.find((x) => x.broker === broker)?.series ?? 0;
