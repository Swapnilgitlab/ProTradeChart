import { openUrl } from '@tauri-apps/plugin-opener';

/** In a Tauri webview a plain `<a href="https://…">` would navigate the app
 *  window itself away from the UI. This intercepts every such click — including
 *  the ones rendered by Vela, like its attribution mark — and hands the URL to
 *  the user's default browser instead. Returns a cleanup function. */
export function installExternalLinkHandler(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    openUrl(href).catch(() => {});
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
