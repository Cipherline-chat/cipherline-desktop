import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
    STAGE_RANK, deriveKeyWaitStage, getKeyWaitSignals, hasEncryptedRows, isDecrypting, isGiveUpRemembered,
    isOpening, keyWaitBannerDueAt, keyWaitGiveUpAt, needsKeyWaitBanner, needsKeyWaitState, nextKeyWaitBanner,
    nextStageDeadline, noteKeyWaitGaveUp, subscribeKeyWaitSignals, summarizeNewestPage, type KeyWaitStage,
} from '../utils/channelKeyWait';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';

/**
 * Lifecycle of the whole-pane "getting this channel's keys" layer
 * (components/ChannelKeyWait.tsx; decision, stages and signals:
 * utils/channelKeyWait.ts).
 *
 * ChatPane keeps its header and composer; this replaces only the message list
 * while it is up. ChatPane remounts per channel, so every OPEN starts here:
 *
 *   hidden ─(page needs keys, open/decrypt still running)─▶ pending
 *   hidden ─(page needs keys, nothing running)───────────▶ shown
 *   pending ─(page healed)─▶ hidden            (no layer ever painted)
 *   pending ─(open settled / PENDING_MAX)─▶ shown
 *   shown ─(page readable, decrypt folded in)─▶ exiting ─▶ hidden, done
 *   shown ─(nobody answered: keyWaitGiveUpAt)─▶ exiting ─▶ hidden, done + banner
 *
 * `pending` holds the list back WITHOUT the layer: a channel whose keys are
 * already installed (the login prefetch got them) but whose cached rows are
 * still placeholders heals during the open's re-read — so it opens straight
 * into the feed, no animation and no frame of pills.
 *
 * `done` latches only once the pane has shown a page that does not need
 * keys — NOT on the first non-empty render: a joiner's "X joined the
 * server." line arrives before the history page, and used to latch the layer
 * off before the page of pills landed (the 2026-10-20 report).
 *
 * Giving up never traps anyone: the feed takes over with ONE banner
 * (`banner`) and consecutive placeholders collapse into one row (ChatPane,
 * keyMissingRuns). A remembered give-up (isGiveUpRemembered) or a key install
 * that keeps failing (`coolingOff`) skips the layer on the next open too.
 */

export type KeyWaitPhase = 'hidden' | 'pending' | 'shown' | 'exiting';

export const KEY_WAIT_EXIT_MS = 480;
export const KEY_WAIT_REDUCED_EXIT_MS = 160;
/** The page is readable but a decrypt is still folding rows in: hold the
 *  layer (so the rest of the page doesn't pop in as pills) — at most this long. */
export const KEY_WAIT_DECRYPT_HOLD_MS = 4_000;
/** A stage that would step BACKWARDS (received → asked) waits this long
 *  first: a decrypt finishing and its rows landing are two separate updates,
 *  and the layer must not flash "asking" in between. */
export const KEY_WAIT_REGRESSION_HOLD_MS = 800;
/** Longest the list is held back WITHOUT the layer while the open's re-read
 *  may still heal cached placeholders (keys already installed). */
export const KEY_WAIT_PENDING_MAX_MS = 1_200;

interface Row { id?: string; content?: unknown; sender_device_id?: string | null }

export interface ChannelKeyWaitState {
    phase: KeyWaitPhase;
    stage: KeyWaitStage;
    /** True while the message list must not render (pending, or layer up). */
    holdList: boolean;
    /** True during the exit: the list is fading in underneath. */
    handoff: boolean;
    reduced: boolean;
    /** The single "waiting for someone with the keys" banner over the feed:
     *  the feed shows waiting rows and the wait has gone unanswered. */
    banner: boolean;
    /** Rows of the newest page still waiting on a key. */
    waitingCount: number;
    /** The layer handed over without the keys (timeout, remembered, or the
     *  key install is cooling off). */
    gaveUp: boolean;
}

export function useChannelKeyWait({ enabled, channelId, messages, loading = false, coolingOff = false }: {
    enabled: boolean;
    channelId: string | null;
    messages: readonly Row[];
    /** The first history fetch of this channel is still in flight. */
    loading?: boolean;
    /** Installing this channel's key failed repeatedly; no retry for a while. */
    coolingOff?: boolean;
}): ChannelKeyWaitState {
    const reduced = usePrefersReducedMotion();
    const signals = useSyncExternalStore(
        subscribeKeyWaitSignals,
        () => getKeyWaitSignals(channelId),
        () => getKeyWaitSignals(channelId),
    );
    const newestKeyPending = !!signals.newestKeyPending;
    const wants = useMemo(
        () => enabled && needsKeyWaitState(messages, undefined, { newestKeyPending }),
        [enabled, messages, newestKeyPending],
    );
    const waitingCount = useMemo(
        () => (enabled ? summarizeNewestPage(messages).keyMissing : 0),
        [enabled, messages],
    );
    const decrypting = isDecrypting(signals);
    const refreshing = loading || isOpening(signals) || decrypting;

    const [mountedAt] = useState(() => Date.now());
    const [now, setNow] = useState(() => mountedAt);
    const blocked = coolingOff || isGiveUpRemembered(signals, now);

    const [phase, setPhase] = useState<KeyWaitPhase>('hidden');
    // Once the list has shown a page that needs no keys (or the layer has
    // left), the layer never comes back for this pane mount — a later
    // undecryptable live message must not make it flicker.
    const [done, setDone] = useState(false);
    const [gaveUp, setGaveUp] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    const [shownAt, setShownAt] = useState<number | null>(null);
    const [holdExpired, setHoldExpired] = useState(false);
    const [pendingExpired, setPendingExpired] = useState(false);

    // ── stage: real signals + the one honest timeout ─────────────────────
    const since = shownAt ?? Math.max(now, mountedAt);
    const computed = deriveKeyWaitStage(signals, since, now);
    const giveUpDue = phase === 'shown' && shownAt !== null && !decrypting && now >= keyWaitGiveUpAt(signals, shownAt);

    // Phase changes are made DURING render (React's "adjust state when props
    // change" pattern), so the very render that would paint a page of pills
    // re-renders held back before anything is committed.
    if (phase === 'hidden' && !done) {
        if (wants) {
            if (blocked) { setDone(true); setGaveUp(true); }
            else setPhase(refreshing && !pendingExpired ? 'pending' : 'shown');
        } else if (enabled && !refreshing && hasEncryptedRows(messages)) {
            setDone(true);
        }
    } else if (phase === 'pending') {
        if (!wants) setPhase('hidden');
        else if (blocked) { setPhase('hidden'); setDone(true); setGaveUp(true); }
        else if (!refreshing || pendingExpired) setPhase('shown');
    } else if (phase === 'shown') {
        if (!wants && (!decrypting || holdExpired)) setPhase('exiting');
        else if (wants && (coolingOff || giveUpDue)) {
            setPhase('exiting');
            setGaveUp(true);
            if (giveUpDue) setTimedOut(true);
        }
    }

    // Remember a timed-out wait for this channel (after commit: noting it
    // notifies every subscriber).
    useEffect(() => {
        if (timedOut && channelId) noteKeyWaitGaveUp(channelId);
    }, [timedOut, channelId]);

    // Pending is short by construction: cap it.
    useEffect(() => {
        if (phase !== 'pending') return;
        const t = setTimeout(() => setPendingExpired(true), KEY_WAIT_PENDING_MAX_MS);
        return () => clearTimeout(t);
    }, [phase]);

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

    // ── the fallback banner (nextKeyWaitBanner: a latch, so it cannot flap) ──
    const bannerWanted = useMemo(() => enabled && needsKeyWaitBanner(messages), [enabled, messages]);
    const [waitingSince, setWaitingSince] = useState<number | null>(null);
    useEffect(() => {
        setWaitingSince(prev => (bannerWanted ? (prev ?? Date.now()) : null));
    }, [bannerWanted]);
    const [bannerOn, setBannerOn] = useState(false);
    const bannerInput = {
        wanted: bannerWanted,
        layerUp: phase === 'shown' || phase === 'pending',
        gaveUp,
        waitingSince,
        now,
        signals,
        latched: bannerOn,
    };
    const bannerNext = nextKeyWaitBanner(bannerInput);
    if (bannerNext !== bannerOn) setBannerOn(bannerNext);
    const bannerDue = keyWaitBannerDueAt(bannerInput);

    // Wake up for the next stage change, the give-up, or the moment the
    // banner is due.
    useEffect(() => {
        let at: number | null = null;
        const t0 = Date.now();
        if (phase === 'shown' && shownAt !== null) {
            const stage = nextStageDeadline(signals, shownAt, t0);
            const give = keyWaitGiveUpAt(signals, shownAt);
            at = Math.min(stage ?? Infinity, give > t0 ? give : Infinity);
        } else if (bannerDue !== null) {
            at = bannerDue;
        }
        if (at === null || !Number.isFinite(at)) return;
        const t = setTimeout(() => setNow(Date.now()), Math.max(0, at - t0) + 20);
        return () => clearTimeout(t);
    }, [phase, signals, shownAt, now, bannerDue]);

    // Forward steps show at once; a backward step only after a hold; frozen
    // while leaving.
    const [stage, setStage] = useState<KeyWaitStage>(computed);
    if (phase !== 'exiting' && computed !== stage && STAGE_RANK[computed] >= STAGE_RANK[stage]) setStage(computed);
    useEffect(() => {
        if (phase === 'exiting' || computed === stage) return;
        const t = setTimeout(() => setStage(computed), KEY_WAIT_REGRESSION_HOLD_MS);
        return () => clearTimeout(t);
    }, [computed, stage, phase]);

    // The banner: the newest message on screen is waiting on a key, the
    // layer is not up, and either the layer gave up or that has lasted past
    // the stall budget with nothing arriving (nextKeyWaitBanner).
    const banner = bannerOn;

    return {
        phase,
        stage,
        holdList: phase === 'shown' || phase === 'pending',
        handoff: phase === 'exiting',
        reduced,
        banner,
        waitingCount,
        gaveUp,
    };
}
