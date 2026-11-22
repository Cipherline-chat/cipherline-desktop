/**
 * Fully restart Cipherline (quit + start again), falling back to a page reload
 * where there is no desktop bridge (the website build, tests).
 *
 * WHY NOT A RELOAD: when the encrypted store could not be read, a page reload
 * runs in the same browser process, and Chromium keeps its IndexedDB backend —
 * including a backing store that failed to open, or files another program was
 * holding — for the life of that process. A reload then fails the same way.
 * A relaunch starts a new process that opens the database from scratch.
 *
 * Uses the existing `app:relaunch` handler (electron/main.ts), which quits
 * normally (before-quit flushes run, a downloaded update installs) and lets
 * Electron's relauncher start the app once this process has exited.
 */
export async function restartApp(): Promise<void> {
    const relaunch = typeof window !== 'undefined' ? window.electronAPI?.relaunchApp : undefined;
    if (typeof relaunch === 'function') {
        try {
            await relaunch();
            return;
        } catch (e) {
            console.warn('[restartApp] relaunch failed — reloading instead', e);
        }
    }
    if (typeof window !== 'undefined') window.location.reload();
}
