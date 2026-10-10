import { describe, expect, it, vi } from 'vitest';
import {
  Updater,
  autoCheckEnabled,
  describeUpdateError,
  isNoRelease,
  progressPercent,
  type DownloadEvent,
  type UpdateOffer,
  type UpdateState,
} from './updater';

function offerOf(version: string, run?: (on: (event: DownloadEvent) => void) => Promise<void>): UpdateOffer {
  return { version, date: '2026-10-01T00:00:00Z', downloadAndInstall: run ?? (async () => {}) };
}

function updaterWith(check: () => Promise<UpdateOffer | null>) {
  const restart = vi.fn(async () => {});
  return { updater: new Updater({ check, restart }), restart };
}

describe('autoCheckEnabled', () => {
  it('is on unless the preference says off', () => {
    expect(autoCheckEnabled(null)).toBe(true);
    expect(autoCheckEnabled('on')).toBe(true);
    expect(autoCheckEnabled('')).toBe(true);
    expect(autoCheckEnabled('off')).toBe(false);
  });
});

describe('progressPercent', () => {
  it('is a rounded percentage', () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(1, 3)).toBe(33);
  });
  it('never passes 100', () => {
    expect(progressPercent(300, 200)).toBe(100);
  });
  it('is null when the size is unknown', () => {
    expect(progressPercent(50, null)).toBeNull();
    expect(progressPercent(50, 0)).toBeNull();
  });
});

describe('describeUpdateError', () => {
  it('explains a failed signature check without alarming detail', () => {
    expect(describeUpdateError(new Error('signature verification failed'), 'install')).toMatch(/security check/);
  });
  it('explains an unreachable server differently for a check and for a download', () => {
    const error = new Error('error sending request for url (https://github.com/x/latest.json)');
    expect(describeUpdateError(error, 'check')).toMatch(/Couldn't reach the update server/);
    expect(describeUpdateError(error, 'install')).toMatch(/downloaded/);
  });
  it('treats a missing download as a failed download', () => {
    expect(describeUpdateError(new Error('Download request failed with status: 404 Not Found'), 'install')).toMatch(/downloaded/);
  });
});

describe('isNoRelease', () => {
  it("recognises the plugin's answer to a 404, and nothing that is a real failure", () => {
    expect(isNoRelease(new Error('Could not fetch a valid release JSON from the remote'))).toBe(true);
    expect(isNoRelease(new Error('error sending request for url (https://github.com/x/latest.json)'))).toBe(false);
    expect(isNoRelease(new Error('signature verification failed'))).toBe(false);
  });
  it('keeps the detail for anything unrecognised', () => {
    expect(describeUpdateError('disk is full', 'install')).toContain('disk is full');
    expect(describeUpdateError(new Error('odd'), 'check')).toContain('odd');
  });
});

describe('Updater.check', () => {
  it('reports up to date when there is no newer release', async () => {
    const { updater } = updaterWith(async () => null);
    await updater.check();
    expect(updater.getState()).toEqual({ kind: 'current' });
  });

  it('offers a newer release', async () => {
    const { updater } = updaterWith(async () => offerOf('0.2.0'));
    await updater.check();
    expect(updater.getState()).toEqual({ kind: 'available', version: '0.2.0', date: '2026-10-01T00:00:00Z' });
  });

  it('reports up to date when the server has no published release', async () => {
    const noRelease = async () => {
      throw new Error('Could not fetch a valid release JSON from the remote');
    };
    const { updater } = updaterWith(noRelease);
    await updater.check();
    expect(updater.getState()).toEqual({ kind: 'current' });
    const background = updaterWith(noRelease).updater;
    await background.check(true);
    expect(background.getState()).toEqual({ kind: 'current' });
  });

  it('shows why a manual check failed', async () => {
    const { updater } = updaterWith(async () => {
      throw new Error('error sending request');
    });
    await updater.check();
    expect(updater.getState()).toMatchObject({ kind: 'error', during: 'check' });
  });

  it('says nothing when a background check fails', async () => {
    const { updater } = updaterWith(async () => {
      throw new Error('error sending request');
    });
    await updater.check(true);
    expect(updater.getState()).toEqual({ kind: 'idle' });
  });

  it('shows the checking state while it waits, and ignores a second check', async () => {
    let finish: (offer: UpdateOffer | null) => void = () => {};
    const check = vi.fn(() => new Promise<UpdateOffer | null>((resolve) => (finish = resolve)));
    const { updater } = updaterWith(check);
    const first = updater.check();
    expect(updater.getState()).toEqual({ kind: 'checking' });
    await updater.check();
    expect(check).toHaveBeenCalledTimes(1);
    finish(null);
    await first;
    expect(updater.getState()).toEqual({ kind: 'current' });
  });

  it('leaves an offer alone when asked to check again', async () => {
    const check = vi.fn(async () => offerOf('0.2.0'));
    const { updater } = updaterWith(check);
    await updater.check();
    await updater.check();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('tells subscribers about every change, until they unsubscribe', async () => {
    const { updater } = updaterWith(async () => null);
    const seen: UpdateState['kind'][] = [];
    const off = updater.subscribe(() => seen.push(updater.getState().kind));
    await updater.check();
    off();
    await updater.check();
    expect(seen).toEqual(['checking', 'current']);
  });
});

describe('Updater.install', () => {
  it('tracks download progress and ends installed', async () => {
    const states: UpdateState[] = [];
    const { updater } = updaterWith(async () =>
      offerOf('0.2.0', async (on) => {
        on({ event: 'Started', data: { contentLength: 1000 } });
        on({ event: 'Progress', data: { chunkLength: 250 } });
        on({ event: 'Progress', data: { chunkLength: 250 } });
        on({ event: 'Finished' });
      }),
    );
    await updater.check();
    updater.subscribe(() => states.push(updater.getState()));
    await updater.install();

    const downloading = states.filter((s) => s.kind === 'downloading');
    expect(downloading[downloading.length - 1]).toEqual({ kind: 'downloading', version: '0.2.0', received: 500, total: 1000 });
    expect(updater.getState()).toEqual({ kind: 'installed', version: '0.2.0' });
  });

  it('copes with a download of unknown size', async () => {
    const { updater } = updaterWith(async () =>
      offerOf('0.2.0', async (on) => {
        on({ event: 'Started', data: {} });
        on({ event: 'Progress', data: { chunkLength: 10 } });
      }),
    );
    await updater.check();
    const states: UpdateState[] = [];
    updater.subscribe(() => states.push(updater.getState()));
    await updater.install();
    expect(states.some((s) => s.kind === 'downloading' && s.total === null && s.received === 10)).toBe(true);
  });

  it('reports a failed install and lets the user try again', async () => {
    let attempts = 0;
    const { updater } = updaterWith(async () =>
      offerOf('0.2.0', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('signature verification failed');
      }),
    );
    await updater.check();
    await updater.install();
    expect(updater.getState()).toMatchObject({ kind: 'error', during: 'install' });

    await updater.install();
    expect(attempts).toBe(2);
    expect(updater.getState()).toEqual({ kind: 'installed', version: '0.2.0' });
  });

  it('does nothing without an offer', async () => {
    const { updater } = updaterWith(async () => null);
    await updater.install();
    expect(updater.getState()).toEqual({ kind: 'idle' });
    await updater.check();
    await updater.install();
    expect(updater.getState()).toEqual({ kind: 'current' });
  });

  it('does not start a second download while one is running', async () => {
    let calls = 0;
    let finish: () => void = () => {};
    const { updater } = updaterWith(async () =>
      offerOf('0.2.0', () => {
        calls += 1;
        return new Promise<void>((resolve) => (finish = resolve));
      }),
    );
    await updater.check();
    const first = updater.install();
    await updater.install();
    expect(calls).toBe(1);
    finish();
    await first;
  });
});

describe('Updater.restart', () => {
  it('asks the app to restart', async () => {
    const { updater, restart } = updaterWith(async () => null);
    await updater.restart();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});
