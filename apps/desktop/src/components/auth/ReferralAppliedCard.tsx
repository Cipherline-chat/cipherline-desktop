import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check } from 'lucide-react';
import { formatUserTag } from '@cipherline/shared';

/**
 * "Referral code applied — invited by Sam#1234."
 *
 * Shown on the sign-up form the moment a referral code resolves (from a deep
 * link, the first-launch clipboard offer, or typed by hand), so the person SEES
 * that the code took and whose it is. The avatar is an initial, not a picture:
 * profile pictures are end-to-end encrypted for contacts, and this person is a
 * stranger to the account being created, so there is nothing a stranger could
 * decrypt.
 *
 * It also says, plainly, that the referrer will be told — the sign-up sends them
 * a "joined with your link" event carrying this person's public tag. Saying so
 * here is the consent surface for that; removing the code (the link) prevents it.
 *
 * Presentational only: the resolve call and the one-shot clearing live in
 * AuthScreen / utils/signupAttribution.
 */
export const ReferralAppliedCard: React.FC<{
    username: string;
    discriminator: number | null;
    /** Days the referral grants (the form's existing "+7 free days" copy). */
    bonusDays?: number;
    onRemove?: () => void;
    disabled?: boolean;
}> = ({ username, discriminator, bonusDays = 7, onRemove, disabled }) => {
    const reduce = useReducedMotion();
    const tag = formatUserTag(username, discriminator);
    return (
        <motion.div
            role="status"
            aria-live="polite"
            data-testid="referral-applied-card"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.96 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '12px 14px', borderRadius: 14,
                background: 'rgba(37,224,200,0.08)',
                border: '1px solid rgba(37,224,200,0.32)',
                boxShadow: '0 0 20px rgba(37,224,200,0.10)',
            }}
        >
            <div style={{ position: 'relative', flexShrink: 0 }}>
                <div
                    aria-hidden
                    style={{
                        width: 38, height: 38, borderRadius: 12,
                        background: 'rgba(37,224,200,0.16)', color: 'var(--cl-lume)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 800, fontSize: 16, textTransform: 'uppercase',
                    }}
                >
                    {username.charAt(0)}
                </div>
                <motion.span
                    aria-hidden
                    initial={reduce ? false : { scale: 0, rotate: -40 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={{ type: 'spring', stiffness: 520, damping: 18, delay: reduce ? 0 : 0.18 }}
                    style={{
                        position: 'absolute', right: -5, bottom: -5,
                        width: 18, height: 18, borderRadius: 999,
                        background: 'var(--cl-lume)', color: '#06130f',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '2px solid #0B0F1E',
                    }}
                >
                    <Check size={11} strokeWidth={3.4} />
                </motion.span>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--cl-text)' }}>
                    Invited by <span style={{ color: 'var(--cl-lume)' }}>{tag}</span>
                </p>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--cl-muted)', lineHeight: 1.35 }}>
                    Referral applied: +{bonusDays} free days for you both. They'll see that you joined with their link.
                </p>
            </div>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    disabled={disabled}
                    className="text-[12px] text-cl-faint hover:text-cl-text transition-colors"
                    style={{ border: 'none', background: 'none', cursor: disabled ? 'default' : 'pointer', padding: 4, flexShrink: 0 }}
                >
                    Remove
                </button>
            )}
        </motion.div>
    );
};

export default ReferralAppliedCard;
