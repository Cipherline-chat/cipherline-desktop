import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
    STAGE_RANK, deriveKeyWaitStage, getKeyWaitSignals, isDecrypting, needsKeyWaitState,
    nextStageDeadline, subscribeKeyWaitSignals, type KeyWaitStage,
} from '../utils/channelKeyWait';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Lifecycle of the whole-pane "waiting for this channel's keys" layer
 * (components/ChannelKeyWait.tsx; decision, stages and signals:
 * utils/channelKeyWait.ts).
 *
 * ChatPane keeps its header and composer; this replaces only the message list
 * while it is up. This hook owns the lifecycle:
 *
 *   hidden ──(newest page is all key_missing)──▶ shown ──(page readable, and no
 *   page decrypt still folding in)──▶ exiting ──(EXIT_MS)──▶ hidden, for good
 *
 * While `shown` the list is not rendered at all, so no placeholder pill ever
 * paints. On `exiting` the list mounts underneath with a fade/slide-in
 * (`ckw-list-in`) while the layer settles and fades over it — one handoff, no
 * layout jump (the layer is absolutely positioned over the feed). Once it has
 * left, it never comes back for this pane mount (ChatPane remounts per
 * channel), so a later undecryptable live message can't make it flicker.
 */

export type KeyWaitPhase = 'hidden' | 'shown' | 'exiting';

export const KEY_WAIT_EXIT_MS = 480;
export const KEY_WAIT_REDUCED_EXIT_MS = 160;
/** The page is readable but a decrypt is still folding rows in: hold the
 *  layer (so the rest of the page doesn't pop in as pills) — at most this long. */
export const KEY_WAIT_DECRYPT_HOLD_MS = 4_000;
/** A stage that would step BACKWARDS (received → asked) waits this long
 *  first: a decrypt finishing and its rows landing are two separate updates,
 *  and the layer must not flash "asking" in between. */
export const KEY_WAIT_REGRESSION_HOLD_MS = 800;

interface Row { id?: string; content?: unknown; sender_device_id?: string | null }

export interface ChannelKeyWaitState {
    phase: KeyWaitPhase;
    stage: KeyWaitStage;
    /** True while the message list must not render (layer fully up). */
    holdList: boolean;
    /** True during the exit: the list is fading in underneath. */
    handoff: boolean;
    reduced: boolean;
}

export function useChannelKeyWait({ enabled, channelId, messages }: {
    enabled: boolean;
    channelId: string | null;
    messages: readonly Row[];
}): ChannelKeyWaitState {
    const reduced = usePrefersReducedMotion();
    const wants = useMemo(() => enabled && needsKeyWaitState(messages), [enabled, messages]);
    const signals = useSyncExternalStore(
        subscribeKeyWaitSignals,
        () => getKeyWaitSignals(channelId),
        () => getKeyWaitSignals(channelId),
    );
    const decrypting = isDecrypting(signals);

    const [phase, setPhase] = useState<KeyWaitPhase>(() => (wants ? 'shown' : 'hidden'));
    // Once the list has shown readable rows (or the layer has left), never again.
    const [done, setDone] = useState(false);
    const [mountedAt] = useState(() => Date.now());
    const [shownAt, setShownAt] = useState<number | null>(() => (wants ? mountedAt : null));
    const [holdExpired, setHoldExpired] = useState(false);
    const [now, setNow] = useState(() => Date.now());

    // Phase changes are made DURING render (React's "adjust state when props
    // change" pattern), so the very render that would paint a page of pills
    // re-renders with the layer before anything is committed.
    if (phase === 'hidden' && !done) {
        if (wants) setPhase('shown');
        else if (enabled && messages.length > 0) setDone(true);
    } else if (phase === 'shown' && !wants && (!decrypting || holdExpired)) {
        setPhase('exiting');
    }

    // The stall clock starts when the layer appears, not when the pane
    // mounted (it may have spent seconds fetching first).
    useEffect(() => {
        if (phase !== 'shown' || shownAt !== null) return;
        const t = setTimeout(() => { const at = Date.now(); setShownAt(at); setNow(at); }, 0);
        return () => clearTimeout(t);
    }, [phase, shownAt]);

    // Readable page, decrypt still running: cap the hold.
    const holding = phase === 'shown' && !wants && decrypting;
    useEffect(() => {
        if (!holding) return;
        const t = setTimeout(() => setHoldExpired(true), KEY_WAIT_DECRYPT_HOLD_MS);
        return () => clearTimeout(t);
    }, [holding]);

    useEffect(() => {
        if (phase !== 'exiting') return;
        const t = setTimeout(() => { setPhase('hidden'); setDone(true); }, reduced ? KEY_WAIT_REDUCED_EXIT_MS : KEY_WAIT_EXIT_MS);
        return () => clearTimeout(t);
    }, [phase, reduced]);

    // ── stage: real signals + the one honest timeout ─────────────────────
    const since = shownAt ?? Math.max(now, mountedAt);
    const computed = deriveKeyWaitStage(signals, since, now);
    useEffect(() => {
        if (phase !== 'shown' || shownAt === null) return;
        const at = nextStageDeadline(signals, shownAt, Date.now());
        if (at === null) return;
        const t = setTimeout(() => setNow(Date.now()), Math.max(0, at - Date.now()) + 20);
        return () => clearTimeout(t);
    }, [phase, signals, shownAt, now]);

    // Forward steps show at once; a backward step only after a hold; frozen
    // while leaving.
    const [stage, setStage] = useState<KeyWaitStage>(computed);
    if (phase !== 'exiting' && computed !== stage && STAGE_RANK[computed] >= STAGE_RANK[stage]) setStage(computed);
    useEffect(() => {
        if (phase === 'exiting' || computed === stage) return;
        const t = setTimeout(() => setStage(computed), KEY_WAIT_REGRESSION_HOLD_MS);
        return () => clearTimeout(t);
    }, [computed, stage, phase]);

    return {
        phase,
        stage,
        holdList: phase === 'shown',
        handoff: phase === 'exiting',
        reduced,
    };
}
