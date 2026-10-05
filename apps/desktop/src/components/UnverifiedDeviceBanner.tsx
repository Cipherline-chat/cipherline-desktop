/**
 * Compact "unverified device" banner for the top of a DM conversation.
 *
 * Replaces the old always-expanded warning block, which put the full "what
 * this means / what you should do" text directly in the banner body — a
 * paragraph of amber/red prose sitting permanently between the header and
 * the message feed, unreadable without either reading it in full or
 * ignoring it outright. The explanation now lives in a `cl/useClTooltip`
 * hover/focus tooltip (the same portaled-to-`<body>`, viewport-aware
 * primitive `TrustBadge` already uses for the same trust vocabulary), and
 * the banner itself shrinks to a small pill: an icon, a short label, and —
 * since the pill is a button — a click straight into the verify flow. This
 * is meant to be the kind of thing you notice in your peripheral vision
 * without having to dismiss it to read your messages.
 *
 * `useClTooltip` is keyboard-reachable by construction (it opens on
 * `:focus-visible`, not just hover, and the tooltip content is wired via
 * `aria-describedby`) — see that file for why a hand-rolled tooltip here
 * would have had to reinvent that.
 *
 * ── Why this isn't just a `<TrustBadge trust={...}>` ────────────────────────
 * `TrustBadge` is the general contact-trust badge and deliberately paints
 * every warnable verdict the SAME red (`compromised`) — it has no
 * `key_changed`-only context to soften, by design (see its docstring). This
 * banner is verdict-specific and keeps the severity split the removed
 * banner had: `key_changed` alone (a device you've seen before now presents
 * a different key — "they probably reinstalled or added a device") gets the
 * milder amber; `unrecognized_verified` and `unattributed` — the two shapes
 * an actual sender-identity forgery takes, per `senderTrust.ts` — get red
 * AND the extra sentence explaining that call/channel key material from
 * this device is being refused. Collapsing that distinction here would have
 * been a real behaviour change disguised as a resize.
 */
import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useClTooltip } from './cl/useClTooltip';
import { trustLabel } from '../utils/contactTrust';
import { verdictMessage, type SenderVerdict } from '../utils/senderTrust';

interface Props {
    verdict: SenderVerdict;
    /** Contact name, woven into the tooltip explanation so it reads as a sentence. */
    displayName: string;
    onVerify: () => void;
    className?: string;
}

/**
 * `unrecognized_verified` and `unattributed` are the two verdicts that are
 * shapes of a sender-identity forgery, not "they probably reinstalled" — see
 * `senderTrust.ts`'s `actionFor`. Key material (call/channel keys) from the
 * device is refused for these until the user verifies it; `key_changed`
 * alone gets the milder amber treatment and no "refused" sentence.
 */
const SEVERE: ReadonlySet<SenderVerdict> = new Set(['unrecognized_verified', 'unattributed']);

export const UnverifiedDeviceBanner: React.FC<Props> = ({ verdict, displayName, onVerify, className = '' }) => {
    const severe = SEVERE.has(verdict);
    // Reuse contactTrust's per-verdict short copy rather than inventing a
    // second wording for the same three states — the badge in the header
    // and this banner should never disagree about what to call a verdict.
    const label = trustLabel({ level: 'compromised', verdict, verifiedCount: 0, deviceCount: 0 });

    // Memoized because `useClTooltip` re-measures whenever `text` changes
    // identity — an inline JSX node is a new object every render, which
    // turns that measurement into a render loop the moment the tooltip
    // opens (same reasoning as TrustBadge's `tip`).
    const detail = React.useMemo(() => (
        <span>
            {verdictMessage(verdict, displayName)}
            {severe && (
                <>
                    {' '}
                    <strong>Encrypted calling and channel keys from this device are being refused until you verify it.</strong>
                </>
            )}
            <span style={{ display: 'block', marginTop: 4, opacity: 0.7 }}>Click to open verification.</span>
        </span>
    ), [verdict, displayName, severe]);

    const { anchorProps, tooltip, describedBy } = useClTooltip(detail, { wide: true });
    const { ref, ...handlers } = anchorProps;

    return (
        <div className={`mx-4 mt-3 mb-1 ${className}`}>
            <button
                type="button"
                ref={ref as React.Ref<HTMLButtonElement>}
                aria-describedby={describedBy}
                aria-label={`${label} — click to verify ${displayName}'s device.`}
                onClick={onVerify}
                {...handlers}
                className={`inline-flex items-center gap-1.5 rounded-full border cursor-pointer bg-transparent ${severe ? 'border-cl-flash/50 bg-cl-flash/10 text-cl-flash' : 'border-cl-glow/40 bg-cl-glow/10 text-cl-glow'}`}
                style={{ padding: '4px 10px 4px 8px', minHeight: 24 }}
            >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="text-[11px] font-bold leading-none">{label}</span>
            </button>
            {tooltip}
        </div>
    );
};

export default UnverifiedDeviceBanner;
