import { getPreference, listProviders, setPreference, type ProviderInfo } from '../lib/ipc';
import { DEFAULT_PROVIDER, type ProviderId } from '../lib/symbols';

/** A live snapshot of which data providers are switched on and set up, and
 *  which one is the default. Data code — search, quotes, the providers
 *  themselves — isn't React and can't use hooks, so this small store is what
 *  they read; the settings screen and `useProviderState` subscribe to it. */

export interface ProviderState {
  providers: ProviderInfo[];
  /** The provider a bare ticker (or a typed-and-entered symbol) goes to. */
  defaultProvider: ProviderId;
  /** False until the first load from the backend. */
  loaded: boolean;
}

const PREF_KEY = 'default_provider';

let state: ProviderState = { providers: [], defaultProvider: DEFAULT_PROVIDER, loaded: false };
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

/** Providers that need the user's own account, or their agreement to a data
 *  source's terms (Yahoo Finance): never assumed ready. */
const OPT_IN = new Set<string>(['dhan', 'zerodha', 'yahoo']);

/** Enabled and fully set up. Before the first load, only what needs no setup
 *  or agreement counts, so an opt-in source is never assumed to be ready. */
export function isProviderUsable(id: string): boolean {
  const info = providerInfo(id);
  if (!info) return !state.loaded && !OPT_IN.has(id);
  return info.enabled && info.configured;
}

/** What a brand-new chart shows: a stock while Yahoo Finance is on, otherwise
 *  a crypto pair, which needs no setup. */
export function starterSymbol(): string {
  return isProviderUsable('yahoo') ? 'yahoo:AAPL' : 'binance:BTCUSDT';
}

/** Providers that can be searched right now. */
export const searchableProviders = (): ProviderInfo[] =>
  state.providers.filter((p) => p.capabilities.search && p.enabled && p.configured);

export async function refreshProviders(): Promise<void> {
  const [providers, stored] = await Promise.all([listProviders(), getPreference(PREF_KEY).catch(() => null)]);
  const defaultId = providers.some((p) => p.id === stored) ? (stored as ProviderId) : DEFAULT_PROVIDER;
  set({ providers, defaultProvider: defaultId, loaded: true });
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

/** The default falls back to Yahoo if the chosen provider is later switched off
 *  (and a Yahoo symbol then says that Yahoo is off, if it is). */
export function effectiveDefaultProvider(): ProviderId {
  return isProviderUsable(state.defaultProvider) ? state.defaultProvider : DEFAULT_PROVIDER;
}

export async function setDefaultProvider(id: ProviderId): Promise<void> {
  await setPreference(PREF_KEY, id);
  set({ ...state, defaultProvider: id });
}
