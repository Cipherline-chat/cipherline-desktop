/**
 * capture-consent — who may start a screen / window / app-audio capture.
 *
 * THE PROBLEM (security audit E-5). The share "picker" is renderer UI, and main
 * used to grant whatever source the renderer named: `getDisplayMedia()` was
 * forwarded to the renderer, the renderer answered with any enumerated source
 * id, and `audio:start-window-capture` started per-process / whole-system audio
 * on a bare pid. Code running in a compromised renderer could therefore capture
 * the screen or the system's audio with no prompt (Windows/Linux; macOS only
 * has the one-time TCC grant). Camera/microphone are an accepted, separate risk.
 *
 * THE SHAPE OF THE FIX (owner decision "option C"):
 *
 *   1. When the user picks a source in OUR picker, the renderer asks main to
 *      MINT a capture grant for exactly that source (and whether audio was
 *      chosen). Main returns an opaque, unguessable, short-lived token and keeps
 *      the grant keyed by the asking webContents.
 *   2. The capture that follows (`desktop-capturer-resolve`, i.e. the
 *      getDisplayMedia answer, and `audio:start-window-capture`) must present
 *      that token. Each grant is single-use per capture kind (one video
 *      resolve, one audio start), expires after GRANT_TTL_MS, is bound to the
 *      sender, and is bound to the source id.
 *   3. A capture request WITHOUT a valid grant - none, replayed, expired,
 *      another window's, for another source - is not refused outright and is not
 *      silently honoured: main shows a NATIVE confirmation ("Cipherline wants
 *      to share your screen: <source name>", Don't allow is the default,
 *      dismiss = deny). The name is main's own, never the renderer's.
 *
 * THE HONEST LIMIT. A grant is minted by a message from the renderer, so on its
 * own it would stop nothing: a compromised renderer can mint one itself. What
 * makes the grant mean "the user just chose this" is a signal the renderer
 * cannot forge, which Electron does give us: `webContents` 'input-event' fires
 * in the browser process for REAL input (mouse button, key, touch) and is not
 * reachable from page JavaScript (a synthetic `dispatchEvent` or `.click()`
 * never produces one). main records the time of the last real input per
 * webContents (and of main-originated triggers: the global shortcut). A grant
 * minted within PRESENCE_WINDOW_MS of such input is TRUSTED and is consumed
 * silently; a grant minted without it is UNTRUSTED and its consumption goes
 * through the native dialog (once - allowing it covers the audio start of the
 * same share). So the normal flow (our share button -> our picker -> share)
 * stays click-free, and a hostile script has to wait for the user's next real
 * click before it can use the grant path silently. That residual (a hostile
 * renderer riding a click the user made for something else, within ~10 s) is
 * recorded in the report; it is the price of not adding a click to every share.
 *
 * AUTOMATIC RE-SHARES. The app re-publishes a share on its own when the
 * encoder stalls or the H.264 High encoder produces no frames. Those arrive
 * with no user input, so a grant for the SAME source the user was sharing a
 * moment ago (CONTINUATION_MS since the last allowed capture) is treated as
 * trusted. It adds nothing a renderer that already holds the live stream
 * doesn't have.
 *
 * DIALOG FATIGUE. At most one prompt on screen; a "Don't allow" silences the
 * prompt for DECLINE_COOLDOWN_MS (requests in that window are denied without
 * asking), same shape as recovery-key-gate.ts.
 *
 * Free of any `electron` import so it is unit-testable (capture-consent.test.ts);
 * main.ts injects the real dialog.
 */

import * as nodeCrypto from 'node:crypto';

/** A grant must be spent on the video capture within this long of being minted. */
export const GRANT_TTL_MS = 30_000;
/** After the video capture used the grant, the audio start may follow within this long. */
export const AUDIO_AFTER_VIDEO_MS = 120_000;
/** Real input this recent makes a freshly minted grant trusted. */
export const PRESENCE_WINDOW_MS = 10_000;
/** A grant for the source allowed this recently (automatic republish) is trusted without new input. */
export const CONTINUATION_MS = 120_000;
/** After "Don't allow", further prompts are skipped (and denied) for this long. */
export const DECLINE_COOLDOWN_MS = 30_000;
/** Outstanding grants per webContents; the oldest is dropped beyond this. */
export const MAX_OUTSTANDING_PER_SENDER = 8;

/** Electron desktopCapturer ids look like `screen:0:0` / `window:132456:0`. */
const SOURCE_ID_RE = /^(screen|window):[A-Za-z0-9_.:-]{1,80}$/;
export function isCaptureSourceId(v: unknown): v is string {
    return typeof v === 'string' && SOURCE_ID_RE.test(v);
}

export type ConsentPrompt =
    | { kind: 'screen' | 'window'; name: string; withAudio: boolean }
    | { kind: 'audio-app'; name: string }
    | { kind: 'audio-system' };

/** Why a presented grant was not accepted (diagnostics + tests; never shown to the user). */
export type GrantStatus = 'valid' | 'missing' | 'unknown' | 'sender' | 'expired' | 'used' | 'source' | 'audio';

export type CaptureDecision =
    | { allowed: true; via: 'grant' | 'dialog'; grant: GrantStatus }
    | { allowed: false; why: 'declined' | 'cooldown' | 'busy'; grant: GrantStatus };

interface Grant {
    token: string;
    senderId: number;
    sourceId: string;
    audio: boolean;
    trusted: boolean;
    /** The user allowed this grant through the native dialog. */
    confirmed: boolean;
    createdAt: number;
    videoUsedAt: number | null;
    audioUsed: boolean;
}

export interface CaptureConsentDeps {
    /** Shows the native confirmation. Resolves true ONLY on an explicit "Allow". */
    confirm: (prompt: ConsentPrompt) => Promise<boolean>;
    now?: () => number;
    /** Token source (injectable for tests). Default: 24 random bytes, base64url. */
    newToken?: () => string;
}

// Control characters, line/paragraph separators and bidi overrides/isolates: none of them
// belong in a window title shown inside a security dialog. Built from code points so the
// source holds no invisible characters.
const CONTROL_AND_BIDI = new RegExp(
    '[' + [[0x00, 0x1f], [0x7f, 0x7f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]]
        .map(([a, b]) => String.fromCharCode(a) + (b > a ? '-' + String.fromCharCode(b) : '')).join('') + ']+', 'g',
);

/** Strip control characters and cap the length of a window/screen title before it goes into a dialog. */
export function sanitizeLabel(raw: unknown, max = 120): string {
    const s = typeof raw === 'string' ? raw : '';
    const cleaned = s.replace(CONTROL_AND_BIDI, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Untitled';
    return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned;
}

/** The dialog copy for a prompt. Pure, so the wording is pinned by a test. */
export function describePrompt(p: ConsentPrompt): { message: string; detail: string } {
    switch (p.kind) {
        case 'screen':
            return {
                message: `Cipherline wants to share your screen: ${sanitizeLabel(p.name)}`,
                detail: 'Everything on this screen will be visible to the people in your call.' + (p.withAudio ? ' Audio will be shared too.' : '') +
                    '\n\nOnly allow this if you just asked to share your screen.',
            };
        case 'window':
            return {
                message: `Cipherline wants to share a window: ${sanitizeLabel(p.name)}`,
                detail: 'Everything shown in this window will be visible to the people in your call.' + (p.withAudio ? ' Its audio will be shared too.' : '') +
                    '\n\nOnly allow this if you just asked to share it.',
            };
        case 'audio-app':
            return {
                message: `Cipherline wants to share audio from: ${sanitizeLabel(p.name)}`,
                detail: 'Anything this app plays will be heard by the people in your call.\n\nOnly allow this if you just asked to share it.',
            };
        case 'audio-system':
            return {
                message: 'Cipherline wants to share your computer’s audio',
                detail: 'Everything your computer plays (except Cipherline itself) will be heard by the people in your call.\n\nOnly allow this if you just asked to share your screen with sound.',
            };
    }
}

export function createCaptureConsent(deps: CaptureConsentDeps) {
    const now = deps.now ?? Date.now;
    const newToken = deps.newToken ?? (() => nodeCrypto.randomBytes(24).toString('base64url'));

    const grants = new Map<string, Grant>();
    const presenceBySender = new Map<number, number>();
    let presenceGlobal = 0;
    /** Last capture allowed per sender: continuation window for automatic re-shares. */
    const active = new Map<number, { sourceId: string; at: number }>();
    let promptInFlight = false;
    let declinedUntil = 0;

    const videoDeadline = (g: Grant) => g.createdAt + GRANT_TTL_MS;
    const audioDeadline = (g: Grant) =>
        Math.max(videoDeadline(g), g.videoUsedAt === null ? 0 : g.videoUsedAt + AUDIO_AFTER_VIDEO_MS);

    function sweep(): void {
        const t = now();
        for (const [tok, g] of grants) {
            if (t > audioDeadline(g) + 1_000 || (g.videoUsedAt !== null && g.audioUsed)) grants.delete(tok);
        }
        for (const [sender, a] of active) if (t - a.at > CONTINUATION_MS) active.delete(sender);
    }

    /** Record a REAL user input (webContents 'input-event') or a main-originated trigger (`null`: global shortcut). */
    function notePresence(senderId: number | null): void {
        if (senderId === null) presenceGlobal = now();
        else presenceBySender.set(senderId, now());
    }
    const presenceFresh = (senderId: number) =>
        now() - Math.max(presenceBySender.get(senderId) ?? 0, presenceGlobal) <= PRESENCE_WINDOW_MS;

    function mint(senderId: number, sourceId: unknown, audio: unknown): { ok: true; token: string; trusted: boolean } | { ok: false; reason: 'bad_request' } {
        if (!Number.isInteger(senderId) || !isCaptureSourceId(sourceId) || typeof audio !== 'boolean') return { ok: false, reason: 'bad_request' };
        sweep();
        const a = active.get(senderId);
        const continuation = !!a && a.sourceId === sourceId && now() - a.at <= CONTINUATION_MS;
        const trusted = presenceFresh(senderId) || continuation;
        // Bound what one webContents can hold: drop the oldest beyond the cap.
        const mine = [...grants.values()].filter(g => g.senderId === senderId).sort((x, y) => x.createdAt - y.createdAt);
        while (mine.length >= MAX_OUTSTANDING_PER_SENDER) grants.delete(mine.shift()!.token);
        const token = newToken();
        grants.set(token, {
            token, senderId, sourceId, audio, trusted, confirmed: false,
            createdAt: now(), videoUsedAt: null, audioUsed: false,
        });
        return { ok: true, token, trusted };
    }

    /** Is `token` a grant this sender may spend on `kind` now? Does NOT spend it. */
    function inspect(senderId: number, token: unknown, kind: 'video' | 'audio', matches: (sourceId: string) => boolean, wantsAudio: boolean): { status: GrantStatus; grant?: Grant } {
        if (token === undefined || token === null || token === '') return { status: 'missing' };
        if (typeof token !== 'string') return { status: 'unknown' };
        const g = grants.get(token);
        if (!g) return { status: 'unknown' };
        if (g.senderId !== senderId) return { status: 'sender' };
        const t = now();
        if (kind === 'video') {
            if (g.videoUsedAt !== null) return { status: 'used' };
            if (t > videoDeadline(g)) return { status: 'expired' };
            if (!matches(g.sourceId)) return { status: 'source' };
            if (wantsAudio && !g.audio) return { status: 'audio' };
        } else {
            if (g.audioUsed) return { status: 'used' };
            if (t > audioDeadline(g)) return { status: 'expired' };
            if (!g.audio) return { status: 'audio' };
            if (!matches(g.sourceId)) return { status: 'source' };
        }
        return { status: 'valid', grant: g };
    }

    async function ask(prompt: ConsentPrompt): Promise<'allowed' | 'declined' | 'cooldown' | 'busy'> {
        if (promptInFlight) return 'busy';
        if (now() < declinedUntil) return 'cooldown';
        promptInFlight = true;
        let ok = false;
        try { ok = (await deps.confirm(prompt)) === true; } catch { ok = false; }
        finally { promptInFlight = false; }
        if (!ok) { declinedUntil = now() + DECLINE_COOLDOWN_MS; return 'declined'; }
        return 'allowed';
    }

    /**
     * The video half: `desktop-capturer-resolve`. `source` is main's own record
     * of the source being granted (id + name from the enumerated list).
     */
    async function authorizeVideo(senderId: number, token: unknown, source: { id: string; name: string }, withAudio: boolean): Promise<CaptureDecision> {
        sweep();
        const kind: 'screen' | 'window' = source.id.startsWith('window:') ? 'window' : 'screen';
        const { status, grant } = inspect(senderId, token, 'video', sid => sid === source.id, withAudio);
        if (grant) {
            grant.videoUsedAt = now(); // spent, whatever happens next: a replay finds it used
            if (grant.trusted || grant.confirmed) {
                active.set(senderId, { sourceId: source.id, at: now() });
                return { allowed: true, via: 'grant', grant: status };
            }
        }
        const outcome = await ask({ kind, name: source.name, withAudio: grant ? grant.audio : withAudio });
        if (outcome !== 'allowed') return { allowed: false, why: outcome, grant: status };
        if (grant) grant.confirmed = true; // the user said yes to this share, audio included
        active.set(senderId, { sourceId: source.id, at: now() });
        return { allowed: true, via: 'dialog', grant: status };
    }

    /**
     * The audio half: `audio:start-window-capture`. `matches` says whether a
     * grant's source is the one this audio start is for (main knows the pid
     * mapping; this module does not). `prompt` is what to ask if there is no
     * usable grant.
     */
    async function authorizeAudio(
        senderId: number, token: unknown, matches: (sourceId: string) => boolean,
        prompt: Extract<ConsentPrompt, { kind: 'audio-app' | 'audio-system' }>,
    ): Promise<CaptureDecision> {
        sweep();
        const { status, grant } = inspect(senderId, token, 'audio', matches, false);
        if (grant) {
            grant.audioUsed = true;
            if (grant.trusted || grant.confirmed) return { allowed: true, via: 'grant', grant: status };
        }
        const outcome = await ask(prompt);
        if (outcome !== 'allowed') return { allowed: false, why: outcome, grant: status };
        if (grant) grant.confirmed = true;
        return { allowed: true, via: 'dialog', grant: status };
    }

    /** A webContents went away: forget everything keyed by it. */
    function forgetSender(senderId: number): void {
        for (const [tok, g] of grants) if (g.senderId === senderId) grants.delete(tok);
        presenceBySender.delete(senderId);
        active.delete(senderId);
    }

    return {
        notePresence, mint, authorizeVideo, authorizeAudio, forgetSender,
        /** Test/diagnostic hooks. */
        _outstanding: () => grants.size,
    };
}

export type CaptureConsent = ReturnType<typeof createCaptureConsent>;
