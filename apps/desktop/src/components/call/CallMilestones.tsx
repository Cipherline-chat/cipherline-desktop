/**
 * CallMilestones: a small, passive moment inside a call (rules and clocks in
 * utils/callMilestones.ts). Mounted once per call inside <LiveKitRoom>
 * (CallPane), next to the other in-call guards. Renders nothing most of the time.
 *
 *   - Three hours continuously in the call: a small dismissable card,
 *     "Three hours in. Maybe stretch?", once per call. It uses the shared in-call
 *     offer surface (one card at a time, same corner as the other call cards) and
 *     fades itself after two minutes if nobody touches it.
 *   (The one-hour screen-share popcorn bucket was removed at the owner's
 *     request, 2026-10-20.)
 *
 * The card is portalled to <body> (like every in-call card here), never into the
 * call panel's own nodes, so no mount animation runs on a node that can be
 * re-parented.
 *
 * Only "am I in the call" is read; nothing about who, what or how many, and
 * nothing is sent anywhere.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useRoomContext } from '@livekit/components-react';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';
import { Clock, X } from 'lucide-react';
import { ClButton } from '../cl';
import { useCallOfferAnchor } from '../../hooks/useCallOfferAnchor';
import { acquireCallOfferSlot, releaseCallOfferSlot, CALL_OFFER_ENTER_CLASS } from '../../utils/performanceOffer';
import {
    LONG_CALL_MS, createMilestone,
} from '../../utils/callMilestones';

/** How often the clocks are checked (they use wall time, so this is only latency). */
export const MILESTONE_POLL_MS = 30_000;
/** The long-call card fades itself after this long if left alone. */
export const LONG_CALL_CARD_MS = 2 * 60 * 1000;
export const LONG_CALL_COPY = 'Three hours in. Maybe stretch?';
const SLOT_ID = 'longcall';

/** In the call: connected, or riding out a brief reconnect. */
export function inCall(state: ConnectionState): boolean {
    return state === ConnectionState.Connected
        || state === ConnectionState.Reconnecting
        || state === ConnectionState.SignalReconnecting;
}

/** Runs `check` now, on a slow poll, and whenever the room reports something that could change the answer. */
function useRoomWatch(room: Room, events: readonly RoomEvent[], check: () => void): void {
    const checkRef = useRef(check);
    useEffect(() => { checkRef.current = check; });
    useEffect(() => {
        const run = () => checkRef.current();
        run();
        const iv = window.setInterval(run, MILESTONE_POLL_MS);
        for (const e of events) room.on(e, run);
        return () => {
            window.clearInterval(iv);
            for (const e of events) room.off(e, run);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `events` is a module constant at both call sites
    }, [room]);
}

// ── Three hours in ───────────────────────────────────────────────────────────

const LongCallCard: React.FC<{ room: Room }> = ({ room }) => {
    const watcher = useRef(createMilestone({ afterMs: LONG_CALL_MS, once: true }));
    const [due, setDue] = useState(false);          // the threshold passed
    const [open, setOpen] = useState(false);        // the card is on screen
    const dismissed = useRef(false);

    useRoomWatch(room, [RoomEvent.ConnectionStateChanged], () => {
        if (watcher.current.update(inCall(room.state), Date.now())) setDue(true);
    });

    // Take the shared offer surface when it is free (another card up: wait, the poll retries).
    useEffect(() => {
        if (!due || open || dismissed.current) return;
        const tryOpen = () => { if (!dismissed.current && acquireCallOfferSlot(SLOT_ID)) setOpen(true); };
        tryOpen();
        const iv = window.setInterval(tryOpen, 5000);
        return () => window.clearInterval(iv);
    }, [due, open]);

    const close = useCallback(() => {
        dismissed.current = true;
        setOpen(false);
        releaseCallOfferSlot(SLOT_ID);
    }, []);
    useEffect(() => {
        if (!open) return;
        const t = window.setTimeout(close, LONG_CALL_CARD_MS);
        return () => window.clearTimeout(t);
    }, [open, close]);
    useEffect(() => () => releaseCallOfferSlot(SLOT_ID), []);

    const anchor = useCallOfferAnchor(open);
    if (!open || typeof document === 'undefined') return null;
    return ReactDOM.createPortal(
        <div className={anchor.className} style={anchor.style}>
            <div
                role="status"
                aria-live="polite"
                className={`${CALL_OFFER_ENTER_CLASS} pointer-events-auto flex items-center gap-3 pl-4 pr-2 py-2.5 bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/20 rounded-xl shadow-2xl`}
            >
                <span className="shrink-0 w-7 h-7 rounded-lg grid place-items-center text-cl-lume bg-cl-lume/10" aria-hidden="true">
                    <Clock size={15} />
                </span>
                <p className="flex-1 min-w-0 text-[13px] font-semibold text-white leading-snug m-0">{LONG_CALL_COPY}</p>
                <ClButton icon size="sm" variant="ghost" onClick={close} tooltip="Dismiss">
                    <X size={14} />
                </ClButton>
            </div>
        </div>,
        document.body,
    );
};

export const CallMilestones: React.FC = () => {
    const room = useRoomContext();
    return (
        <>
            <LongCallCard room={room} />
        </>
    );
};

export default CallMilestones;
