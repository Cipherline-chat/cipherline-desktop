/**
 * The `pro_gift` chat card. The E2EE message carries the gift id and nothing
 * else, so the card's whole state comes from the server's buyer/recipient-only
 * read (GET /billing/gifts/:id): a forged or replayed card can show nothing the
 * viewer is not already entitled to see — a third party just gets "isn't
 * available". It re-reads on mount and whenever the server pushes
 * `gift:updated` for this id (paid / accepted / refunded on any device).
 *
 * Accept (recipient + paid): POST /redeem, then the unwrap plays (~1.3 s; with
 * reduced motion a ~0.9 s opacity cross-fade instead) and the card settles on
 * the opened state. Pro is unlocked by refreshing the shared subscription
 * status AFTER the unwrap, and the full-screen Pro welcome plays after it too,
 * so the celebration follows the box instead of covering it. "After" means the
 * unwrap's final keyframe actually ended (GiftBox onUnwrapped), with a safety
 * fallback a little longer than the animation; a hidden window waits until it
 * is visible again (owner 2026-11-18: the welcome must never come first).
 * Double-clicks are ignored while a redeem is in flight; a retry or another
 * device's accept (`already: true`) goes straight to the opened state.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { AlertTriangle, Gift, RefreshCw } from 'lucide-react';
import { apiErrorMessage, type GiftView } from '@cipherline/shared';
import { ClButton, ClSkeleton } from '../../cl';
import { useSubscription } from '../../../contexts/SubscriptionContext';
import { GiftBox, UNWRAP_FADE_MS, UNWRAP_MS, type GiftBoxState } from './GiftBox';
import { useGiftActions } from './GiftActionsContext';
import { onGiftUpdated } from './giftEvents';
import { useGiftsApi, isGiftNotFound } from './giftsApi';
import { giftArtFor, giftCardCopy, giftCardKind, redeemedOutcomeLine, type GiftFetchState } from './giftCopy';
import '../../../styles/gifts.css';

export interface GiftCardEmbedProps {
    giftId: string;
    /** I sent the message that carries this card. */
    isMine: boolean;
    /** Display name of the message's sender. */
    senderName: string;
}

export { UNWRAP_MS, UNWRAP_FADE_MS };
/** The safety fallback fires this long after the unwrap's nominal end if its
 *  animationend never arrives (an animation that never ran, a dropped event). */
export const UNWRAP_FALLBACK_GRACE_MS = 400;
/** After a hidden window becomes visible again: time for the (time-based)
 *  animation's end event to land before the fallback completes the unwrap. */
export const UNWRAP_VISIBLE_GRACE_MS = 250;

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

export const GiftCardEmbed: React.FC<GiftCardEmbedProps> = ({ giftId, isMine, senderName }) => {
    const api = useGiftsApi();
    const { nameFor } = useGiftActions();
    const { refresh, celebratePro } = useSubscription();
    /** The Pro welcome plays at most once per card, and only on the device
     *  whose Accept actually redeemed (never for `already`). */
    const celebrated = useRef(false);
    const reduced = useReducedMotion();
    const [fetchState, setFetchState] = useState<GiftFetchState>({ view: null, loading: true, notFound: false, failed: false });
    const [redeeming, setRedeeming] = useState(false);
    const [unwrapping, setUnwrapping] = useState(false);
    /** The opened text animates in once, right after an unwrap this card played. */
    const [reveal, setReveal] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [announce, setAnnounce] = useState('');
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);
    /** What runs once the unwrap has finished (refresh + maybe the welcome);
     *  null when no unwrap is pending. Taking it makes finishing exactly-once. */
    const afterUnwrap = useRef<(() => void) | null>(null);
    const [hiddenWait, setHiddenWait] = useState(0);
    const finishUnwrap = useCallback(() => {
        if (!afterUnwrap.current || !alive.current) return;
        // Never finish into a hidden window: the welcome would play unseen (or
        // be the first thing on screen). Wait for it to be visible again.
        if (isHidden()) { setHiddenWait((n) => n + 1); return; }
        const then = afterUnwrap.current;
        afterUnwrap.current = null;
        setUnwrapping(false);
        setReveal(true);
        then();
    }, []);

    // Safety fallback, armed once the unwrap is actually on screen (after the
    // commit, so a slow render cannot eat into it): a little longer than the
    // animation, so it only ever fires when animationend did not.
    useEffect(() => {
        if (!unwrapping) return;
        const t = setTimeout(finishUnwrap, (reduced ? UNWRAP_FADE_MS : UNWRAP_MS) + UNWRAP_FALLBACK_GRACE_MS);
        return () => clearTimeout(t);
    }, [unwrapping, reduced, finishUnwrap]);

    // The window was hidden when the unwrap would have finished: on return,
    // give the animation's end event a moment, then finish regardless.
    useEffect(() => {
        if (!hiddenWait) return;
        let t: ReturnType<typeof setTimeout> | null = null;
        const onVisibility = () => {
            if (isHidden() || t) return;
            t = setTimeout(finishUnwrap, UNWRAP_VISIBLE_GRACE_MS);
        };
        document.addEventListener('visibilitychange', onVisibility);
        onVisibility();
        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            if (t) clearTimeout(t);
        };
    }, [hiddenWait, finishUnwrap]);

    // Each load is tagged so a slow response cannot overwrite a newer one.
    const loadSeq = useRef(0);
    const load = useCallback(async () => {
        const seq = ++loadSeq.current;
        setFetchState((s) => ({ ...s, loading: true, failed: false }));
        try {
            const view = await api.get(giftId);
            if (!alive.current || seq !== loadSeq.current) return;
            setFetchState({ view, loading: false, notFound: false, failed: false });
        } catch (err) {
            if (!alive.current || seq !== loadSeq.current) return;
            setFetchState((s) => (isGiftNotFound(err)
                ? { view: null, loading: false, notFound: true, failed: false }
                // A refetch that fails keeps showing the last good state.
                : { ...s, loading: false, failed: true }));
        }
    }, [api, giftId]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => onGiftUpdated((id) => { if (id === giftId) void load(); }), [giftId, load]);

    // A ref, not the state: two clicks inside one frame both see redeeming=false.
    const busy = useRef(false);
    const accept = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        setRedeeming(true);
        setError(null);
        try {
            const res = await api.redeem(giftId);
            if (!alive.current) return;
            loadSeq.current++; // the redeem answer is newer than any read in flight
            setFetchState({ view: res.gift, loading: false, notFound: false, failed: false });
            setRedeeming(false);
            // busy stays set: this gift is accepted, there is nothing left to click.
            const line = redeemedOutcomeLine(res.gift);
            setAnnounce(`Gift accepted.${line ? ` ${line}.` : ''}`);
            // Owner 2026-11-17: after the unwrap, the usual full-screen Pro
            // welcome plays. Only for a Pro TIME grant (a subscriber's credit
            // changes nothing they can see), only when this click redeemed it,
            // and only AFTER the unwrap. Owner 2026-11-18: that holds with
            // reduced motion too — the unwrap is then a cross-fade, not skipped
            // — so unlock() always runs from finishUnwrap(), never directly.
            const welcome = !res.already && res.outcome === 'time';
            const unlock = () => {
                refresh().catch(() => { /* statusError is recorded by the context */ });
                if (welcome && !celebrated.current) {
                    celebrated.current = true;
                    celebratePro();
                }
            };
            if (res.already) {
                unlock();
                return;
            }
            afterUnwrap.current = unlock;
            setUnwrapping(true);
        } catch (err) {
            busy.current = false;
            if (!alive.current) return;
            setRedeeming(false);
            if (isGiftNotFound(err)) {
                setFetchState({ view: null, loading: false, notFound: true, failed: false });
                return;
            }
            setError(apiErrorMessage(err, 'Couldn’t accept the gift. Please try again.'));
            // The gift may have changed under us (refunded, accepted elsewhere).
            void load();
        }
    }, [api, giftId, refresh, celebratePro, load]);

    const view: GiftView | null = fetchState.view;
    const kind = giftCardKind(fetchState);
    // While the unwrap plays, the server already says "redeemed"; the art runs
    // the transition and the words wait for it to finish.
    const shownKind = unwrapping ? 'unopened' : kind;
    const otherName = view ? nameFor(view.other_user_id) : null;
    const copy = giftCardCopy(shownKind, view, { senderName: isMine ? null : senderName, otherName });
    const art: GiftBoxState = unwrapping ? 'unwrapping' : giftArtFor(kind);
    const label = isMine ? 'Cipherline Pro gift you sent' : 'Cipherline Pro gift';

    return (
        <div
            className="gft-card"
            role="group"
            aria-label={label}
            aria-busy={kind === 'loading' || undefined}
            data-kind={shownKind}
            data-muted={copy.muted ? 'true' : 'false'}
            data-reveal={reveal ? 'true' : undefined}
            data-testid="gift-card"
        >
            <div className="gft-stage">
                {kind === 'loading'
                    ? <ClSkeleton style={{ width: 84, height: 84, borderRadius: 20, marginBottom: 10 }} />
                    : <GiftBox state={art} size={112} onUnwrapped={finishUnwrap} />}
            </div>
            <div className="gft-body">
                {kind === 'loading' ? (
                    <div className="gft-skel" aria-label="Loading gift">
                        <ClSkeleton style={{ width: 110, height: 10 }} />
                        <ClSkeleton style={{ width: 210, height: 16 }} />
                    </div>
                ) : (
                    <>
                        <div className="gft-eyebrow"><Gift size={12} aria-hidden /> {copy.eyebrow}</div>
                        <div className="gft-title">{copy.title}</div>
                        {copy.detail && <div className="gft-detail">{copy.detail}</div>}
                    </>
                )}

                {shownKind === 'unopened' && (
                    <div className="gft-actions">
                        <ClButton
                            fullWidth
                            onClick={() => { void accept(); }}
                            loading={redeeming}
                            disabled={unwrapping}
                        >
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                                <Gift size={16} aria-hidden /> Accept gift
                            </span>
                        </ClButton>
                    </div>
                )}

                {kind === 'error' && (
                    <div className="gft-actions">
                        <button type="button" className="gft-link" onClick={() => { void load(); }} disabled={fetchState.loading}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><RefreshCw size={13} aria-hidden /> Try again</span>
                        </button>
                    </div>
                )}

                {error && (
                    <div className="gft-err" role="alert">
                        <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0 }} aria-hidden /> {error}
                    </div>
                )}
            </div>
            <div className="sr-only" role="status" aria-live="polite">{announce}</div>
        </div>
    );
};

export default GiftCardEmbed;
