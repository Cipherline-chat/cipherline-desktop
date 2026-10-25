/**
 * SafetyVerifyHint - the one-time "make sure it's really them" callout.
 *
 * Mounted by ChatPane INSIDE a `relative` wrapper around the chat-header shield
 * (TrustBadge), so it hangs off the control it is about and sits right after it
 * in the tab order: Tab from the shield lands on "Compare now". It renders
 * nothing, and does almost no work, unless every rule in
 * utils/safetyVerifyHint.ts holds (a real 1:1 DM with history, an unverified
 * contact, nobody ever verified, no call here, not the first minute after start,
 * and the hint not already finished for this account).
 *
 * It never takes focus (it appears unprompted, possibly while someone is typing
 * in the composer); it announces itself once through a polite live region, and
 * Escape - through the shared escape stack, only while the card is up - dismisses
 * it. "Compare now" opens the real safety-number dialog for this contact; "Not
 * now" just closes. Either button, Escape, verifying anyone by any route
 * (keyVerification.markVerified -> firstVerification), or the card having been up
 * for HINT_SEEN_MS finishes it for good.
 *
 * Motion: it rises and fades in with the app's `fade-rise-enter`, which index.css
 * already turns off under prefers-reduced-motion (it then simply appears).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';
import { deriveContactTrust } from '../utils/contactTrust';
import { contactTrustDevices } from '../utils/contactBadgeDevices';
import { hasVerifiedAnyone } from '../utils/keyVerification';
import { isTextLikeMessageType } from '../utils/messageMenuGating';
import { readNudgeState } from '../utils/firstWeekNudgeStore';
import {
    HINT_SEEN_MS, SAFETY_HINT_PRIMARY, SAFETY_HINT_SECONDARY, SAFETY_HINT_TITLE,
    countThreadSides, isHintDone, markHintDone, quietStartLeftMs, safetyHintBlocker, safetyHintBody,
    subscribeHintDone, type HintFacts,
} from '../utils/safetyVerifyHint';

interface Props {
    /** The signed-in account. */
    userId: string | null | undefined;
    /** The other person in this DM. */
    peerUserId: string | null | undefined;
    /** Their display name, for the sentence. */
    peerName: string;
    /** A real 1:1 DM: not a group, not a server channel, not your own notes. */
    isOneToOneDm: boolean;
    isSelfChat: boolean;
    /** A key-change / forgery warning is showing for this contact. */
    warningActive: boolean;
    /** The loaded thread. Only the kind and the sender of each row are read. */
    messages: ReadonlyArray<{ content?: { type?: string | null } | null }>;
    /** Is this row yours. */
    isMine: (m: never) => boolean;
    /** A call is live in this conversation. */
    callActiveHere: boolean;
    /** Open the safety-number dialog for this contact. */
    onCompare: () => void;
}

/** ms since this window started (performance.now() is measured from navigation start). */
const sinceAppStart = () => (typeof performance !== 'undefined' ? performance.now() : Number.MAX_SAFE_INTEGER);

export const SafetyVerifyHint: React.FC<Props> = ({
    userId, peerUserId, peerName, isOneToOneDm, isSelfChat, warningActive, messages, isMine, callActiveHere, onCompare,
}) => {
    const titleId = useId();
    const bodyId = useId();
    // Latched open: once it is up it stays until the user (or a verification) takes it down,
    // not until the "seen" record flips the store's flag.
    const [open, setOpen] = useState(false);
    // Re-evaluates the facts that change with time or storage rather than props.
    const [tick, bump] = useState(0);
    // The caller's `isMine` is a fresh closure every render; only the message list drives the count.
    const isMineRef = useRef(isMine);
    isMineRef.current = isMine;

    const cheap = !!userId && !!peerUserId && isOneToOneDm && !isSelfChat && !warningActive && !callActiveHere;
    const counts = useMemo(
        () => (cheap ? countThreadSides(messages, m => isMineRef.current(m as never), isTextLikeMessageType) : null),
        [cheap, messages],
    );
    const messagesFromMe = counts?.mine ?? 0;
    const messagesFromThem = counts?.theirs ?? 0;

    // Everything the pure rule needs, read lazily: the scans below only run once the cheap gates passed.
    const facts = useMemo((): HintFacts | null => {
        if (!cheap || !userId || !peerUserId) return null;
        let verifiedAnyone = true;                       // unknown = do not nudge
        let trustLevel: HintFacts['trustLevel'] = 'unverifiable';
        let tipsOff = true;
        try { verifiedAnyone = hasVerifiedAnyone(userId); } catch { /* unknown */ }
        try { trustLevel = deriveContactTrust({ devices: contactTrustDevices(userId, peerUserId) }).level; } catch { /* unknown */ }
        try { tipsOff = readNudgeState(userId).off; } catch { /* unknown */ }
        return {
            isOneToOneDm, isSelfChat, trustLevel, warningActive, verifiedAnyone,
            messagesFromMe, messagesFromThem, callActiveHere,
            sinceAppStartMs: sinceAppStart(), alreadyDone: isHintDone(userId), tipsOff,
        };
        // `tick` is a deliberate dependency: the start-up quiet period ends with time, and
        // "someone was verified" / "the hint was finished" arrive as storage events.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cheap, messagesFromMe, messagesFromThem, userId, peerUserId, isOneToOneDm, isSelfChat, warningActive, callActiveHere, tick]);

    const blocker = facts ? safetyHintBlocker(facts) : 'not-ready';
    // While it is up, "done" (the seen record) and the start-up quiet rule no longer matter; the rest still do.
    const stillOk = !!facts && safetyHintBlocker({ ...facts, alreadyDone: false, sinceAppStartMs: Number.MAX_SAFE_INTEGER }) === null;

    // Open it once everything holds; take it down when the conversation stops qualifying
    // (a chat switch, a call starting). It is finished only when the user acts or it was seen.
    useEffect(() => {
        if (!open && blocker === null) setOpen(true);
        else if (open && !stillOk) setOpen(false);
    }, [open, blocker, stillOk]);

    // The quiet start: if the only thing in the way is the clock, wake up when it ends.
    useEffect(() => {
        if (open || blocker !== 'just-started') return;
        const t = window.setTimeout(() => bump(n => n + 1), quietStartLeftMs(sinceAppStart()) + 50);
        return () => window.clearTimeout(t);
    }, [open, blocker]);

    const shown = open && stillOk;

    // Verifying anyone, or a button / Escape elsewhere, takes the card down; "seen" alone leaves it up.
    useEffect(() => subscribeHintDone(reason => {
        if (reason === 'seen') return;
        setOpen(false);
        bump(n => n + 1);
    }), []);

    // On screen long enough to count as seen: finished for good (the card itself stays until dismissed).
    useEffect(() => {
        if (!shown) return;
        const t = window.setTimeout(() => markHintDone(userId, 'seen'), HINT_SEEN_MS);
        return () => window.clearTimeout(t);
    }, [shown, userId]);

    const close = useCallback(() => {
        setOpen(false);
        markHintDone(userId, 'closed');
    }, [userId]);
    const compare = useCallback(() => {
        close();
        onCompare();
    }, [close, onCompare]);

    // Escape only while the card is actually on screen.
    useEscape(() => { close(); }, shown);

    // The announcement is a separate live region that is already in the DOM when its text arrives.
    if (!shown) return null;

    const name = peerName || 'them';
    return (
        <>
            <span className="sr-only" role="status" aria-live="polite">
                {SAFETY_HINT_TITLE}. Press Escape to dismiss.
            </span>
            <div
                role="dialog"
                aria-modal={false}
                aria-labelledby={titleId}
                aria-describedby={bodyId}
                data-testid="safety-verify-hint"
                className="absolute right-[-6px] top-full mt-3 z-[60] w-[300px] fade-rise-enter cursor-default"
                // The card sits in the header, whose row is clickable in places; nothing here should bubble to it.
                onClick={e => e.stopPropagation()}
            >
                <div className="relative bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl px-4 py-3 text-left">
                    <p id={titleId} className="text-[13px] font-semibold text-white leading-tight m-0 flex items-center gap-1.5">
                        <ShieldQuestion size={14} className="text-cl-glow shrink-0" aria-hidden="true" /> {SAFETY_HINT_TITLE}
                    </p>
                    <p id={bodyId} className="text-[12px] text-cl-muted leading-snug m-0 mt-1.5">{safetyHintBody(name)}</p>
                    <div className="flex items-center gap-2 mt-3">
                        <ClButton size="sm" variant="primary" onClick={compare}>{SAFETY_HINT_PRIMARY}</ClButton>
                        <ClButton size="sm" variant="ghost" onClick={close}>{SAFETY_HINT_SECONDARY}</ClButton>
                    </div>
                    {/* Caret toward the shield */}
                    <span
                        aria-hidden="true"
                        className="absolute w-3 h-3 bg-cl-deep border-white/[0.08] rotate-45"
                        style={{ right: 17, top: -6, borderLeftWidth: 1, borderTopWidth: 1 }}
                    />
                </div>
            </div>
        </>
    );
};

export default SafetyVerifyHint;
