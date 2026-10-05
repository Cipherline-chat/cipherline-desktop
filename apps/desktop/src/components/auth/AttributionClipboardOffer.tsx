import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Link2 } from 'lucide-react';
import type { ParsedAttribution } from '../../utils/signupAttribution';

/**
 * First-launch offer: "You came here from a friend's link — use it?"
 *
 * Shown only when the sign-in screen's one-time clipboard check
 * (`peekClipboardOnce`) found one of OUR landing-page links, which the page
 * copied when the visitor clicked "Get Cipherline". It is an offer, not an
 * action: nothing is applied until the person clicks Use, and "No thanks" drops
 * it. The wording says what was looked at and why.
 */
export const AttributionClipboardOffer: React.FC<{
    found: ParsedAttribution;
    onUse: () => void;
    onDismiss: () => void;
}> = ({ found, onUse, onDismiss }) => {
    const reduce = useReducedMotion();
    const isRef = found.kind === 'ref';
    return (
        <motion.div
            role="region"
            aria-label="Link found"
            data-testid="attribution-clipboard-offer"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            style={{
                display: 'flex', alignItems: 'flex-start', gap: 12,
                padding: '12px 14px', borderRadius: 14,
                background: 'rgba(37,224,200,0.07)',
                border: '1px solid rgba(37,224,200,0.28)',
            }}
        >
            <span style={{ color: 'var(--cl-lume)', marginTop: 2, flexShrink: 0 }}><Link2 size={16} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--cl-text)' }}>
                    {isRef ? 'Use your friend’s invite link?' : 'Join the server you were invited to?'}
                </p>
                <p style={{ margin: '2px 0 8px', fontSize: 12, color: 'var(--cl-muted)', lineHeight: 1.35 }}>
                    {isRef
                        ? 'The link you followed to get Cipherline is on your clipboard. Using it adds your friend’s referral code for you.'
                        : 'The invite you followed to get Cipherline is on your clipboard. Using it offers you that server once your account is ready.'}
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button
                        type="button"
                        onClick={onUse}
                        className="text-[12px] font-bold"
                        style={{
                            border: 'none', cursor: 'pointer', borderRadius: 8, padding: '5px 12px',
                            background: 'var(--cl-lume)', color: '#06130f',
                        }}
                    >
                        Use it
                    </button>
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="text-[12px] text-cl-faint hover:text-cl-text transition-colors"
                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: '5px 8px' }}
                    >
                        No thanks
                    </button>
                </div>
            </div>
        </motion.div>
    );
};

export default AttributionClipboardOffer;
