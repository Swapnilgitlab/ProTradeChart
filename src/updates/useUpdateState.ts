import { useSyncExternalStore } from 'react';
import { updater } from './service';
import type { UpdateState } from './updater';

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(updater.subscribe, updater.getState);
}
