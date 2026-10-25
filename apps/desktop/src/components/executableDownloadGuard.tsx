/**
 * Saving a received file: the name offered to the OS is stripped of bidi and
 * control characters (utils/fileSafety.ts), and a file whose extension runs
 * code (.exe, .bat, .js, .dmg, …) needs one explicit confirmation first.
 *
 * Imperative on purpose: the save buttons live in several places (the file
 * card, the message context menu, the shared-content gallery), so each calls
 * `saveReceivedFile` instead of carrying its own dialog state. The dialog is
 * the app's own ConfirmDialog — not `window.confirm`, which breaks Electron's
 * window-focus handling.
 */
import { createRoot } from 'react-dom/client';
import { ConfirmDialog } from './primitives/ConfirmDialog';
import { effectiveExtension, isExecutableFilename, safeDisplayFilename } from '../utils/fileSafety';

/** Resolves true when the file may be saved (always, unless it is executable and the user cancels). */
export function confirmExecutableDownload(filename: unknown): Promise<boolean> {
    if (!isExecutableFilename(filename) || typeof document === 'undefined') return Promise.resolve(true);
    const name = safeDisplayFilename(filename);
    const ext = effectiveExtension(filename);
    return new Promise<boolean>(resolve => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const root = createRoot(host);
        let settled = false;
        const done = (ok: boolean) => {
            if (settled) return;
            settled = true;
            resolve(ok);
            setTimeout(() => { root.unmount(); host.remove(); }, 0);
        };
        root.render(
            <ConfirmDialog
                title={`Save “${name}”?`}
                message={`This is a .${ext} file: opening it can run a program on your computer. Only save it if you trust the sender and were expecting it.`}
                confirmLabel="Save anyway"
                onConfirm={() => done(true)}
                onCancel={() => done(false)}
            />,
        );
    });
}

/** Save `url` under the sender's filename, made safe, after the executable check. */
export async function saveReceivedFile(url: string, filename: unknown): Promise<boolean> {
    if (!(await confirmExecutableDownload(filename))) return false;
    const a = document.createElement('a');
    a.href = url;
    a.download = safeDisplayFilename(filename);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
}
