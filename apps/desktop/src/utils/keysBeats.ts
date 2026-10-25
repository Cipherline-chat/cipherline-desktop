/**
 * keysBeats — the content-free signals Keys on Home reacts to, from parts of
 * the app that are nowhere near him (the message pipeline, the call sidebar,
 * the upload path, the backup run, the rail's Home button).
 *
 * Deliberately narrow: every signal is a KIND or a boolean. There is no
 * payload field a caller could put a message, a name, a conversation id or a
 * file name in, and the types make sure of it (docs/personality.md rule 8;
 * the easter-eggs wiring test scans the emit sites). In-process only: module
 * state + listeners, nothing leaves the renderer.
 *
 * State signals (call media, transfer, backup) are also remembered, so a Keys
 * that mounts later (you navigate to Home mid-call) starts from the truth.
 */

type Listener<T> = (v: T) => void;

function bus<T>() {
    const set = new Set<Listener<T>>();
    return {
        on(cb: Listener<T>): () => void { set.add(cb); return () => { set.delete(cb); }; },
        emit(v: T): void { for (const cb of [...set]) { try { cb(v); } catch { /* a listener must not break the sender */ } } },
        size: () => set.size,
    };
}

// ── one-shot beats ──────────────────────────────────────────────────────────

/** 'message' = a message arrived that is allowed to alert (not your own, not a
 *  muted conversation, not swallowed by DND). 'home' = the Home button was
 *  pressed. */
export type KeysBeat = 'message' | 'home';
const beats = bus<KeysBeat>();
export function emitKeysBeat(kind: KeysBeat): void { beats.emit(kind); }
export function onKeysBeat(cb: Listener<KeysBeat>): () => void { return beats.on(cb); }

// ── your call's media (from the call sidebar) ───────────────────────────────

export interface OwnCallMedia { speaking: boolean; sharing: boolean; video: boolean }
export const OWN_MEDIA_OFF: OwnCallMedia = { speaking: false, sharing: false, video: false };
let callMedia: OwnCallMedia = OWN_MEDIA_OFF;
const media = bus<OwnCallMedia>();
export function setOwnCallMedia(next: OwnCallMedia): void {
    const v: OwnCallMedia = { speaking: !!next.speaking, sharing: !!next.sharing, video: !!next.video };
    if (v.speaking === callMedia.speaking && v.sharing === callMedia.sharing && v.video === callMedia.video) return;
    callMedia = v;
    media.emit(v);
}
export function getOwnCallMedia(): OwnCallMedia { return callMedia; }
export function onOwnCallMedia(cb: Listener<OwnCallMedia>): () => void { return media.on(cb); }

// ── long-running activities (refcounted: two uploads = still carrying) ──────

export type KeysActivity = 'transfer' | 'backup';
const counts: Record<KeysActivity, number> = { transfer: 0, backup: 0 };
const activity = bus<KeysActivity>();
/** Start an activity; returns its end (idempotent, so every exit path may call it). */
export function beginKeysActivity(kind: KeysActivity): () => void {
    counts[kind]++;
    if (counts[kind] === 1) activity.emit(kind);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        counts[kind] = Math.max(0, counts[kind] - 1);
        if (counts[kind] === 0) activity.emit(kind);
    };
}
export function keysActivityOn(kind: KeysActivity): boolean { return counts[kind] > 0; }
/** Called with the activity whose on/off state just flipped. */
export function onKeysActivity(cb: Listener<KeysActivity>): () => void { return activity.on(cb); }

// ── the night dive (another branch owns it; we only listen) ─────────────────

/** Dispatched on window by the night-dive feature: `detail: { active, reason }`. */
export const NIGHT_DIVE_EVENT = 'cipherline:night-dive';
export interface NightDiveDetail { active: boolean; reason: 'enter' | 'exit' | 'initial' }
/** True when the app is already in its night-dive depth (`<html data-depth="night">`). */
export function isNightDiveNow(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
    return doc?.documentElement?.getAttribute('data-depth') === 'night';
}

/** Test escape hatch. */
export function __resetKeysBeats(): void {
    callMedia = OWN_MEDIA_OFF;
    counts.transfer = 0;
    counts.backup = 0;
}
