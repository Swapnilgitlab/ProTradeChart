import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { notify } from '../data/events';
import { formatPrice } from '../lib/format';
import { getPreference } from '../lib/ipc';
import type { PriceAlert } from '../lib/ipc';
import { displayTicker } from '../lib/symbols';
import { announcement } from './logic';

/** Tells the user an alert fired: a toast in the app, a system notification
 *  (which reaches them when the app is minimised or behind other windows), and
 *  a short chime. Each channel fails on its own: a machine that won't show
 *  notifications or play sound still gets the toast. */

/** The preference holding whether alerts chime; on unless switched off. */
export const SOUND_PREFERENCE = 'alert_sound';

export async function soundEnabled(): Promise<boolean> {
  try {
    return (await getPreference(SOUND_PREFERENCE)) !== '0';
  } catch {
    return true;
  }
}

/** Two short rising tones, made on the spot so no sound file has to ship. */
function playChime(): void {
  try {
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const audio = new Context();
    void audio.resume();
    const start = audio.currentTime;
    [
      [880, 0],
      [1320, 0.16],
    ].forEach(([frequency, offset]) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.35);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.4);
    });
    window.setTimeout(() => void audio.close(), 1200);
  } catch {
    // No audio device, or the webview refused: the toast still shows.
  }
}

async function systemNotification(title: string, body: string): Promise<void> {
  try {
    let allowed = await isPermissionGranted();
    if (!allowed) allowed = (await requestPermission()) === 'granted';
    if (allowed) sendNotification({ title, body });
  } catch {
    // Notifications unavailable here; the in-app toast covers it.
  }
}

export async function announceAlert(alert: PriceAlert, price: number): Promise<void> {
  const { title, body } = announcement(alert, formatPrice(price), formatPrice(alert.price), displayTicker(alert.symbol));
  notify('alert', body);
  void systemNotification(title, body);
  if (await soundEnabled()) playChime();
}
