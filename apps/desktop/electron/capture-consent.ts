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
 *   3. A VIDEO capture request WITHOUT a valid grant - none, replayed,
 *      expired, another window's, for another source - is not refused outright
 *      and is not silently honoured: main shows a NATIVE confirmation
 *      ("Cipherline wants to share your screen: <source name>", Don't allow is
 *      the default, dismiss = deny). The name is main's own, never the
 *      renderer's.
 *
 *      AUDIO NEVER PROMPTS (owner decision 2026-10-31: "if I enabled audio just
 *      do it, no prompt"). Turning audio on in Cipherline's own UI starts the
 *      system / app audio with no dialog. What still guards it, silently:
 *      the audio start must present a valid grant (sender- and source-bound,
 *      unspent, minted with audio on) that is TRUSTED (real input or an
 *      automatic re-share, see below) or already confirmed by the video
 *      dialog, AND a screen/window share started from our picker must be live
 *      for that source. Anything else is refused without a dialog. What is
 *      lost by dropping the prompt: a hostile renderer that rides a real click
 *      (inside PRESENCE_WINDOW_MS) while a share is live can now add system
 *      audio to that share without a second confirmation.
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
 * A RESTART ON THE CAPTURE THAT IS ALREADY RUNNING (Linux Wayland: a new capture is the
 * desktop's chooser, so the app keeps the live one) never reaches authorizeVideo, and with it
 * the continuation above would lapse after 2 minutes and the native audio start after the
 * restart would be refused as untrusted. continueLive renews it for the LIVE source only: the
 * same source, still live for this sender, gets a grant whose video half is spent and which
 * carries audio only if the share already did (or a real click is fresh). Any other source gets
 * nothing from it and goes through mint + authorizeVideo - a new source is a new capture and a
 * new consent.
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
    | { kind: 'screen' | 'window'; name: string; withAudio: boolean };

/** Why a presented grant was not accepted (diagnostics + tests; never shown to the user). */
export type GrantStatus = 'valid' | 'missing' | 'unknown' | 'sender' | 'expired' | 'used' | 'source' | 'audio';

export type CaptureDecision =
    | { allowed: true; via: 'grant' | 'dialog'; grant: GrantStatus }
    | { allowed: false; why: 'declined' | 'cooldown' | 'busy'; grant: GrantStatus };

/**
 * The audio start's answer. Never asks the user: it is allowed, or refused
 * silently with the reason (logged by main, never shown).
 */
export type AudioDecision =
    | { allowed: true; via: 'grant'; grant: GrantStatus }
    | { allowed: false; why: 'no_grant' | 'untrusted' | 'no_share'; grant: GrantStatus };

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
    /**
     * Screen / window shares started from our picker and not yet ended, per
     * sender. Set when the video capture is allowed; cleared by endShare()
     * (the renderer reports its share gone) or when the sender goes away.
     * Audio is only ever started while one of these is live.
     *
     * A sender can have more than one source here: a CHANGE of source is allowed (and the share's
     * consent recorded) when the new capture starts, while the old share keeps running until the new
     * one is in hand. If the new one is cancelled (Linux Wayland: the desktop's chooser closed), the
     * old share is still live and its automatic restarts must still continue (continueLive) - so a
     * new source is ADDED, and only endShare() (the share ended, nothing left) drops them.
     */
    const liveShare = new Map<number, Map<string, { since: number; audio: boolean }>>();
    const MAX_LIVE_SOURCES_PER_SENDER = 4;
    const markLive = (senderId: number, sourceId: string, audio: boolean): void => {
        let m = liveShare.get(senderId);
        if (!m) { m = new Map(); liveShare.set(senderId, m); }
        m.delete(sourceId);
        m.set(sourceId, { since: now(), audio });
        while (m.size > MAX_LIVE_SOURCES_PER_SENDER) m.delete(m.keys().next().value as string);
    };
    const liveOf = (senderId: number, sourceId: string) => liveShare.get(senderId)?.get(sourceId);
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
                markLive(senderId, source.id, grant.audio);
                return { allowed: true, via: 'grant', grant: status };
            }
        }
        const outcome = await ask({ kind, name: source.name, withAudio: grant ? grant.audio : withAudio });
        if (outcome !== 'allowed') return { allowed: false, why: outcome, grant: status };
        if (grant) grant.confirmed = true; // the user said yes to this share, audio included
        active.set(senderId, { sourceId: source.id, at: now() });
        markLive(senderId, source.id, grant ? grant.audio : withAudio);
        return { allowed: true, via: 'dialog', grant: status };
    }

    /**
     * The audio half: `audio:start-window-capture`. `matches` says whether a
     * grant's source is the one this audio start is for (main knows the pid
     * mapping; this module does not). NEVER shows a dialog (see the header):
     * the start is allowed when the sender presents a valid, trusted (or
     * already confirmed) grant for that source AND its share is live; otherwise
     * it is refused silently and the renderer's existing "audio could not be
     * started" notice is the only visible effect.
     */
    function authorizeAudio(senderId: number, token: unknown, matches: (sourceId: string) => boolean): AudioDecision {
        sweep();
        const { status, grant } = inspect(senderId, token, 'audio', matches, false);
        if (!grant) return { allowed: false, why: 'no_grant', grant: status };
        grant.audioUsed = true; // spent, whatever happens next
        if (!(grant.trusted || grant.confirmed)) return { allowed: false, why: 'untrusted', grant: status };
        // A share from our picker must be running for exactly this source. The
        // same grant's video half having just been spent counts too, so a
        // stop/start republish cannot race the end-of-share report.
        const live = liveOf(senderId, grant.sourceId);
        const shareLive = grant.videoUsedAt !== null || !!live;
        if (!shareLive) return { allowed: false, why: 'no_share', grant: status };
        // The share now carries audio the user turned on: a later automatic restart of the SAME share
        // (continueLive) may keep it without a click.
        if (live) live.audio = true;
        return { allowed: true, via: 'grant', grant: status };
    }

    /**
     * An automatic restart of the share that is ALREADY LIVE keeps its capture instead of asking the
     * OS for another (Linux Wayland: a new capture is the desktop's chooser in front of someone who
     * is not there to answer it - sharePlatformSupport.canReuseLiveCapture). That path never reaches
     * authorizeVideo, so nothing would renew the consent the share's audio rides on: the grant the
     * restart mints is trusted only by a click (not there) or by the 2-minute continuation window of
     * the last allowed capture, which an hours-old share has long outlived, and the native audio start
     * after the restart would be refused as untrusted.
     *
     * So the restart asks here instead. The same source, still live for this sender, continues; the
     * grant it gets has its video half spent (the live capture IS that half) and is trusted without a
     * click, because the user already allowed exactly this. It narrows, never widens:
     *   - ONLY the source the sender's live share is on: any other source gets nothing from here and
     *     goes through mint + authorizeVideo like every new share (a new source is a new consent);
     *   - audio only if the live share already carried it, or a real click is fresh (the user is
     *     turning it on right now): a restart cannot add the system's audio to a silent share;
     *   - a share that has ended, or another webContents' share, is refused (`no_share`).
     */
    function continueLive(senderId: number, sourceId: unknown, audio: unknown):
        { ok: true; token: string; audio: boolean } | { ok: false; reason: 'bad_request' | 'no_share' } {
        if (!Number.isInteger(senderId) || !isCaptureSourceId(sourceId) || typeof audio !== 'boolean') return { ok: false, reason: 'bad_request' };
        sweep();
        const live = liveOf(senderId, sourceId);
        if (!live) return { ok: false, reason: 'no_share' };
        const withAudio = audio && (live.audio || presenceFresh(senderId));
        const mine = [...grants.values()].filter(g => g.senderId === senderId).sort((x, y) => x.createdAt - y.createdAt);
        while (mine.length >= MAX_OUTSTANDING_PER_SENDER) grants.delete(mine.shift()!.token);
        const token = newToken();
        const t = now();
        grants.set(token, {
            token, senderId, sourceId, audio: withAudio, trusted: true, confirmed: true,
            createdAt: t, videoUsedAt: t, audioUsed: false,
        });
        active.set(senderId, { sourceId, at: t });
        live.since = t;
        if (withAudio) live.audio = true;
        return { ok: true, token, audio: withAudio };
    }

    /**
     * A NATIVE (Linux portal) share. It never goes through getDisplayMedia, so authorizeVideo never runs and the grant the renderer
     * minted for the pick would stay unspent with no live share recorded: every audio start for it was then refused `no_share`
     * (reports bcde1655, 2026-11-11). The share is started by MAIN's own helper, so main binds the grant here instead - same rules as
     * the video half, minus the dialog (the portal's own chooser is the user's consent for this capture):
     *   - `begin` checks the presented grant (this sender's, for exactly this source, unexpired, unused, trusted from a real click or
     *     already confirmed) and spends NOTHING; null for anything else, and a null token / forged token / other source gets null.
     *   - the returned `commit` is called when the helper has really started capturing (its first frame, which may be minutes after the
     *     click: a chooser waits on a person). It spends the video half, marks this source live for the sender and starts the audio
     *     window from NOW. Called once; a second call does nothing.
     * Nothing here widens audio: the grant still has to have been minted with audio, for this source, and authorizeAudio still applies.
     */
    function beginNativeShare(senderId: number, token: unknown, sourceId: unknown): { commit: () => boolean } | null {
        if (!Number.isInteger(senderId) || !isCaptureSourceId(sourceId)) return null;
        sweep();
        const { status, grant } = inspect(senderId, token, 'video', sid => sid === sourceId, false);
        if (status !== 'valid' || !grant || !(grant.trusted || grant.confirmed)) return null;
        let done = false;
        return {
            commit: () => {
                if (done) return false;
                done = true;
                if (grant.videoUsedAt !== null) return false;       // spent meanwhile (a second share on the same grant)
                grant.videoUsedAt = now();
                grants.set(grant.token, grant);                     // the chooser may have outlived the 30 s grant (sweep dropped it): the audio window restarts now
                active.set(senderId, { sourceId: grant.sourceId, at: now() });
                markLive(senderId, grant.sourceId, grant.audio);
                return true;
            },
        };
    }

    /** The sender's share ended (or its page went away): audio can no longer be started on it. */
    function endShare(senderId: number): void {
        liveShare.delete(senderId);
    }

    /** A webContents went away: forget everything keyed by it. */
    function forgetSender(senderId: number): void {
        for (const [tok, g] of grants) if (g.senderId === senderId) grants.delete(tok);
        presenceBySender.delete(senderId);
        active.delete(senderId);
        liveShare.delete(senderId);
    }

    return {
        notePresence, mint, continueLive, authorizeVideo, beginNativeShare, authorizeAudio, endShare, forgetSender,
        /** Test/diagnostic hooks. */
        _outstanding: () => grants.size,
        _isShareLive: (senderId: number) => liveShare.has(senderId),
    };
}

export type CaptureConsent = ReturnType<typeof createCaptureConsent>;
