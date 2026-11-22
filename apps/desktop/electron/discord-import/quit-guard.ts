/**
 * "An import is running — quit anyway?" (owner 2026-11-22). The Discord import
 * runs in the background now (renderer: utils/discordImport/backgroundImport.ts);
 * quitting mid-import stops it (resume after a restart is out of scope), so the
 * user is asked first. What was copied stays either way.
 *
 * Asked BEFORE a quit starts, at the two user-facing entry points main owns
 * (the main window's close when it really closes, and the tray's Quit), never
 * from `before-quit`: by then every before-quit handler has already run (the
 * presence "going away" signal, the session marker, the RPC gate…) and a
 * cancelled quit would leave them half torn down.
 *
 * Pure of `electron` (the dialog is injected) so it is unit-tested.
 */

export interface QuitPromptOptions {
    type: 'warning';
    buttons: string[];
    defaultId: number;
    cancelId: number;
    title: string;
    message: string;
    detail: string;
    noLink: true;
}

export const QUIT_PROMPT: QuitPromptOptions = {
    type: 'warning',
    buttons: ['Keep importing', 'Quit anyway'],
    defaultId: 0,
    cancelId: 0,
    title: 'Import running',
    message: 'An import is running — quit anyway?',
    detail: 'It will stop and what’s copied stays.',
    noLink: true,
};
const QUIT_ANYWAY = 1;

export interface QuitGuard {
    /** The renderer's report (IPC `discord-import:running`). */
    setRunning(running: boolean): void;
    isRunning(): boolean;
    /**
     * Before a quit the user asked for. Resolves true = go ahead (nothing
     * running, or "Quit anyway"); false = stay. One question at a time: a
     * second request while the dialog is up gets the same answer.
     */
    confirmQuit(): Promise<boolean>;
}

export function createQuitGuard(ask: (opts: QuitPromptOptions) => Promise<{ response: number }>): QuitGuard {
    let running = false;
    let pending: Promise<boolean> | null = null;
    return {
        setRunning(v) { running = v === true; },
        isRunning: () => running,
        confirmQuit() {
            if (!running) return Promise.resolve(true);
            if (pending) return pending;
            pending = ask(QUIT_PROMPT)
                .then(r => r.response === QUIT_ANYWAY)
                // A dialog that cannot be shown must never trap the user in the app.
                .catch(() => true)
                .finally(() => { pending = null; });
            return pending;
        },
    };
}

/**
 * The main window's 'close': ask first only for a REAL close (not hidden to the
 * tray, where the import simply keeps going; not a quit already under way or
 * already confirmed) while an import runs.
 */
export function shouldAskBeforeClose(o: { isQuitting: boolean; hidesToTray: boolean; importRunning: boolean; confirmed: boolean }): boolean {
    return o.importRunning && !o.isQuitting && !o.hidesToTray && !o.confirmed;
}
