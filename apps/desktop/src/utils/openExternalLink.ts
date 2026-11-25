/**
 * Single, validated entry point for opening a URL outside the app. Message
 * content (and embeds, profiles, presence) is genuinely user-controlled —
 * the real case CLAUDE.md means by "never shell.openExternal() a
 * user-controlled URL unvalidated."
 *
 * ChatPane.tsx and SharedContentModal.tsx each had their own copy of this
 * (`function openUrl`) — duplicated, and neither validated the URL before
 * handing it to window.open() in the non-Electron fallback branch. That
 * fallback is realistically unreachable in this app (window.electronAPI is
 * always present in a packaged/dev Electron session, and neither of those
 * components is reused by the website), but "unreachable today" isn't a
 * reason to leave an unvalidated shell.openExternal-adjacent path sitting in
 * the code.
 *
 * The actual electron/main.ts IPC handler (shell:open-external) already
 * restricts to https:/mailto: only — deliberately, per its own comment ("http
 * removed to prevent MITM downgrade", an L2 security-audit finding). That
 * restriction is correct and this file does NOT relax it. What it adds:
 *   - The SAME check applied client-side, before firing the IPC call, so a
 *     rejected URL (e.g. a plain http:// link) can report back WHY nothing
 *     happened instead of a silent no-op.
 *   - The identical check applied to the window.open() fallback.
 *
 * LEAVING-CIPHERLINE GATE (owner: "if it's a link that isn't trusted and you
 * open it, have a warning about leaving cipherline"). Every content link —
 * message text, masked `[label](url)` links, embeds, the lightbox's "Open
 * original", profile and rich-presence links — comes through here, so this is
 * where the gate lives rather than at each call site:
 *   - a destination that is not trusted (utils/externalLinks/trustedDomains
 *     .ts: cipherline.chat built in, plus the account's own "Trusted
 *     websites") raises the "You're leaving Cipherline" dialog
 *     (components/LeavingCipherlineDialog.tsx) instead of opening; only its
 *     Visit button opens, and only the request the gate itself recorded;
 *   - a masked link whose text names a different site ALWAYS raises it, even
 *     for a trusted destination, with the mismatch spelled out;
 *   - nothing opens, and no dialog is raised, without a live user gesture
 *     (`navigator.userActivation`), so content that reaches this function
 *     outside a click gets `no-user-gesture`, never a browser tab.
 * The account can turn the dialog down (Settings → Privacy → "Warn before
 * opening links", with "Still warn about suspicious links" under it) or off
 * entirely; the real-click requirement is never configurable.
 * `source: 'app'` is for destinations written by Cipherline's own code (an
 * OAuth sign-in the user just started, a Stripe receipt our server returned,
 * the update download): they skip the dialog, keep the scheme check, and
 * must never be passed anything from a message, embed, profile or presence.
 */
import { describeExternalLink } from './externalLinks/describeLink';
import { hasLeaveHost, requestLeave } from './externalLinks/leaveGate';
import { hasUserGesture, sendToShell } from './externalLinks/shellOpen';
import { getLinkWarningPrefs } from './externalLinks/linkWarningPrefs';

/** Schemes electron/main.ts's shell:open-external handler will actually act
 *  on. Kept in sync with that allowlist by hand — duplicating a one-line
 *  constant across the IPC boundary rather than adding a round-trip just to
 *  ask the main process what it allows. */
const ALLOWED_SCHEMES = new Set(['https:', 'mailto:']);

export interface OpenExternalOptions {
    /**
     * The link's VISIBLE text when it differs from the URL (a masked
     * `[label](url)` link). If it names another site the dialog says so.
     */
    label?: string;
    /**
     * 'content' (default): anything from a message, embed, profile or
     * presence — gated. 'app': a destination authored by Cipherline's own
     * code (see the file comment) — scheme-checked, no dialog.
     */
    source?: 'content' | 'app';
}

export type OpenExternalResult =
    | { ok: true; opened: 'now' | 'after-confirm' }
    | { ok: false; reason: 'unparseable' | 'disallowed-scheme' | 'no-user-gesture' | 'no-confirm-host' };

/**
 * Settings → Privacy (linkWarningPrefs.ts): with "Warn before opening links"
 * ON every untrusted link asks; OFF, only a suspicious one does, and only while
 * "Still warn about suspicious links" is ON. Both OFF = never warn.
 */
function needsDialog(suspicious: boolean): boolean {
    const prefs = getLinkWarningPrefs();
    if (prefs.warn) return true;
    return suspicious && prefs.warnSuspicious;
}

/**
 * Validate and open (or ask before opening) a URL. Never throws.
 *
 * `ok: true` with `opened: 'after-confirm'` means the leaving-Cipherline
 * dialog is now showing; whether the user then visits is theirs to decide.
 * Does not await the Electron IPC round-trip — callers are synchronous
 * click/keydown handlers with nothing meaningful to do while it's in flight.
 */
export function openExternalLink(url: string, opts: OpenExternalOptions = {}): OpenExternalResult {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return { ok: false, reason: 'unparseable' };
    }
    if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
        return { ok: false, reason: 'disallowed-scheme' };
    }

    // The scheme check above ran on `parsed`, so `parsed.href` — the
    // normalised, validated form — is what reaches the OS, never the raw
    // input string. (For an https/mailto URL it is the same link, with the
    // parser's canonical spelling: a bare origin gains its trailing slash.)
    if (opts.source === 'app') {
        sendToShell(parsed.href);
        return { ok: true, opened: 'now' };
    }

    // The real-click requirement holds whatever the warning settings say.
    if (!hasUserGesture()) return { ok: false, reason: 'no-user-gesture' };
    const model = describeExternalLink(parsed, { label: opts.label });
    if (model.trusted || !needsDialog(model.suspicious)) {
        sendToShell(model.href);
        return { ok: true, opened: 'now' };
    }
    if (!hasLeaveHost()) return { ok: false, reason: 'no-confirm-host' };
    requestLeave(model);
    return { ok: true, opened: 'after-confirm' };
}
