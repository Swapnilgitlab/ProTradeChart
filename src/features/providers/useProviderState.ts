import { useSyncExternalStore } from 'react';
import { getProviderState, subscribeProviderState, type ProviderState } from '../../data/providerStatus';

/** The current provider state, re-rendering when it changes. */
export function useProviderState(): ProviderState {
  return useSyncExternalStore(subscribeProviderState, getProviderState);
}
