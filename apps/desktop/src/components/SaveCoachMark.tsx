/**
 * SaveCoachMark — the one-time "you can save a message" coach mark.
 *
 * Mounted by ChatPane. It stays out of the way: unless THIS chat is a
 * one-to-one DM that auto-deletes, a message from the other person is there to
 * point at, the window is focused, and this account has never been shown it,
 * it renders nothing and does no work (the "already taught" flag short-circuits
 * before any scan of the message list).
 *
 * When it does show, it is a small card anchored just above that message
 * (the row already carries `id="msg-<id>"`), a caret pointing down at it. It
 * explains when messages here auto-delete and offers "Save this message" —
 * which performs the real save, so the lesson is the action. "Got it" or Esc
 * dismisses. One time per account: the flag is written the moment it is shown
 * (so a crash or a chat switch can never make it repeat), and it can be turned
 * off along with every other tip.
 *
 * Shape: the persisted flags and the "which message am I pointing at" slot are
 * both external stores read with useSyncExternalStore, so there is no state
 * machine of effects calling setState — the card is a pure function of
 * (flags, locked message, measured position).
 *
 * Accessibility: a polite live region announced on appearance (with the way
 * out spelled out), focus is never taken, Esc works through the shared escape
 * stack, both buttons are real buttons, and under prefers-reduced-motion it
 * simply appears.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Save, X } from 'lucide-react';
import { ClButton } from './cl';
import { useToast } from '../contexts/ToastContext';
import { useEscape } from '../hooks/useEscape';
import { coachSession, readNudgeStateRaw, subscribeNudgeState, updateNudgeState } from '../utils/firstWeekNudgeStore';
import { parseNudgeState } from '../utils/firstWeekNudges';
import type { MessageRetention } from '../hooks/useRetentionPolicy';
import { coachMayShow, pickSaveCoachTarget, saveCoachCopy, type CoachMessage } from '../utils/saveCoachMark';

interface Props {
    userId: string | null | undefined;
    /** Account creation time (`user.created_at`). */
    accountCreatedAt: string | null | undefined;
    /** One-to-one DM only: not a group, a server channel, or your own chat. */
    isOneToOneDm: boolean;
    /** The retention that applies to this chat ('never' = keeps forever → no mark). */
    retention: MessageRetention;
    messages: readonly CoachMessage[];
    myUserId: string | null | undefined;
    isSaved: (messageId: string) => boolean;
    /** Actually save it (the same call the Save button makes). */
    onSave: (messageId: string) => void;
    /** Window is focused and visible. */
    windowActive: boolean;
}

const CARD_W = 320;
const MARGIN = 8;
const EST_CARD_H = 150;

interface Placement { id: string; left: number; top: number; above: boolean; caretLeft: number }

/** Anchor above the message, flipping below when there is no room. */
function placeFor(id: string, el: HTMLElement, cardH: number): Placement | null {
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return null; // scrolled out of view
    const left = Math.max(MARGIN, Math.min(r.left + 48, window.innerWidth - CARD_W - MARGIN));
    const roomAbove = r.top - cardH - 12 >= 60; // keep clear of the chat header
    const top = roomAbove ? r.top - cardH - 10 : Math.min(r.bottom + 10, window.innerHeight - cardH - MARGIN);
    return { id, left, top, above: roomAbove, caretLeft: Math.max(16, Math.min(r.left + 64 - left, CARD_W - 28)) };
}

export const SaveCoachMark: React.FC<Props> = ({
    userId, accountCreatedAt, isOneToOneDm, retention, messages, myUserId, isSaved, onSave, windowActive,
}) => {
    const toast = useToast();

    // The account's persisted flags (and Settings flipping the off switch).
    const raw = useSyncExternalStore(
        subscribeNudgeState,
        () => (userId ? readNudgeStateRaw(userId) : ''),
        () => '',
    );
    const flags = useMemo(() => parseNudgeState(raw), [raw]);
    // Which message the mark is currently pointing at (in memory, this mount).
    const lockedId = useSyncExternalStore(coachSession.subscribe, coachSession.get, () => null);

    // A candidate only while the cheap gates hold — so an account that has been
    // taught (or has tips off) never scans its message list here.
    const canLook = !!userId && !flags.coachSaveDone && !flags.off && windowActive;
    const pick = useMemo(
        () => (canLook ? pickSaveCoachTarget({ isOneToOneDm, retention, messages, myUserId, isSaved }) : null),
        // isSaved changes identity every ChatPane render; the pick only needs to
        // follow the message list and the policy.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canLook, isOneToOneDm, retention, messages, myUserId],
    );

    // Claim the moment: lock the message, and write the one-time flag right away.
    useEffect(() => {
        if (!pick || lockedId || !userId) return;
        if (!coachMayShow({ done: flags.coachSaveDone, off: flags.off, createdAt: accountCreatedAt, now: Date.now(), windowActive })) return;
        // Only claim the one-time moment for a message that is actually on screen.
        if (!document.getElementById(`msg-${pick}`)) return;
        coachSession.lock(pick);
        updateNudgeState(userId, s => (s.coachSaveDone ? s : { ...s, coachSaveDone: true }));
    }, [pick, lockedId, userId, flags.coachSaveDone, flags.off, accountCreatedAt, windowActive]);

    // The slot belongs to this mount: leaving the chat releases it.
    useEffect(() => () => coachSession.release(), []);

    const targetId = lockedId && !flags.off && !isSaved(lockedId) ? lockedId : null;

    // Measured position, always set from a frame callback (never synchronously
    // in an effect), and only trusted when it was measured for THIS target.
    const [placed, setPlaced] = useState<Placement | null>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef(0);

    const measure = useCallback(() => {
        if (!targetId) return;
        const el = document.getElementById(`msg-${targetId}`);
        const h = cardRef.current?.offsetHeight || EST_CARD_H;
        setPlaced(el ? placeFor(targetId, el, h) : null);
    }, [targetId]);

    const schedule = useCallback(() => {
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; measure(); });
    }, [measure]);

    // Follow the message while it scrolls / the window resizes (one frame per burst).
    useLayoutEffect(() => {
        if (!targetId) return;
        schedule();
        document.addEventListener('scroll', schedule, { capture: true, passive: true });
        window.addEventListener('resize', schedule);
        return () => {
            document.removeEventListener('scroll', schedule, { capture: true });
            window.removeEventListener('resize', schedule);
            if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
        };
    }, [targetId, schedule, messages]);

    const place = placed && placed.id === targetId ? placed : null;
    const hasPlace = !!place;
    // First measure used an estimated height; re-measure once the real card exists.
    useLayoutEffect(() => { if (hasPlace) schedule(); }, [hasPlace, schedule]);

    const close = useCallback(() => coachSession.release(), []);
    // Only claim Escape while the card is actually on screen.
    useEscape(() => { close(); }, hasPlace);

    if (!targetId || !place) return null;

    const copy = saveCoachCopy(retention);
    return createPortal(
        <div
            ref={cardRef}
            role="status"
            aria-live="polite"
            aria-label={copy.title}
            className="fixed z-[9400] pointer-events-auto fade-rise-enter"
            style={{ left: place.left, top: place.top, width: CARD_W }}
        >
            <div className="relative bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl pl-4 pr-2 py-3">
                <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cl-lume rounded-l-xl" aria-hidden="true" />
                <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-white leading-tight m-0 flex items-center gap-1.5">
                            <Save size={13} className="text-cl-lume shrink-0" aria-hidden="true" /> {copy.title}
                        </p>
                        <p className="text-[12px] text-cl-muted leading-snug m-0 mt-1">{copy.body}</p>
                        <p className="text-[11px] text-cl-faint leading-snug m-0 mt-1">{copy.hint}</p>
                        <span className="sr-only">Press Escape to dismiss.</span>
                        <div className="flex items-center gap-2 mt-2.5">
                            <ClButton
                                size="sm"
                                variant="primary"
                                onClick={() => {
                                    onSave(targetId);
                                    toast.push({ kind: 'success', message: 'Saved. This one stays until you remove it.' });
                                    close();
                                }}
                            >
                                {copy.save}
                            </ClButton>
                            <ClButton size="sm" variant="ghost" onClick={close}>{copy.dismiss}</ClButton>
                        </div>
                    </div>
                    <ClButton icon size="sm" variant="ghost" onClick={close} tooltip="Dismiss">
                        <X size={14} />
                    </ClButton>
                </div>
                {/* Caret toward the message */}
                <span
                    aria-hidden="true"
                    className="absolute w-3 h-3 bg-cl-deep border-white/[0.08] rotate-45"
                    style={place.above
                        ? { left: place.caretLeft, bottom: -6, borderRightWidth: 1, borderBottomWidth: 1 }
                        : { left: place.caretLeft, top: -6, borderLeftWidth: 1, borderTopWidth: 1 }}
                />
            </div>
        </div>,
        document.body,
    );
};

export default SaveCoachMark;
