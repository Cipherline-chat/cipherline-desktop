/**
 * The visual pieces of the composer touches (docs/personality.md →
 * "Composer touches (2026-10-20)"). All decorative: aria-hidden where the
 * meaning is carried elsewhere, pointer-events none, transform/opacity only.
 * Logic lives in utils/composerFun.ts; ChatPane does the wiring.
 */
import React from 'react';
import '../../styles/composer-fun.css';
import { Keys } from '../mascot/Keys';
import type { SpamStage } from '../../utils/composerFun';

/** Debris for the impact: fixed, so every landing looks the same and the
 *  render is deterministic. x = start along the row's bottom edge. */
const BITS: ReadonlyArray<{ x: number; dx: number; dy: number; s: number }> = [
    { x: 6,   dx: -46, dy: -14, s: 7 },
    { x: 28,  dx: -30, dy: -24, s: 5 },
    { x: 60,  dx: -12, dy: -10, s: 4 },
    { x: 150, dx: 16,  dy: -12, s: 4 },
    { x: 186, dx: 34,  dy: -24, s: 6 },
    { x: 214, dx: 54,  dy: -12, s: 5 },
];

/** Shockwave ring(s) + debris, mounted inside the landing row while it enters. */
export const ImpactFx: React.FC = () => (
    <span className="cl-impact-fx" aria-hidden="true" data-impact-fx="">
        <span className="cl-impact-ring" />
        <span className="cl-impact-ring is-late" />
        {BITS.map((b, i) => (
            <span
                key={i}
                className="cl-impact-bit"
                style={{ '--x': `${b.x}px`, '--dx': `${b.dx}px`, '--dy': `${b.dy}px`, '--s': `${b.s}px` } as React.CSSProperties}
            />
        ))}
    </span>
);

/** A small empty envelope (flap open, nothing inside). */
const EmptyEnvelope: React.FC = () => (
    <svg className="cmp-envelope" width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">
        <path d="M2 6.5 L11 1.5 L20 6.5" fill="none" stroke="var(--cl-glow)" strokeWidth="1.6" strokeLinejoin="round" />
        <rect x="2" y="6.5" width="18" height="10" rx="2" fill="var(--cl-deep)" stroke="var(--cl-glow)" strokeWidth="1.6" />
        <path d="M2.8 7.4 L11 12.6 L19.2 7.4" fill="none" stroke="var(--cl-glow)" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
);

/**
 * The reaction over the disabled send button. `line` is the copy for this
 * stage; it is ALSO announced (once) through the live region so a screen
 * reader user who activates the button gets the same answer.
 */
export const SendSpamReaction: React.FC<{ stage: SpamStage; line: string }> = ({ stage, line }) => (
    <>
        {stage === 'keys' ? (
            <span className="cmp-spam-keys" aria-hidden="true" data-spam-stage="keys">
                <Keys size={44} interactive={false} waveOnMount={false} idleSway={false} ariaLabel="" />
                <EmptyEnvelope />
                <span className="cmp-spam-bubble">{line}</span>
            </span>
        ) : (
            <span className="cmp-spam-bubble" aria-hidden="true" data-spam-stage={stage}>{line}</span>
        )}
        <span className="sr-only" role="status">{line}</span>
    </>
);

/** Two amber rings off the send button (a send in the :00 minute). */
export const SendChime: React.FC = () => (
    <span className="cmp-chime" aria-hidden="true"><i /><i /></span>
);

/** One band of light across the composer (first send of the day). */
export const ComposerRipple: React.FC = () => <span className="cmp-ripple" aria-hidden="true" />;
