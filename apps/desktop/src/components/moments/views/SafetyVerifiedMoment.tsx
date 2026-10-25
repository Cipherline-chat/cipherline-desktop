import React from 'react';
import '../../../styles/moment-safety-verified.css';

/**
 * "Verified. Only you and {name} hold the keys." — the first time you verify
 * anyone's safety number (utils/firstVerification.ts). A ceremony, not an egg:
 * see CEREMONIES in utils/moments.ts. About 4 s, because the person just did
 * this on purpose and is watching for the result.
 *
 * 0.0–0.3 s  notice: the backdrop dims; the two people appear as orbs, one at
 *            each side (a plain silhouette for you, the other person's initial);
 * 0.3–0.9    two safety-number blocks (generic digit pills, never real digits)
 *            slide in from either edge and meet in the middle;
 * 0.9–1.05   they lock: a small squeeze, a bright seam where they meet;
 * 0.95–1.3   a link grows between the orbs and a lock forms on it; the shackle
 *            clicks shut at 1.2;
 * 1.25–2.4   a soft bioluminescent pulse sweeps outward from the lock, twice;
 * 1.25–1.5   the line rises in: "Verified. Only you and {name} hold the keys.";
 * 1.5–3.2    read; 3.2–3.6 the settled frame; 3.6–4.0 it fades.
 *
 * Transform + opacity only (styles/moment-safety-verified.css). Decorative and
 * aria-hidden: the host announces the line.
 */
export interface CeremonyViewProps {
    /** "Verified." */
    headline: string;
    /** "Only you and {name} hold the keys." (the name already filled in) */
    line: string;
    /** The other person's display name, for the initial on their orb. */
    peer: string | null;
}

/** First visible letter of a name, upper-cased; null when there is nothing to show (the orb draws a silhouette). */
function orbInitial(peer: string | null | undefined): string | null {
    const first = [...(peer ?? '').trim()][0];
    return first && /[\p{L}\p{N}]/u.test(first) ? first.toUpperCase() : null;
}

// Three rows of four digit pills; the widths vary so a block reads as "a number", not a barcode.
const ROWS = [[26, 22, 28, 20], [22, 28, 18, 26], [28, 20, 26, 22]];

const Block: React.FC<{ side: 'l' | 'r' }> = ({ side }) => (
    <svg className={`mo-sv-blk mo-sv-blk-${side}`} viewBox="0 0 180 92" width="180" height="92">
        <rect x="0.75" y="0.75" width="178.5" height="90.5" rx="14" className="mo-sv-card" />
        {ROWS.map((row, r) => {
            let x = 16;
            return row.map((w, c) => {
                const el = <rect key={`${r}-${c}`} x={x} y={16 + r * 23} width={w} height={11} rx={5.5} className="mo-sv-pill" />;
                x += w + 10;
                return el;
            });
        })}
    </svg>
);

const Orb: React.FC<{ side: 'l' | 'r'; initial: string | null }> = ({ side, initial }) => (
    <div className={`mo-sv-orb mo-sv-orb-${side}`}>
        {initial ? (
            <span className="mo-sv-initial">{initial}</span>
        ) : (
            <svg viewBox="0 0 72 72" width="72" height="72">
                <circle cx="36" cy="28" r="12" className="mo-sv-person" />
                <path d="M12 62 Q36 34 60 62 Q48 70 36 70 Q24 70 12 62 Z" className="mo-sv-person" />
            </svg>
        )}
    </div>
);

export const SafetyVerifiedMoment: React.FC<CeremonyViewProps> = ({ headline, line, peer }) => (
    <div className="mo-sv mo-view" aria-hidden="true">
        <div className="mo-dim" />
        <div className="mo-anchor">
            <span className="mo-sv-pulse mo-sv-pulse-1" />
            <span className="mo-sv-pulse mo-sv-pulse-2" />
            <span className="mo-sv-link" />
            <Orb side="l" initial={null} />
            <Orb side="r" initial={orbInitial(peer)} />
            <div className="mo-sv-lock">
                <svg viewBox="0 0 64 64" width="64" height="64">
                    <circle cx="32" cy="32" r="30" className="mo-sv-lock-disc" />
                    <path className="mo-sv-shackle" d="M23 29 V23 a9 9 0 0 1 18 0 V29" fill="none" strokeWidth="4" strokeLinecap="round" />
                    <rect x="20" y="28" width="24" height="18" rx="5" className="mo-sv-lock-body" />
                    <circle cx="32" cy="37" r="2.6" className="mo-sv-keyhole" />
                </svg>
            </div>
            <div className="mo-sv-blocks">
                <div className="mo-sv-slide mo-sv-slide-l"><div className="mo-sv-snap mo-sv-snap-l"><Block side="l" /></div></div>
                <div className="mo-sv-slide mo-sv-slide-r"><div className="mo-sv-snap mo-sv-snap-r"><Block side="r" /></div></div>
                <span className="mo-sv-seam" />
            </div>
            <div className="mo-sv-text mo-punch" data-read><b>{headline}</b> {line}</div>
        </div>
    </div>
);

export default SafetyVerifiedMoment;
