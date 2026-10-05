/**
 * Compact identity-verification badge.
 *
 * Replaces the paragraph-sized "Unverified caller" disclaimer that used to sit
 * on the incoming-call screen. That disclaimer had two problems: it only knew
 * two states (verified / not), and at ~two lines of amber prose on a ringing
 * call it was both easy to ignore and impossible to read in the two seconds a
 * user actually spends deciding whether to answer.
 *
 * The icon carries the state; the tooltip carries the reason. Colour is never
 * the only channel — the icon SHAPE differs per level too (check / half /
 * question / alert / off), so the badge still reads under the several forms of
 * colour-vision deficiency, and the accessible name spells the state out.
 *
 * All state comes from `contactTrust.deriveContactTrust`, which is the single
 * composition of senderTrust's per-envelope verdict and keyVerification's pin
 * store. Nothing here re-derives trust — a badge that computed its own notion
 * of "verified" is exactly how the green shield starts disagreeing with the
 * gate that actually refuses key material.
 */

import React from 'react';
import { ShieldCheck, ShieldEllipsis, ShieldHalf, ShieldQuestion, ShieldAlert, ShieldOff } from 'lucide-react';
import { useClTooltip } from './cl/useClTooltip';
import { trustLabel, trustExplanation, type ContactTrust } from '../utils/contactTrust';
import { verdictMessage } from '../utils/senderTrust';

interface Props {
    trust: ContactTrust;
    /** Contact name, woven into the explanation so it reads as a sentence. */
    displayName: string;
    /** Renders the label next to the icon. Off for tight rows (a call screen). */
    showLabel?: boolean;
    size?: number;
    /** When supplied the badge becomes a button — used to open the verify modal. */
    onClick?: () => void;
    className?: string;
}

/**
 * Per-level presentation.
 *
 * `partially_verified` is deliberately in the amber family, NOT green. Green
 * is a claim about the whole contact, and "3 of their 4 devices" is not that
 * claim — everything sent into the conversation reaches the unverified one too.
 * It gets the half-shield so it is still distinguishable at a glance from a
 * contact nothing is known about.
 *
 * `compromised` covers all three warnable senderTrust verdicts and is red.
 * `unrecognized_verified` lands here rather than in amber on purpose: a
 * verified contact presenting a key you never vouched for is strictly worse
 * than one you simply never got round to verifying, and amber reads as the
 * latter.
 */
const PRESENTATION = {
    verified:           { Icon: ShieldCheck,    color: 'var(--cl-ok)' },
    // Pre-v2 verification. Its own shape (ellipsis: "one more step") and the
    // brand accent rather than amber or red: nothing is known to be wrong, and
    // a colour that reads as a warning would teach every verified user to
    // ignore warnings on the day of the upgrade.
    verified_legacy:    { Icon: ShieldEllipsis, color: 'var(--cl-lume)' },
    partially_verified: { Icon: ShieldHalf,     color: 'var(--cl-glow)' },
    unverified:         { Icon: ShieldQuestion, color: 'var(--cl-glow)' },
    unverifiable:       { Icon: ShieldOff,      color: 'var(--cl-muted)' },
    compromised:        { Icon: ShieldAlert,    color: 'var(--cl-flash)' },
} as const;

export const TrustBadge: React.FC<Props> = ({
    trust, displayName, showLabel = false, size = 16, onClick, className = '',
}) => {
    const { Icon, color } = PRESENTATION[trust.level];
    const label = trustLabel(trust);

    // For a warnable verdict prefer senderTrust's own wording: it distinguishes
    // "their key changed" from "the server doesn't publish this key" from
    // "they presented a key you never vouched for", which are three different
    // things to do next. `trustExplanation` is only the fallback for a
    // contact-level badge that had no envelope verdict to carry through.
    const detail = (trust.level === 'compromised' && trust.verdict)
        ? verdictMessage(trust.verdict, displayName)
        : trustExplanation(trust, displayName);

    // Memoized because `useClTooltip` re-measures whenever `text` changes
    // identity. An inline JSX node is a new object every render, which turns
    // that measurement into a render loop the moment the tooltip opens.
    const tip = React.useMemo(() => (
        <span>
            <strong style={{ color, display: 'block', marginBottom: 2 }}>{label}</strong>
            {detail}
            {onClick && (
                <span style={{ display: 'block', marginTop: 4, opacity: 0.7 }}>
                    Click to open verification.
                </span>
            )}
        </span>
    ), [color, label, detail, onClick]);

    const { anchorProps, tooltip, describedBy } = useClTooltip(tip, { wide: true });
    const { ref, ...handlers } = anchorProps;

    const content = (
        <>
            <Icon size={size} style={{ color }} aria-hidden="true" />
            {showLabel && (
                <span style={{ color, fontSize: 12, fontWeight: 700, lineHeight: 1 }}>{label}</span>
            )}
        </>
    );

    // `aria-label` carries the level for screen readers even when the visual
    // label is off, so the badge is never colour-and-shape only.
    const common = {
        ref: ref as React.Ref<never>,
        'aria-describedby': describedBy,
        'aria-label': `Identity: ${label}`,
        className: `inline-flex items-center gap-1.5 ${className}`,
        ...handlers,
    };

    return onClick ? (
        <>
            <button
                type="button"
                {...common}
                onClick={onClick}
                // `min-width/height: 24` rather than `padding: 0`: the icon is
                // 16-20px, which leaves a hit target under the 24px minimum
                // (WCAG 2.5.8) sitting between the call and video buttons in the
                // chat header. An earlier `padding: 0` here also silently voided
                // whatever padding the caller passed via `className`.
                style={{
                    background: 'none', border: 0, cursor: 'pointer',
                    minWidth: 24, minHeight: 24, justifyContent: 'center',
                }}
            >
                {content}
            </button>
            {tooltip}
        </>
    ) : (
        <>
            <span {...common} role="img">{content}</span>
            {tooltip}
        </>
    );
};

export default TrustBadge;
