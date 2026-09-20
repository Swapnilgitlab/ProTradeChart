import { check } from '@tauri-apps/plugin-updater';
import { notify } from '../data/events';
import { getPreference, restartApp } from '../lib/ipc';
import { startAutoUpdates } from './autoCheck';
import { AUTO_UPDATE_PREFERENCE, Updater } from './updater';

/** The app's one updater. Every window has its own copy of this module, so each window's
 *  About dialog checks and installs on its own. */
export const updater = new Updater({
  async check() {
    const update = await check();
    if (!update) return null;
    return {
      version: update.version,
      date: update.date ?? null,
      downloadAndInstall: (onEvent) => update.downloadAndInstall(onEvent),
    };
  },
  restart: restartApp,
});

/** Starts the background check. Only the main window calls this, so a second window
 *  doesn't announce the same update again. There is nothing to find in a dev build. */
export function startBackgroundUpdates(): () => void {
  if (import.meta.env.DEV) return () => {};
  return startAutoUpdates({
    updater,
    readPreference: () => getPreference(AUTO_UPDATE_PREFERENCE),
    announce: (version) => notify('info', `ProTradeChart ${version} is available. Open About to install it.`),
  });
}
