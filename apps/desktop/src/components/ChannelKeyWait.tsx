import React, { useEffect, useState } from 'react';
import { KEY_WAIT_COPY, type KeyWaitStage } from '../utils/channelKeyWait';
import type { KeyWaitPhase } from '../hooks/useChannelKeyWait';
import '../styles/key-wait.css';

/**
 * The whole-pane "waiting for this channel's keys" layer. ChatPane keeps its
 * header and composer; this covers only the feed. Lifecycle and stages:
 * hooks/useChannelKeyWait.ts; decision and signals: utils/channelKeyWait.ts;
 * motion rules: styles/key-wait.css.
 */



/** Deterministic ciphertext-looking lines (no Math.random: stable across
 *  renders and stills). */
const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789+/=';
function cipherLine(seed: number, len: number): string {
    let x = (seed * 2654435761) >>> 0;
    let out = '';
    for (let i = 0; i < len; i++) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        out += (i > 0 && i % 9 === 0) ? ' ' : GLYPHS[x % GLYPHS.length];
    }
    return out;
}

/** Ghost rows, bottom-up like a chat: [name width px, line widths %]. */
const GHOST_ROWS: Array<[number, number[]]> = [
    [72, [58]],
    [96, [74, 41]],
    [64, [36]],
    [88, [66]],
    [70, [49, 62]],
    [104, [30]],
    [80, [71]],
];

const LockMark: React.FC = () => (
    <div className="ckw-lock" aria-hidden="true">
        <div className="ckw-shackle">
            <svg viewBox="0 0 40 30" width="40" height="30">
                <path d="M9 30 V15 a11 11 0 0 1 22 0 V30" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
            </svg>
        </div>
        <div className="ckw-body">
            <svg viewBox="0 0 52 40" width="52" height="40">
                <rect x="1.5" y="1.5" width="49" height="37" rx="10" fill="var(--cl-deep, #131A30)" stroke="currentColor" strokeWidth="3" />
                <circle cx="26" cy="17" r="4.5" fill="currentColor" />
                <rect x="23.75" y="18" width="4.5" height="10" rx="2.25" fill="currentColor" />
            </svg>
        </div>
    </div>
);

export interface ChannelKeyWaitProps {
    phase: Exclude<KeyWaitPhase, 'hidden'>;
    stage: KeyWaitStage;
    reduced: boolean;
    /** Space the floating composer covers at the bottom of the feed. */
    bottomInset?: number;
}

export const ChannelKeyWait: React.FC<ChannelKeyWaitProps> = ({ phase, stage, reduced, bottomInset = 0 }) => {
    // Pause every loop while the window is hidden.
    const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    useEffect(() => {
        const on = () => setHidden(document.visibilityState === 'hidden');
        document.addEventListener('visibilitychange', on);
        return () => document.removeEventListener('visibilitychange', on);
    }, []);

    // Outgoing copy crossfades out over the incoming one (skipped under
    // reduced motion: the new text simply replaces the old).
    const [current, setCurrent] = useState(stage);
    const [prev, setPrev] = useState<{ stage: KeyWaitStage; n: number } | null>(null);
    if (stage !== current) {
        setCurrent(stage);
        setPrev(reduced ? null : { stage: current, n: (prev?.n ?? 0) + 1 });
    }
    useEffect(() => {
        if (!prev) return;
        const t = setTimeout(() => setPrev(p => (p && p.n === prev.n ? null : p)), 300);
        return () => clearTimeout(t);
    }, [prev]);

    const unlocked = stage === 'received' || stage === 'building' || (phase === 'exiting');
    const resolved = stage === 'building' || phase === 'exiting';
    const copy = KEY_WAIT_COPY[stage];
    const prevCopy = prev ? KEY_WAIT_COPY[prev.stage] : null;
    const sameTitle = prevCopy !== null && prevCopy.title === copy.title;

    return (
        <div
            className={[
                'ckw-root',
                phase === 'exiting' ? 'is-exiting' : '',
                unlocked ? 'is-unlocked' : '',
                resolved ? 'is-resolved' : '',
                stage === 'stalled' ? 'is-stalled' : '',
            ].filter(Boolean).join(' ')}
            data-stage={stage}
            data-reduced={reduced ? '' : undefined}
            data-paused={hidden ? '' : undefined}
            style={{ paddingBottom: bottomInset }}
        >
            <div className="ckw-center">
                <div className="ckw-emblem" aria-hidden="true">
                    <div className="ckw-halo" />
                    <div className="ckw-rings">
                        <span className="ckw-ring" />
                        <span className="ckw-ring ckw-ring-2" />
                    </div>
                    {unlocked && !reduced && <span className="ckw-bloom" />}
                    <LockMark />
                </div>
                <div className="ckw-copy" role="status" aria-live="polite" aria-atomic="true">
                    <div className="ckw-copy-stack">
                        {prevCopy && !reduced && (
                            <div className="ckw-copy-item ckw-copy-out" key={`out-${prev!.n}`} aria-hidden="true">
                                <p className={`ckw-title${sameTitle ? ' ckw-steady' : ''}`}>{prevCopy.title}</p>
                                <p className="ckw-detail">{prevCopy.detail}</p>
                            </div>
                        )}
                        <div className="ckw-copy-item ckw-copy-in" key={`in-${stage}`}>
                            <p className={`ckw-title${sameTitle ? ' ckw-steady' : ''}`}>{copy.title}</p>
                            <p className="ckw-detail">{copy.detail}</p>
                        </div>
                    </div>
                </div>
            </div>
            <div className="ckw-ghosts" aria-hidden="true">
                {GHOST_ROWS.map(([nameW, lines], i) => (
                    <div className="ckw-ghost" key={i} style={{ '--i': i } as React.CSSProperties}>
                        <div className="ckw-ghost-av" />
                        <div className="ckw-ghost-col">
                            <div className="ckw-ghost-name" style={{ width: nameW }} />
                            {lines.map((w, j) => (
                                <div className="ckw-ghost-line" key={j} style={{ width: `${w}%`, '--j': j } as React.CSSProperties}>
                                    <span className="ckw-ghost-glyphs"><span className="ckw-ghost-pulse">{cipherLine(i * 7 + j + 1, 96)}</span></span>
                                    <span className="ckw-ghost-bar" />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
