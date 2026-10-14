/**
 * annotationRequestKeybind - answering a request to draw from the keyboard,
 * including while Cipherline is NOT focused (the presenter is usually in the
 * game or app they are sharing, not looking at the dock).
 *
 * Three rules this module exists to hold in ONE place, so the dock and the
 * keybind can never disagree about them:
 *
 *  1. What is answerable. `visibleAnnotationRequests` is the single selector
 *     for "a request currently shown in AnnotationRequestsDock": on a surface
 *     WE own, from someone other than us, from a participant still in this
 *     call, and not past REQUEST_TTL_MS (checked against the clock at the
 *     moment of the press, not only at the 1 s expiry tick, so a request that
 *     lapsed half a second ago cannot be approved in the gap). The dock
 *     renders exactly this list, in exactly this order, and the keybind acts
 *     on its first entry. A key can therefore never approve anything a click
 *     on the dock could not.
 *
 *  2. Which request. Oldest first (by when it was asked), so with several
 *     people waiting the key works through them in arrival order, and the
 *     dock puts the key hint on that same row.
 *
 *  3. How it is answered. `allowAnnotationRequest` / `declineAnnotationRequest`
 *     are what the dock's Allow / Decline buttons call, and the keybind calls
 *     the same two functions - one per-person, per-surface grant, exactly as a
 *     click. There is deliberately no "allow everyone" path (owner decision:
 *     no room-wide pre-approval).
 *
 * The dock is the only thing that knows who "we" are and who is in the room
 * (it lives inside the LiveKit room context; the keybind dispatcher lives in
 * Dashboard, outside it). So the dock PUBLISHES that as a context while it is
 * mounted, and clears it on unmount: with no call there is no context, and so
 * nothing is answerable and nothing is armed.
 *
 * Arming: Dashboard registers the two OS-level shortcuts only while
 * `hasAnswerableAnnotationRequest()` is true (see useKeybinds'
 * `buildGlobalShortcutMap`), so the combo is never taken from other apps
 * while nobody is waiting. That gate deliberately ignores the clock: expiry is
 * observed through the transport's 1 s `expireRequests` tick, which mutates
 * the store and so re-evaluates it. The worst case is the combo staying
 * registered for under a second after the last request lapsed - and a press in
 * that window re-checks the clock (rule 1) and does nothing.
 */
import { useSyncExternalStore } from 'react';
import { annotationStore, clock, REQUEST_TTL_MS, type AnnotationState } from './annotationStore';
import { ownerOf } from './annotationTransport';

export interface AnswerableRequest {
    /** trackKey of OUR surface they asked about. */
    track: string;
    /** SFU-attested identity of the person asking. */
    id: string;
    /** ms epoch the request was queued (local clock). */
    at: number;
}

export interface AnnotationKeybindContext {
    /** Local participant identity: only requests on surfaces we own count. */
    me: string;
    /** Is this identity a participant in the call right now? */
    isPresent: (identity: string) => boolean;
}

/**
 * The requests the dock shows, oldest first. Pass `at` to also drop anything
 * past REQUEST_TTL_MS at that instant; omit it for the clock-free view (the
 * arming gate - see the module comment for why that is safe).
 */
export function visibleAnnotationRequests(
    s: Pick<AnnotationState, 'requests' | 'requestedAt'>,
    ctx: AnnotationKeybindContext | null,
    at?: number,
): AnswerableRequest[] {
    if (!ctx || !ctx.me) return [];
    const out: AnswerableRequest[] = [];
    for (const [track, ids] of Object.entries(s.requests)) {
        if (ownerOf(track) !== ctx.me) continue;
        for (const id of ids) {
            if (!id || id === ctx.me) continue;
            // No timestamp = nothing to age it by, so it cannot be shown as a
            // live request either. addRequest always writes both.
            const t = s.requestedAt[track + '\n' + id];
            if (typeof t !== 'number' || !Number.isFinite(t)) continue;
            if (at !== undefined && at - t >= REQUEST_TTL_MS) continue;
            if (!ctx.isPresent(id)) continue;
            out.push({ track, id, at: t });
        }
    }
    // Oldest first; ties broken deterministically so the dock's first row and
    // the keybind's target can never differ.
    out.sort((a, b) => a.at - b.at || (a.track < b.track ? -1 : a.track > b.track ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
}

// -- context published by the dock -------------------------------------------

let context: AnnotationKeybindContext | null = null;
const contextListeners = new Set<() => void>();
const emitContext = () => contextListeners.forEach(l => l());

/**
 * Publish who we are and who is in the call. Returns a cleanup that clears the
 * context only if it is still the one this call installed, so a remount (or a
 * second dock) can never be wiped out by an older one unmounting late.
 */
export function setAnnotationKeybindContext(next: AnnotationKeybindContext): () => void {
    context = next;
    emitContext();
    return () => {
        if (context === next) { context = null; emitContext(); }
    };
}

/** Presence changed without the store changing (someone joined / a reconnect
 *  re-populated the roster): re-evaluate everything that reads the context. */
export function notifyAnnotationKeybindContextChanged(): void { emitContext(); }

export function getAnnotationKeybindContext(): AnnotationKeybindContext | null { return context; }

function subscribe(l: () => void): () => void {
    const offStore = annotationStore.subscribe(l);
    contextListeners.add(l);
    return () => { offStore(); contextListeners.delete(l); };
}

/** The arming gate: is anyone waiting on an answer from us right now? */
export function hasAnswerableAnnotationRequest(): boolean {
    return visibleAnnotationRequests(annotationStore.getState(), context).length > 0;
}

/** React binding for the arming gate (Dashboard). */
export function useHasAnswerableAnnotationRequest(): boolean {
    return useSyncExternalStore(subscribe, hasAnswerableAnnotationRequest, hasAnswerableAnnotationRequest);
}

// -- answering ----------------------------------------------------------------

/** The dock's Allow button. One person, one surface - never more. */
export function allowAnnotationRequest(track: string, id: string): void {
    annotationStore.grant(track, id);
}

/** The dock's Decline button (starts the decline cooldown). */
export function declineAnnotationRequest(track: string, id: string): void {
    annotationStore.denyRequest(track, id);
}

/** The request the keybind would act on right now, or null. */
export function oldestAnswerableRequest(at: number = clock.now()): AnswerableRequest | null {
    return visibleAnnotationRequests(annotationStore.getState(), context, at)[0] ?? null;
}

/** Keybind: approve the oldest still-valid request. Returns what it approved,
 *  or null when nothing was answerable (the press then does nothing at all). */
export function approveOldestAnnotationRequest(at: number = clock.now()): AnswerableRequest | null {
    const r = oldestAnswerableRequest(at);
    if (r) allowAnnotationRequest(r.track, r.id);
    return r;
}

/** Keybind: decline the oldest still-valid request. */
export function declineOldestAnnotationRequest(at: number = clock.now()): AnswerableRequest | null {
    const r = oldestAnswerableRequest(at);
    if (r) declineAnnotationRequest(r.track, r.id);
    return r;
}

// -- key hints shown in the dock ----------------------------------------------

export interface AnnotationKeyHints {
    /** Compact formatted combo ("Ctrl+Shift+Y"), or null when unbound. */
    approve: string | null;
    decline: string | null;
}

let hints: AnnotationKeyHints = { approve: null, decline: null };
const hintListeners = new Set<() => void>();

/** Dashboard owns the keybind state; it publishes the two hints here. */
export function setAnnotationKeyHints(next: AnnotationKeyHints): void {
    if (next.approve === hints.approve && next.decline === hints.decline) return;
    hints = { approve: next.approve, decline: next.decline };
    hintListeners.forEach(l => l());
}

const subscribeHints = (l: () => void) => { hintListeners.add(l); return () => { hintListeners.delete(l); }; };
const getHints = () => hints;

export function useAnnotationKeyHints(): AnnotationKeyHints {
    return useSyncExternalStore(subscribeHints, getHints, getHints);
}
