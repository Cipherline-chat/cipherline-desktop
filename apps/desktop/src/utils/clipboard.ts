export async function writeToClipboard(text: string): Promise<void> {
    // Tier 1: Electron IPC → main-process clipboard module (no permission required)
    if (window.electronAPI?.writeClipboard) {
        try {
            await window.electronAPI.writeClipboard(text);
            return;
        } catch {
            // fall through
        }
    }

    // Tier 2: Web Clipboard API (works in browser dev / non-Electron contexts)
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // fall through
        }
    }

    // Tier 3: execCommand — synchronous, works in any Chromium sandbox without permissions
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;pointer-events:none';
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    if (!ok) throw new Error('clipboard write failed');
}

/**
 * Boolean-returning wrapper over {@link writeToClipboard} for copy buttons.
 * `true` = the text is on the clipboard; `false` = every tier failed, so the
 * caller MUST show a visible fallback (select/show the text) instead of a
 * silent no-op. Never call `navigator.clipboard` directly from a component:
 * the packaged app's permission handler denies it
 * (electron/permission-policy.ts, decidePermissionRequest `default: return false`),
 * and the ratchet in clipboard.noDirect.test.ts enforces that.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        await writeToClipboard(text);
        return true;
    } catch {
        return false;
    }
}
