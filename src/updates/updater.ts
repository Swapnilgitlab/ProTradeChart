/** The auto-updater's state machine. It knows nothing about Tauri: the plugin (which asks
 *  GitHub for the newest release, downloads it, and checks its signature against the key
 *  built into the app) and the restart are handed in, so the rules run without either. */

/** The part of the plugin's `DownloadEvent` we react to. */
export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

/** A newer release the plugin found. */
export interface UpdateOffer {
  version: string;
  /** ISO date the release was published, when the manifest says. */
  date: string | null;
  downloadAndInstall(onEvent: (event: DownloadEvent) => void): Promise<void>;
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; version: string; date: string | null }
  | { kind: 'downloading'; version: string; received: number; total: number | null }
  | { kind: 'installed'; version: string }
  | { kind: 'error'; message: string; during: 'check' | 'install' };

export interface UpdaterDeps {
  /** Resolves to `null` when the app is already the newest release. */
  check(): Promise<UpdateOffer | null>;
  restart(): Promise<void>;
}

/** The preference that turns the background check off. Anything but `off` means on: a
 *  new install, or a preference that couldn't be read, checks. */
export const AUTO_UPDATE_PREFERENCE = 'autoUpdateCheck';

export function autoCheckEnabled(preference: string | null): boolean {
  return preference !== 'off';
}

/** 0–100, or null when the download size isn't known (the server sent no length). */
export function progressPercent(received: number, total: number | null): number | null {
  if (total === null || total <= 0) return null;
  return Math.min(100, Math.round((received / total) * 100));
}

/** What to tell the user about a failure. The plugin's own messages are terse and
 *  technical, so the common causes get plain wording and the rest keep the detail. */
export function describeUpdateError(error: unknown, during: 'check' | 'install'): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/signature|verif/i.test(raw)) {
    return "The downloaded update didn't pass its security check, so it was not installed. Try again later.";
  }
  if (/release json|404|not found|network|dns|connect|timed? ?out|error sending request|offline/i.test(raw)) {
    return during === 'check'
      ? "Couldn't reach the update server. Check your connection and try again."
      : "The update couldn't be downloaded. Check your connection and try again.";
  }
  return during === 'check' ? `Couldn't check for updates: ${raw}` : `The update couldn't be installed: ${raw}`;
}

type Listener = () => void;

export class Updater {
  private state: UpdateState = { kind: 'idle' };
  private offer: UpdateOffer | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: UpdaterDeps) {}

  /** Arrow properties so they can be handed straight to `useSyncExternalStore`. */
  readonly getState = (): UpdateState => this.state;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(state: UpdateState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  /** Looks for a newer release. `quiet` is for the background check: a failure (offline,
   *  no release yet) leaves the state alone instead of showing an error nobody asked for. */
  async check(quiet = false): Promise<void> {
    const before = this.state;
    // Once an update is on offer or being installed, another look would only disturb it.
    if (before.kind === 'checking' || before.kind === 'available' || before.kind === 'downloading' || before.kind === 'installed') {
      return;
    }
    this.set({ kind: 'checking' });
    try {
      const offer = await this.deps.check();
      if (offer) {
        this.offer = offer;
        this.set({ kind: 'available', version: offer.version, date: offer.date });
      } else {
        this.offer = null;
        this.set({ kind: 'current' });
      }
    } catch (error) {
      if (quiet) this.set(before);
      else this.set({ kind: 'error', during: 'check', message: describeUpdateError(error, 'check') });
    }
  }

  /** Downloads the offered update and installs it. On Windows the installer takes over and
   *  closes the app; elsewhere the state becomes `installed` and the user restarts. */
  async install(): Promise<void> {
    const offer = this.offer;
    const state = this.state;
    if (!offer) return;
    // A failed install can be retried; anything else that isn't an offer can't.
    if (state.kind !== 'available' && !(state.kind === 'error' && state.during === 'install')) return;

    const version = offer.version;
    let received = 0;
    let total: number | null = null;
    this.set({ kind: 'downloading', version, received, total });
    try {
      await offer.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? null;
        else if (event.event === 'Progress') received += event.data.chunkLength;
        else return;
        this.set({ kind: 'downloading', version, received, total });
      });
      this.set({ kind: 'installed', version });
    } catch (error) {
      this.set({ kind: 'error', during: 'install', message: describeUpdateError(error, 'install') });
    }
  }

  async restart(): Promise<void> {
    await this.deps.restart();
  }
}
