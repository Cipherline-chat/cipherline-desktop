/**
 * The one-time "Show what you're listening to?" card. Mounted once by Dashboard;
 * renders nothing almost all of the time. The rules are in
 * utils/integrations/listeningAsk.ts.
 *
 * Once this account's records are loaded and it may be asked, this listens for
 * input and nothing else: no timer. A click or scroll while the person is here,
 * after the boot grace and at most every LISTENING_ASK_CHECK_MS, makes one
 * yes-or-no look in the main process. With the window hidden or unfocused there
 * is no such input, so there is no look either. A "yes" shows the card right
 * away, so the music is playing when it appears. Otherwise the next look decides.
 *
 * As soon as the question is shown, or the account stops being eligible, the
 * listeners are removed and nothing looks again.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Headphones } from 'lucide-react';
import { ClButton } from '../cl';
import { useToast } from '../../contexts/ToastContext';
import {
    canDetectMusic, isCalmMoment, isMusicPlaying, LISTENING_ASK_AUTO_HIDE_MS, LISTENING_ASK_CHECK_MS, LISTENING_ASK_COPY, LISTENING_ASK_GRACE_MS,
    listeningAskGate, markListeningAsked, resetListeningAskForTesting,
} from '../../utils/integrations/listeningAsk';
import { setListeningPrefs, useListeningPrefs } from '../../utils/integrations/listeningPrefs';
import secureLocalStore from '../../utils/secureLocalStore';

/** The card itself: no state, and no prop that could carry what is playing. */
export const ListeningAskCard: React.FC<{ onEnable: () => void; onDecline: () => void }> = ({ onEnable, onDecline }) => (
    <div data-corner-card className="fixed top-14 right-4 z-[9500] w-[340px] max-w-[calc(100vw-2rem)] pointer-events-none">
        <div
            role="status"
            aria-live="polite"
            aria-label={LISTENING_ASK_COPY.title}
            data-testid="listening-ask"
            className="pointer-events-auto relative flex items-start gap-3 pl-4 pr-4 py-3 bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl overflow-hidden fade-rise-enter"
        >
            <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cl-lume" aria-hidden="true" />
            <span className="shrink-0 mt-0.5 w-8 h-8 rounded-lg grid place-items-center text-cl-lume bg-cl-lume/10" aria-hidden="true">
                <Headphones size={17} />
            </span>
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-white leading-tight m-0">{LISTENING_ASK_COPY.title}</p>
                <p className="text-[12px] text-cl-muted leading-snug m-0 mt-0.5 break-words">{LISTENING_ASK_COPY.body}</p>
                <p className="text-[11px] text-cl-muted leading-snug m-0 mt-0.5 break-words">{LISTENING_ASK_COPY.note}</p>
                <div className="flex items-center gap-2 mt-2.5">
                    <ClButton size="sm" variant="primary" onClick={onEnable}>{LISTENING_ASK_COPY.enable}</ClButton>
                    <ClButton size="sm" variant="ghost" onClick={onDecline}>{LISTENING_ASK_COPY.decline}</ClButton>
                </div>
            </div>
        </div>
    </div>
);

export const ListeningAskHost: React.FC<{
    userId: string | null;
    /** Loading, locked, or in / answering a call. Holds the question back, and withdraws a card that is up. */
    busy: boolean;
    /** Onboarding, Settings, a first-run prompt. Holds the question back only. */
    uiBusy: boolean;
    isDnd: () => boolean;
    onOpenChange?: (open: boolean) => void;
}> = ({ userId, busy, uiBusy, isDnd, onOpenChange }) => {
    const toast = useToast();
    const [openFor, setOpenFor] = useState<string | null>(null);
    const open = !!userId && openFor === userId;
    // Re-gates when the switch is flipped in Settings: turning it on or off is an answer.
    const { share } = useListeningPrefs(userId);

    const latest = useRef({ busy, uiBusy, isDnd });
    useEffect(() => { latest.current = { busy, uiBusy, isDnd }; });

    useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

    useEffect(() => {
        if (!userId || !canDetectMusic()) return;
        let cancelled = false;
        let disarm: (() => void) | null = null;

        const arm = () => {
            const armedAt = Date.now();
            let lastLook = 0;
            let looking = false;
            let lastInputAt = 0;
            let lastKeyAt = 0;
            const calm = () => {
                const l = latest.current;
                return isCalmMoment({
                    now: Date.now(), focused: document.hasFocus(), visible: !document.hidden, lastInputAt, lastKeyAt,
                    busy: l.busy, uiBusy: l.uiBusy, dnd: l.isDnd(), fullscreen: !!document.fullscreenElement,
                    covered: !!document.querySelector('[role="dialog"][aria-modal="true"], [data-corner-card]'),
                });
            };
            const onKey = () => { lastKeyAt = Date.now(); lastInputAt = lastKeyAt; };
            const onPointer = () => { lastInputAt = Date.now(); void look(); };
            const look = async () => {
                const now = Date.now();
                if (looking || now - armedAt < LISTENING_ASK_GRACE_MS || now - lastLook < LISTENING_ASK_CHECK_MS || !calm()) return;
                if (listeningAskGate(userId) !== 'eligible') { disarm?.(); return; }
                lastLook = now;
                looking = true;
                const playing = await isMusicPlaying();
                looking = false;
                if (cancelled || !playing || !calm() || listeningAskGate(userId) !== 'eligible') return;
                // No more looks from this moment on, then the record, then the card.
                disarm?.();
                if (await markListeningAsked(userId) && !cancelled) setOpenFor(userId);
            };
            document.addEventListener('keydown', onKey, { capture: true, passive: true });
            document.addEventListener('pointerdown', onPointer, { capture: true, passive: true });
            document.addEventListener('wheel', onPointer, { capture: true, passive: true });
            disarm = () => {
                disarm = null;
                document.removeEventListener('keydown', onKey, { capture: true });
                document.removeEventListener('pointerdown', onPointer, { capture: true });
                document.removeEventListener('wheel', onPointer, { capture: true });
            };
        };

        void (async () => {
            // Per-account records are cold right after a sign-in: reading earlier would look like "never asked".
            for (let i = 0; i < 5 && !cancelled && !secureLocalStore.isAccountReady(userId); i++) {
                try { await secureLocalStore.whenAccountReady(); } catch { /* re-checked below */ }
            }
            if (!cancelled && listeningAskGate(userId) === 'eligible') arm();
        })();

        return () => {
            cancelled = true;
            disarm?.();
        };
    }, [userId, share]);

    // A call or the lock screen arriving takes it down, for good: the record is already written.
    if (open && busy) setOpenFor(null);
    // Left alone, it goes.
    useEffect(() => {
        if (!open) return;
        const t = setTimeout(() => setOpenFor(null), LISTENING_ASK_AUTO_HIDE_MS);
        return () => clearTimeout(t);
    }, [open]);

    const enable = useCallback(() => {
        setOpenFor(null);
        if (!userId) return;
        setListeningPrefs(userId, { share: true });
        toast.push({ kind: 'success', message: LISTENING_ASK_COPY.enabled });
    }, [userId, toast]);
    const decline = useCallback(() => setOpenFor(null), []);

    // Dev builds only, for seeing the question again (it is once ever): run this in DevTools, then reload.
    useEffect(() => {
        if (!import.meta.env.DEV || !userId) return;
        const w = window as unknown as { __clListeningAskReset?: () => void };
        w.__clListeningAskReset = () => resetListeningAskForTesting(userId);
        return () => { delete w.__clListeningAskReset; };
    }, [userId]);

    return open && !busy ? <ListeningAskCard onEnable={enable} onDecline={decline} /> : null;
};

export default ListeningAskHost;
