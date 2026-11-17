import { BrowserWindow } from 'electron';
import { applyingUpdateHtml, applyingUpdateWindowPlan } from './update-applying';
import { lockPageZoom } from './page-zoom-lock';

/**
 * Open the small "Applying update" popup (page: update-applying.ts) and return
 * its closer. Throws when the window cannot be built; the caller treats that as
 * "no popup" and installs immediately.
 *
 * Hardening matches every other window we open: sandboxed, context-isolated, no
 * node, NO preload, `javascript: false` (the page is pure CSS), in-memory
 * session, content protection on, no navigation, no child windows, no remote
 * content (a data: URL under a default-src 'none' CSP), not focusable, and it
 * ignores mouse input.
 */
export function openApplyingUpdateWindow(version: string): () => void {
    // Looks like the installer splash. Windows / macOS: a transparent window with
    // the card floating in it (the installer splash's own window options). Linux:
    // an opaque window the card fills edge to edge, because without a compositor a
    // transparent window paints black there. applyingUpdateWindowPlan says why.
    const plan = applyingUpdateWindowPlan(process.platform);
    const win = new BrowserWindow({
        width: plan.width,
        height: plan.height,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        frame: false,
        show: false,
        center: true,
        skipTaskbar: true,
        alwaysOnTop: true,
        focusable: false,
        transparent: plan.transparent,
        backgroundColor: plan.backgroundColor,
        // roundedCorners is left at its default (true), as the installer splash
        // does: on Linux that is the desktop's own rounding where it has one (CSD).
        title: 'Cipherline',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            javascript: false,
            partition: 'applying-update',
            webSecurity: true,
            backgroundThrottling: false,
        },
    });
    const close = () => { try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ } };
    try {
        win.removeMenu();
        lockPageZoom(win.webContents);
        win.setContentProtection(true);
        win.setIgnoreMouseEvents(true);
        win.webContents.on('will-navigate', e => e.preventDefault());
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        // Show on first paint so the bar animation does not start before it is visible.
        const reveal = () => { try { if (!win.isDestroyed() && !win.isVisible()) win.showInactive(); } catch { /* closing */ } };
        win.once('ready-to-show', reveal);
        setTimeout(reveal, 500).unref?.(); // a paint that never reports must not leave the screen empty
        const page = applyingUpdateHtml(version, plan.page);
        win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page)).catch(() => { /* cosmetic */ });
    } catch (e) {
        close();
        throw e;
    }
    return close;
}
