import { getMarketSource, getPreference, listProviders, setPreference, type ProviderInfo } from '../lib/ipc';
import {
  BROKER_LABELS,
  canonicalProvider,
  DEFAULT_PROVIDER,
  INDIA,
  isSupportedProvider,
  type BrokerId,
  type ProviderId,
} from '../lib/symbols';

/** A live snapshot of which data providers are switched on and set up, and
 *  which one is the default. Data code — search, quotes, the providers
 *  themselves — isn't React and can't use hooks, so this small store is what
 *  they read; the settings screen and `useProviderState` subscribe to it. */

export interface ProviderState {
  /** The data sources' settings: `csv` and each broker (`zerodha`, `fyers`) — not symbol namespaces. */
  providers: ProviderInfo[];
  /** The namespace a bare ticker (or a typed-and-entered symbol) goes to. */
  defaultProvider: ProviderId;
  /** The broker serving `india:` symbols, as the backend decided it (`market_source`). */
  indiaBroker: BrokerId;
  /** False until the first load from the backend. */
  loaded: boolean;
}

const PREF_KEY = 'default_provider';

let state: ProviderState = { providers: [], defaultProvider: DEFAULT_PROVIDER, indiaBroker: 'zerodha', loaded: false };
const listeners = new Set<() => void>();

function set(next: ProviderState) {
  state = next;
  listeners.forEach((l) => l());
}

export const getProviderState = (): ProviderState => state;

export function subscribeProviderState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const providerInfo = (id: string): ProviderInfo | undefined => state.providers.find((p) => p.id === id);

/** The broker that serves `india:` symbols right now. Only one ever does: the two brokers' bars are never mixed. */
export const activeBroker = (): BrokerId => state.indiaBroker;

export const brokerLabel = (broker: BrokerId = activeBroker()): string => BROKER_LABELS[broker];

/** Which settings a namespace's data depends on: the active broker's for `india`, its own otherwise. A broker's
 *  own id passes through, so `isProviderUsable('zerodha')` still asks about Zerodha's account. */
export function settingsFor(id: string): string {
  return id === INDIA ? activeBroker() : id;
}

/** Providers that need the user's own account: never assumed ready. */
const OPT_IN = new Set<string>(['zerodha', 'fyers']);

/** Enabled and fully set up. Takes a namespace (`india`, `csv`) or a broker (`zerodha`). Before the first load, only
 *  what needs no setup counts, so an account-backed source is never assumed to be ready, and one the app no longer has
 *  (a symbol saved from it) never is. */
export function isProviderUsable(id: string): boolean {
  const target = settingsFor(id);
  const info = providerInfo(target);
  if (!info) return !state.loaded && !OPT_IN.has(target) && isSupportedProvider(target);
  return info.enabled && info.configured;
}

/** The namespace a data source's symbols live in: every broker's are `india:`. */
export function namespaceOf(providerId: string): string {
  return OPT_IN.has(providerId) ? INDIA : providerId;
}

/** Each symbol namespace, whether its data can be read now, and what to call its source — what the Screener's and
 *  Studies' readiness checks are given (`india` is usable when its active broker is). */
export function namespaceStatus(): { id: string; usable: boolean; label: string }[] {
  return [
    { id: INDIA, usable: isProviderUsable(INDIA), label: brokerLabel() },
    { id: 'csv', usable: isProviderUsable('csv'), label: 'Imported data' },
  ];
}

/** What a brand-new chart shows until the user picks something else: a well-known
 *  NSE name. It still needs the user's own broker account connected to load. */
export function starterSymbol(): string {
  return 'india:NSE:RELIANCE';
}

/** Providers that can be searched right now. */
export const searchableProviders = (): ProviderInfo[] =>
  state.providers.filter((p) => p.capabilities.search && p.enabled && p.configured);

export async function refreshProviders(): Promise<void> {
  const [providers, stored, source] = await Promise.all([
    listProviders(),
    getPreference(PREF_KEY).catch(() => null),
    getMarketSource().catch(() => null),
  ]);
  // A default saved under a broker's name (`zerodha`, before the Indian namespace) means the Indian namespace.
  const storedId = stored === null ? null : canonicalProvider(stored);
  const defaultId = storedId !== null && isSupportedProvider(storedId) ? storedId : DEFAULT_PROVIDER;
  set({ providers, defaultProvider: defaultId, indiaBroker: source?.broker ?? 'zerodha', loaded: true });
}

let loading: Promise<void> | null = null;

/** Resolves once the provider state has been loaded from the backend. Data
 *  code awaits this before deciding a provider isn't set up: at startup a saved
 *  layout can ask for bars before the first load has finished. */
export function ensureProvidersLoaded(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  loading ??= refreshProviders()
    .catch(() => {})
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The default falls back to the built-in one if the chosen provider is later switched off
 *  or its account is disconnected. */
export function effectiveDefaultProvider(): ProviderId {
  return isProviderUsable(state.defaultProvider) ? state.defaultProvider : DEFAULT_PROVIDER;
}

export async function setDefaultProvider(id: ProviderId): Promise<void> {
  await setPreference(PREF_KEY, id);
  set({ ...state, defaultProvider: id });
}
