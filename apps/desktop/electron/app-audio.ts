/**
 * app-audio — which apps a Linux Wayland WINDOW share can take audio from, and who may start one.
 *
 * WHY. Windows picks a window's audio by the window's process (WASAPI process loopback). On a native
 * Wayland session the window comes from the desktop's portal chooser, which hands over pixels and no
 * pid, so the pid route has nothing to start from (audio:get-pid-from-source-id answers null there).
 * What PipeWire can tell us is which APPLICATIONS are playing audio right now (the playback streams'
 * application.name / application.process.binary). So the picker offers that list ("Share audio from:
 * [app]") and the capture is "this application's streams only" (the addon's 'app' mode) - the same
 * thing Vesktop / venmic do.
 *
 * THE RULES (security audit E-5 still holds; this adds a second door to the same room, not a wider one):
 *
 *   1. Main issues the handles. The addon's list is turned into opaque, unguessable handles here,
 *      bound to the asking webContents. The renderer only ever holds a handle and a display name; the
 *      key the addon understands (binary + name) never leaves main, and a pid or binary supplied by the
 *      renderer is never the authority for anything. A handle main did not issue (or issued to another
 *      window, or that has expired) resolves to nothing and the start is refused.
 *   2. The start needs the existing share grant (capture-consent.ts authorizeAudio): sender- and
 *      source-bound, unspent, minted with audio on, trusted, and for a WINDOW source whose share is live.
 *      This module only adds the "window:" shape and the portal precondition on top.
 *   3. Handles expire with the share. An unstarted handle lives HANDLE_TTL_MS from when it was last
 *      listed. A handle that has started a capture lives as long as the share (the app may restart its
 *      audio and the renderer restarts the capture on an encoder stall); when the share ends it has
 *      SHARE_GAP_MS left (a republish restarts the audio from the same choice) and then it is gone, and
 *      forgetSender() drops everything when the window goes.
 *   4. Names are the sharer's own business on the sharer's own machine, but they are never logged or
 *      reported from here; callers log counts only.
 *
 * Free of any `electron` import so it is unit-testable (app-audio.test.ts) and can be driven from the
 * PipeWire harness (harness/linux-share-audio/app-test.mjs).
 */

import * as nodeCrypto from 'node:crypto';
import { sanitizeLabel } from './capture-consent';
import { isPortalSourceId } from './portal-source';

/** A handle that has not started a capture is good for this long after it was last listed. */
export const HANDLE_TTL_MS = 10 * 60_000;
/**
 * After a share ends, a handle that had started a capture is good for this much longer. A source swap or
 * a hardware-encoder change republishes the share (the video is unpublished and published again, so
 * "share live" flips off and on) and the new publication restarts the audio from the same choice; this
 * is the same continuation window capture-consent.ts gives an automatic re-share (CONTINUATION_MS).
 */
export const SHARE_GAP_MS = 120_000;
/** Handles one webContents can hold; the oldest unstarted goes first. */
export const MAX_HANDLES_PER_SENDER = 64;
/** Applications shown at most. */
export const MAX_APPS = 50;
/** Two lists from one window closer than this share one enumeration (each is a PipeWire round trip). */
export const LIST_MIN_INTERVAL_MS = 400;

/** What the addon's listApps() returns per application. */
export interface AddonApp { key: string; name: string; binary: string; streams: number }
/** What the renderer is given. */
export interface ListedApp { handle: string; name: string; binary: string }

interface Entry {
    handle: string;
    senderId: number;
    key: string;
    name: string;
    binary: string;
    /** Has a capture been started from this handle (it then lives with the share, see endShare). */
    started: boolean;
    /** null = started and the share is live. */
    expiresAt: number | null;
}

export interface AppAudioDeps {
    now?: () => number;
    newHandle?: () => string;
}

const KEY_MAX = 1024;

export function createAppAudio(deps: AppAudioDeps = {}) {
    const now = deps.now ?? Date.now;
    const newHandle = deps.newHandle ?? (() => 'aa_' + nodeCrypto.randomBytes(18).toString('base64url'));
    const entries = new Map<string, Entry>();
    const lastList = new Map<number, { at: number; apps: AddonApp[] }>();

    function sweep(): void {
        const t = now();
        for (const [h, e] of entries) if (e.expiresAt !== null && t > e.expiresAt) entries.delete(h);
    }

    /** Accept only well-formed addon output: strings of sane size. Anything else is dropped, never coerced. */
    function clean(raw: unknown): AddonApp[] {
        if (!Array.isArray(raw)) return [];
        const seen = new Set<string>();
        const out: AddonApp[] = [];
        for (const a of raw) {
            if (!a || typeof a !== 'object') continue;
            const { key, name, binary, streams } = a as Record<string, unknown>;
            if (typeof key !== 'string' || !key || key.length > KEY_MAX || seen.has(key)) continue;
            if (typeof name !== 'string' || !name.trim()) continue;
            seen.add(key);
            out.push({
                key,
                name: sanitizeLabel(name, 60),
                binary: typeof binary === 'string' ? sanitizeLabel(binary, 60) : '',
                streams: typeof streams === 'number' && Number.isFinite(streams) ? streams : 0,
            });
            if (out.length >= MAX_APPS) break;
        }
        return out;
    }

    /**
     * Turn the addon's list into handles for this window. The same application keeps the same
     * handle across lists (so a picker that re-lists does not invalidate the one already chosen), and
     * a handle for an app that has gone quiet stays good until it expires.
     * `fetch` is only called when the last list for this window is older than LIST_MIN_INTERVAL_MS.
     */
    function list(senderId: number, fetch: () => unknown): ListedApp[] {
        sweep();
        const t = now();
        const prev = lastList.get(senderId);
        let apps: AddonApp[];
        if (prev && t - prev.at < LIST_MIN_INTERVAL_MS) apps = prev.apps;
        else {
            apps = clean(fetch());
            lastList.set(senderId, { at: t, apps });
        }
        const mine = [...entries.values()].filter(e => e.senderId === senderId);
        const out: ListedApp[] = [];
        for (const a of apps) {
            let e = mine.find(x => x.key === a.key);
            if (!e) {
                // Bound what one window can hold: the oldest UNSTARTED handle goes first.
                const unstarted = mine.filter(x => !x.started).sort((x, y) => (x.expiresAt as number) - (y.expiresAt as number));
                while (mine.length >= MAX_HANDLES_PER_SENDER && unstarted.length) {
                    const gone = unstarted.shift()!;
                    entries.delete(gone.handle);
                    mine.splice(mine.indexOf(gone), 1);
                }
                e = { handle: newHandle(), senderId, key: a.key, name: a.name, binary: a.binary, expiresAt: t + HANDLE_TTL_MS, started: false };
                entries.set(e.handle, e);
                mine.push(e);
            } else {
                e.name = a.name;
                e.binary = a.binary;
                if (!e.started) e.expiresAt = t + HANDLE_TTL_MS;
            }
            out.push({ handle: e.handle, name: e.name, binary: e.binary });
        }
        return out;
    }

    /** The addon key behind a handle THIS window was given, or null (unknown, another window's, expired). */
    function resolve(senderId: number, handle: unknown): string | null {
        if (typeof handle !== 'string' || !handle) return null;
        sweep();
        const e = entries.get(handle);
        if (!e || e.senderId !== senderId) return null;
        return e.key;
    }

    /** A capture was started from this handle: it now lives with the share. */
    function markStarted(senderId: number, handle: string): void {
        const e = entries.get(handle);
        if (e && e.senderId === senderId) { e.started = true; e.expiresAt = null; }
    }

    /**
     * The share ended: the handles that started a capture for it run out in SHARE_GAP_MS (not at once:
     * a republish ends the share for an instant and restarts the audio from the same choice).
     * Listed-only handles keep their own TTL.
     */
    function endShare(senderId: number): void {
        const t = now();
        for (const e of entries.values()) if (e.senderId === senderId && e.started && e.expiresAt === null) e.expiresAt = t + SHARE_GAP_MS;
    }

    /** The window went away: forget everything keyed by it. */
    function forgetSender(senderId: number): void {
        for (const [h, e] of entries) if (e.senderId === senderId) entries.delete(h);
        lastList.delete(senderId);
    }

    return { list, resolve, markStarted, endShare, forgetSender, _size: () => entries.size };
}

export type AppAudio = ReturnType<typeof createAppAudio>;

/** The slice of capture-consent the start needs. */
export interface AppAudioConsent {
    authorizeAudio(
        senderId: number, token: unknown, matches: (sourceId: string) => boolean,
    ): { allowed: true } | { allowed: false; why: string };
}

export type AppStartDecision =
    | { ok: true; key: string }
    | { ok: false; why: 'unsupported' | 'bad_handle' | 'consent'; detail?: string };

/**
 * May this window start capturing this app's audio? Order matters and is pinned by tests:
 *   1. only on Linux through the portal (a Wayland window is the only share that has no pid);
 *   2. the handle must be one main issued to this window - checked BEFORE the grant is touched, so a
 *      forged handle cannot burn the (single-use) audio half of a real grant;
 *   3. the existing audio grant for a live WINDOW share.
 * On success the handle is marked started (it now lives with the share) and its key is returned for
 * the addon. Nothing here reads a pid or a binary from the caller.
 */
export function authorizeAppStart(
    d: { platform: string; viaPortal: boolean; appAudio: AppAudio; consent: AppAudioConsent },
    senderId: number, handle: unknown, grantToken: unknown,
): AppStartDecision {
    if (d.platform !== 'linux' || !d.viaPortal) return { ok: false, why: 'unsupported' };
    const key = d.appAudio.resolve(senderId, handle);
    if (!key) return { ok: false, why: 'bad_handle' };
    // A window source, or the portal's placeholder (the app never learns what the desktop's chooser
    // was answered with, so a portal share is a placeholder whatever it turns out to be: portal-source.ts).
    const decision = d.consent.authorizeAudio(senderId, grantToken, sid => sid.startsWith('window:') || isPortalSourceId(sid));
    if (!decision.allowed) return { ok: false, why: 'consent', detail: decision.why };
    d.appAudio.markStarted(senderId, handle as string);
    return { ok: true, key };
}
