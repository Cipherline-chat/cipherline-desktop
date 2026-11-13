import { BrowserWindow, screen } from 'electron';
import { keyringNoticeHtml } from './keyring-notice-html';
import { walletNameForBackend } from './keyring-prompt';
import { keyringNoticeGuard } from './keyring-notice-guard';
import { lockPageZoom } from './page-zoom-lock';

/**
 * Put up the "your system is asking for your wallet password" window and hand
 * back the function that takes it down again. Linux, real keyring backends
 * only (SecureStore's probe hook decides, never this file).
 *
 * It MUST exist, and have painted, before the first safeStorage call: that call
 * blocks the main thread until the user answers the OS dialog, so nothing
 * created after it can appear. Measured with the real binary: a window created
 * a line before the blocking call never gets its first frame (a blank white
 * rectangle, on top of the wallet dialog). A window that has already painted
 * keeps painting and animating in its own renderer process while the main
 * thread is blocked. So this resolves only after `ready-to-show` plus a short
 * beat for the compositor to present the frame, bounded so a slow machine is
 * never held up for long.
 *
 * The page shows nothing for its first KEYRING_PROMPT_AFTER_MS (pure CSS, see
 * keyring-notice-html.ts), so a keyring that is already unlocked, and answers
 * in a few milliseconds, never shows the user anything: the disposer closes the
 * window first.
 *
 * Hardening matches every other window we open: sandboxed, context-isolated, no
 * node, NO preload, and no script at all (`javascript: false`), content
 * protection on, and it cannot take focus or mouse input.
 */
const PAINT_WAIT_MAX_MS = 1200;
/**
 * After the first paint and the show, how long the compositor gets to present
 * the surface (about nine frames at 60 Hz). On Wayland the surface is committed
 * and its frame callbacks answered on THIS thread, which the caller is about to
 * block, so the notice must be on screen before it does. Measured on real KDE
 * Plasma 6.8 Wayland: a notice created one line before the blocking call never
 * mapped at all.
 */
const PRESENT_BEAT_MS = 150;
const CARD_H = 160;

export interface KeyringNoticeOptions {
    /** The window is transparent so only the card shows. `false` is for a harness with no compositor. */
    transparent?: boolean;
    mode?: 'unlock' | 'create';
    /** true = the page's own 400 ms reveal (a prompt is NOT known to be coming). */
    delayed?: boolean;
}

export async function showKeyringNotice(
    backend: string,
    opts: KeyringNoticeOptions = {},
): Promise<() => void> {
    const transparent = opts.transparent !== false;
    const delayed = opts.delayed === true;
    // Top-centre of the work area, NOT the middle: the OS wallet dialog opens in
    // the middle of the screen and this must never sit on top of its password field.
    //
    // Wayland ignores x/y: KWin centres every new window. So a card-sized window
    // lands exactly under the (centred) wallet dialog. The window is therefore
    // as tall as the work area, transparent and click-through everywhere, with
    // the card pinned to its top edge: wherever the compositor puts the window,
    // the card is in the top strip, above the dialog. Without a compositor
    // (`transparent: false`) it is just the card.
    const W = 480;
    const wa = screen.getPrimaryDisplay().workArea;
    const H = transparent ? Math.max(CARD_H, wa.height) : CARD_H;
    const win = new BrowserWindow({
        width: W,
        height: H,
        x: Math.round(wa.x + (wa.width - W) / 2),
        y: transparent ? wa.y : wa.y + 16,
        show: false,
        frame: false,
        transparent,
        backgroundColor: transparent ? '#00000000' : '#0B0F1E',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        title: 'Cipherline',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            javascript: false,
            // In-memory session: nothing from this window is written to userData.
            partition: 'keyring-notice',
            webSecurity: true,
            backgroundThrottling: false,
        },
    });
    keyringNoticeGuard.opened();
    let closed = false;
    const dispose = () => {
        if (closed) return;
        closed = true;
        // Before the destroy: it makes Electron emit window-all-closed, which
        // main.ts would otherwise answer by quitting (see keyring-notice-guard.ts).
        keyringNoticeGuard.closed();
        try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
    };

    try {
        win.removeMenu();
        lockPageZoom(win.webContents);
        win.setContentProtection(true);
        win.setIgnoreMouseEvents(true);
        // Nothing may navigate this window or open another from it.
        win.webContents.on('will-navigate', e => e.preventDefault());
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

        // First paint (`ready-to-show`) AND a finished load, bounded.
        const once = (ev: 'ready-to-show' | 'did-finish-load') => new Promise<void>(resolve => {
            if (ev === 'ready-to-show') win.once('ready-to-show', () => resolve());
            else win.webContents.once('did-finish-load', () => resolve());
        });
        const painted = Promise.race([
            Promise.all([once('ready-to-show'), once('did-finish-load')]).then(() => undefined),
            new Promise<void>(resolve => setTimeout(resolve, PAINT_WAIT_MAX_MS)),
        ]);
        const html = keyringNoticeHtml(walletNameForBackend(backend), { mode: opts.mode, delayed, pinTop: transparent });
        void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => { /* cosmetic */ });
        await painted;
        if (win.isDestroyed()) return dispose;
        const shown = new Promise<void>(resolve => { win.once('show', () => resolve()); setTimeout(resolve, 400); });
        win.showInactive();
        await shown;
        await new Promise<void>(r => setTimeout(r, PRESENT_BEAT_MS));
    } catch {
        // A notice that cannot be built is not worth stopping the key store for.
        dispose();
    }
    return dispose;
}
