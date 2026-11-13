/**
 * The page the "your system is asking for your wallet password" window shows.
 *
 * Why a window of its own: the first `safeStorage` call of a Linux launch
 * blocks the main thread for as long as the OS wallet dialog is up, and the
 * main window does not exist yet (it is created after the key store opens). A
 * page that is ALREADY loaded in its own renderer process keeps painting while
 * the main thread is blocked, so the explanation has to be in a window that is
 * created before the call.
 *
 * The page is invisible for its first KEYRING_PROMPT_AFTER_MS (a pure CSS
 * animation delay: no script, so a locked-down CSP and nothing to attack). An
 * unlocked keyring answers in a few milliseconds, the window is closed before
 * it ever shows anything, and the user sees nothing at all. Only a call that
 * is still blocked after the delay (the OS dialog is up) reveals the notice.
 *
 * No network, no fonts from a CDN, no script. The wallet name is allow-listed.
 * No `electron` import (unit-testable).
 */

import { KEYRING_PROMPT_AFTER_MS } from './keyring-prompt';

const KNOWN_WALLETS: ReadonlySet<string> = new Set(['KDE Wallet', 'GNOME Keyring', 'system wallet']);

/** The notice body. Plain words; names the wallet the desktop is actually asking about. */
export function keyringNoticeCopy(walletName: string, mode: 'unlock' | 'create' = 'unlock'): { title: string; body: string } {
    const wallet = KNOWN_WALLETS.has(walletName) ? walletName : 'system wallet';
    if (mode === 'create') {
        return {
            title: `Create a ${wallet} so Cipherline can protect your keys`,
            body:
                `Cipherline keeps your encryption keys in your ${wallet} so they stay locked when you’re signed out, ` +
                'and you do not have one yet. Follow the steps in that window to create it.',
        };
    }
    return {
        title: `Your system is asking for your ${wallet} password`,
        body:
            `Cipherline keeps your encryption keys in your ${wallet} so they stay locked when you’re signed out. ` +
            'Enter your password in that window to continue.',
    };
}

export interface KeyringNoticeHtmlOptions {
    mode?: 'unlock' | 'create';
    /**
     * true  = the card stays invisible for KEYRING_PROMPT_AFTER_MS (the legacy
     *         path: we do not know a prompt is coming, an unlocked wallet answers
     *         first and the user never sees anything);
     * false = visible at once (a probe told us the prompt IS coming).
     */
    delayed?: boolean;
    /** The window is taller than the card (Wayland centres it): pin the card to the top. */
    pinTop?: boolean;
}

export function keyringNoticeHtml(walletName: string, opts: KeyringNoticeHtmlOptions = {}): string {
    const { title, body } = keyringNoticeCopy(walletName, opts.mode ?? 'unlock');
    const delayed = opts.delayed !== false;
    const revealMs = delayed ? KEYRING_PROMPT_AFTER_MS : 0;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Cipherline</title>
<style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body {
    display: flex; align-items: ${opts.pinTop ? 'flex-start' : 'center'}; justify-content: center;${opts.pinTop ? ' padding-top: 12px; box-sizing: border-box;' : ''}
    font-family: system-ui, -apple-system, 'Segoe UI', 'Noto Sans', 'Cantarell', sans-serif;
    -webkit-user-select: none; user-select: none;
  }
  @keyframes reveal { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .card {
    box-sizing: border-box; width: calc(100% - 24px); padding: 20px 22px;
    background: #131A30; color: #E8ECFA; border: 1px solid #2A3558; border-radius: 16px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
    ${delayed ? `opacity: 0;
    animation: reveal 220ms ease-out ${revealMs}ms forwards;` : 'opacity: 1;'}
  }
  .row { display: flex; gap: 14px; align-items: flex-start; }
  .icon {
    flex: none; width: 38px; height: 38px; border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255, 201, 77, 0.12); border: 1.5px solid rgba(255, 201, 77, 0.32);
  }
  h1 { margin: 0 0 6px; font-size: 15px; font-weight: 700; line-height: 1.3; }
  p { margin: 0; font-size: 13px; line-height: 1.5; color: #A9B3D6; }
  @media (prefers-reduced-motion: reduce) { .card { animation-duration: 1ms; } }
</style>
</head>
<body>
<div class="card" role="status" aria-live="polite">
  <div class="row">
    <div class="icon" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#FFC94D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3"/><path d="m16 7 3 3"/><path d="m18 5 2 2"/></svg>
    </div>
    <div>
      <h1>${title}</h1>
      <p>${body}</p>
    </div>
  </div>
</div>
</body>
</html>`;
}
