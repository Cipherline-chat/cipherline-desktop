import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, UserPlus } from 'lucide-react';
import { formatUserTag } from '@cipherline/shared';
import { useAuth } from '../../contexts/AuthContext';
import { API_BASE } from '../../constants';
import { clearReferrer, peekReferrer, type ReferrerTag } from '../../utils/signupAttribution';

/**
 * "Send a friend request to Sam#1234?" — offered once, right after signing up
 * with Sam's referral link.
 *
 * Self-gating: it renders only when sign-up left a remembered referrer for THIS
 * account (`rememberReferrer`, written by AuthScreen when the referral applied),
 * and forgets it as soon as the person answers either way — one-shot. It is an
 * OFFER: nothing is sent until the person clicks, and it goes through the same
 * `POST /v1/friends/request` as every other "Add friend" button, so Sam gets the
 * ordinary friend-request notification and the usual privacy rules apply (a
 * referrer who blocked the sender or turned friend requests off simply looks
 * like "not found", which is reported neutrally below).
 *
 * Hook point for the new onboarding: this component can be mounted by the final
 * "referral applied" screen instead of (or in addition to) Dashboard, or the
 * onboarding can call `peekReferrer(userId)` / `clearReferrer(userId)` itself.
 */
export const ReferrerFriendOffer: React.FC<{
    /** Wait this long before appearing so it lands after the app has settled. */
    delayMs?: number;
}> = ({ delayMs = 2800 }) => {
    const { user, token } = useAuth();
    const userId = user?.user_id ?? null;
    const reduce = useReducedMotion();

    const [dismissed, setDismissed] = useState(false);
    const [phase, setPhase] = useState<'hidden' | 'offer' | 'sending' | 'sent' | 'failed'>('hidden');
    // Read straight from the encrypted store (synchronous). The friend-request API
    // addresses people by username#discriminator, so a tag without one is no offer.
    const referrer: ReferrerTag | null = useMemo(() => {
        if (!userId || dismissed) return null;
        const tag = peekReferrer(userId);
        return tag && tag.discriminator !== null ? tag : null;
    }, [userId, dismissed]);

    useEffect(() => {
        if (!referrer) return;
        const t = setTimeout(() => setPhase('offer'), delayMs);
        return () => clearTimeout(t);
    }, [referrer, delayMs]);

    const finish = () => {
        if (userId) clearReferrer(userId);
        setPhase('hidden');
        setDismissed(true);
    };

    // Close the card itself a moment after a terminal state.
    useEffect(() => {
        if (phase !== 'sent' && phase !== 'failed') return;
        const t = setTimeout(finish, 3200);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase]);

    const send = async () => {
        if (!referrer || referrer.discriminator === null || !token) return;
        setPhase('sending');
        try {
            await axios.post(
                `${API_BASE}/friends/request`,
                { target_username: referrer.username, target_discriminator: referrer.discriminator },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            setPhase('sent');
        } catch (err) {
            // "Already friends" / "already sent" are fine outcomes; everything
            // else (including the neutral not-found) is just "couldn't".
            const status = axios.isAxiosError(err) ? err.response?.status : undefined;
            setPhase(status === 409 ? 'sent' : 'failed');
        }
    };

    const visible = phase !== 'hidden' && !!referrer;
    const tag = referrer ? formatUserTag(referrer.username, referrer.discriminator) : '';

    return (
        <AnimatePresence>
            {visible && (
                <motion.div
                    key="referrer-friend-offer"
                    role="status"
                    aria-live="polite"
                    data-testid="referrer-friend-offer"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
                    animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16 }}
                    transition={{ type: 'spring', stiffness: 360, damping: 30 }}
                    style={{
                        position: 'fixed', right: 20, bottom: 20, width: 340, zIndex: 9000,
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '14px 16px', borderRadius: 16,
                        background: 'linear-gradient(135deg, #0B1428 0%, #0e1e38 100%)',
                        border: '1px solid rgba(37,224,200,0.35)',
                        boxShadow: '0 8px 32px rgba(0,0,0,0.55), 0 0 24px rgba(37,224,200,0.16)',
                    }}
                >
                    <div style={{
                        width: 40, height: 40, borderRadius: 12, flexShrink: 0,
                        background: 'rgba(37,224,200,0.12)', color: 'var(--cl-lume)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        {phase === 'sent' ? <Check size={20} /> : <UserPlus size={20} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        {phase === 'sent' ? (
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--cl-text)' }}>Request sent to {tag}</p>
                        ) : phase === 'failed' ? (
                            <>
                                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--cl-text)' }}>Couldn't send that one</p>
                                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--cl-muted)' }}>You can still add {tag} from Friends.</p>
                            </>
                        ) : (
                            <>
                                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--cl-text)' }}>
                                    {tag} invited you
                                </p>
                                <p style={{ margin: '2px 0 8px', fontSize: 12, color: 'var(--cl-muted)' }}>Send them a friend request?</p>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => void send()}
                                        disabled={phase === 'sending'}
                                        className="text-[12px] font-bold"
                                        style={{
                                            border: 'none', borderRadius: 8, padding: '5px 12px',
                                            cursor: phase === 'sending' ? 'default' : 'pointer',
                                            background: 'var(--cl-lume)', color: '#06130f',
                                            opacity: phase === 'sending' ? 0.7 : 1,
                                        }}
                                    >
                                        {phase === 'sending' ? 'Sending…' : 'Send friend request'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={finish}
                                        className="text-[12px] text-cl-faint hover:text-cl-text transition-colors"
                                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '5px 8px' }}
                                    >
                                        Not now
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default ReferrerFriendOffer;
