/**
 * Single, validated entry point for opening a URL found in MESSAGE CONTENT —
 * i.e. genuinely user-controlled, unlike the Stripe checkout/portal URLs
 * elsewhere in the app, which come from our own server and only need a
 * scheme sanity-check as defence in depth. This one is the real case CLAUDE.md
 * means by "never shell.openExternal() a user-controlled URL unvalidated."
 *
 * ChatPane.tsx and SharedContentModal.tsx each had their own copy of this
 * (`function openUrl`) — duplicated, and neither validated the URL before
 * handing it to window.open() in the non-Electron fallback branch. That
 * fallback is realistically unreachable in this app (window.electronAPI is
 * always present in a packaged/dev Electron session, and neither of those
 * components is reused by the website), but "unreachable today" isn't a
 * reason to leave an unvalidated shell.openExternal-adjacent path sitting in
 * the code — the assumption that it's unreachable is exactly the kind of
 * thing that stops being true after a refactor nobody thought to re-check
 * against this file.
 *
 * The actual electron/main.ts IPC handler (shell:open-external) already
 * restricts to https:/mailto: only — deliberately, per its own comment ("http
 * removed to prevent MITM downgrade", an L2 security-audit finding). That
 * restriction is correct and this file does NOT relax it. What it adds:
 *   - The SAME check applied client-side, before firing the IPC call, so a
 *     rejected URL (e.g. a plain http:// link, which the URL-detection regex
 *     in both callers happily matches) can report back WHY nothing happened,
 *     instead of the previous silent no-op — the main process's handler has
 *     no return value and no error path, so a rejected call there is
 *     indistinguishable from a slow one.
 *   - The identical check applied to the window.open() fallback, which
 *     previously had none at all.
 */

/** Schemes electron/main.ts's shell:open-external handler will actually act
 *  on. Kept in sync with that allowlist by hand — duplicating a one-line
 *  constant across the IPC boundary rather than adding a round-trip just to
 *  ask the main process what it allows. */
const ALLOWED_SCHEMES = new Set(['https:', 'mailto:']);

export type OpenExternalResult =
    | { ok: true }
    | { ok: false; reason: 'unparseable' | 'disallowed-scheme' };

/**
 * Validate and open a user-controlled URL. Never throws.
 *
 * Does not await the Electron IPC round-trip — callers here are synchronous
 * click/keydown handlers with nothing meaningful to do while it's in flight,
 * matching the previous fire-and-forget behaviour.
 */
export function openExternalLink(url: string): OpenExternalResult {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: 'unparseable' };
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        return { ok: false, reason: 'disallowed-scheme' };
    }

    if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
        void window.electronAPI.openExternal(url).catch(() => { /* main process already logs failures */ });
    } else {
        // Realistically dead in this app (see file doc comment) — kept as a
        // safety net rather than assuming the invariant holds forever.
        window.open(url, '_blank', 'noopener,noreferrer');
    }
    return { ok: true };
}
