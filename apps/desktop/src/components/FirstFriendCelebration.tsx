import React, { useEffect, useState } from 'react';
import { Keys } from './mascot/Keys';
import { EggScrim } from './EggScrim';
import { useEggSkip } from '../hooks/useEggSkip';
import '../styles/first-friend.css';

/**
 * First friend, ever (Dashboard owns the trigger, the once-per-account flag,
 * the egg find and the celebration sound; this is only what you see).
 *
 * Every other celebration in this app fires on a billing or security-setup
 * event. This one marks a human moment, so it is a proper one (owner,
 * 2026-11-12: the old 22 wordless squares falling for 2.6 s were easy to miss):
 * the app dims (the shared egg scrim), a ring pulses out of the middle, a
 * burst of bioluminescent plankton and bubbles flies out of it and slowly
 * sinks, Keys pops up and waves, and one short line says what happened.
 * Like the full-screen moments it carries its own words (the moments'
 * exception to doctrine rule 2, approved by the owner for this one too).
 *
 *   0.0–0.3 s  the scrim dims the app; a ring pulses out from the centre;
 *   0.15–1.1   the burst flies out; Keys pops up (and waves from 0.35);
 *   0.45–1.05  "You made a friend." then the line rise in;
 *   1.1–3.2    the plankton sinks and fades; the words stay put;
 *   3.2–3.8    everything fades with the scrim; then gone.
 *
 * Passive: never takes focus, clicks go through to the app, and a click or
 * Escape ends it early. Transform + opacity only; deterministic field (no
 * Math.random). Never mounted under reduced motion (Dashboard skips the
 * visual and keeps the sound).
 */
export const FIRST_FRIEND_MS = 3800;
const EXIT_AT_MS = 3200;
const EXIT_MS = FIRST_FRIEND_MS - EXIT_AT_MS;
/** Keys' wave is a rising edge on his `wave` prop, after he has popped up. */
const WAVE_AT_MS = 350;

export const FIRST_FRIEND_HEADLINE = 'You made a friend.';
export const FIRST_FRIEND_LINE = 'Say hi. Only they can read it.';

/** The ocean half of the brand: Lume, its highlights, deep-water blue, a little warm glow. Never a rainbow. */
const PALETTE = ['#25E0C8', '#3BEAD6', '#A8FFF1', '#5E8EE0', '#25E0C8', '#8FB8FF', '#3BEAD6', '#FFC94D'];
type Shape = 'dot' | 'ring' | 'chip';
const SHAPES: Shape[] = ['dot', 'ring', 'dot', 'chip', 'dot', 'ring'];
const BURST_COUNT = 48;
export const BURST = Array.from({ length: BURST_COUNT }, (_, i) => {
    // Evenly round the circle, nudged so no two neighbours line up; two rings of distance.
    const angle = (i / BURST_COUNT) * Math.PI * 2 + ((i * 37) % 11) / 30;
    const dist = (i % 2 ? 170 : 250) + ((i * 53) % 90);
    const shape = SHAPES[i % SHAPES.length];
    return {
        shape,
        dx: Math.round(Math.cos(angle) * dist * 1.35),
        dy: Math.round(Math.sin(angle) * dist * 0.95) - 20,
        size: shape === 'ring' ? 10 + (i % 3) * 4 : shape === 'chip' ? 7 + (i % 2) * 2 : 4 + (i % 4) * 2,
        color: PALETTE[i % PALETTE.length],
        delay: 150 + (i % 6) * 22,
        dur: 2500 + ((i * 71) % 600),
        sink: 50 + ((i * 29) % 70),
        rot: (i % 2 ? 1 : -1) * (120 + ((i * 47) % 240)),
    };
});
/** A few slow bubbles rising from the bottom edge, so the whole screen takes part, not just the middle. */
const BUBBLES = Array.from({ length: 12 }, (_, i) => ({
    left: `${5 + ((i * 41) % 90)}%`,
    size: 8 + (i % 4) * 4,
    delay: 100 + (i % 6) * 180,
    dur: 2600 + (i % 4) * 300,
    drift: (i % 2 ? 1 : -1) * (10 + ((i * 7) % 24)),
}));

const px = (n: number) => `${n}px`;
const ms = (n: number) => `${n}ms`;

export const FirstFriendCelebration: React.FC<{ onDone: () => void }> = ({ onDone }) => {
    const [wave, setWave] = useState(false);
    useEffect(() => {
        const w = window.setTimeout(() => setWave(true), WAVE_AT_MS);
        const t = window.setTimeout(onDone, FIRST_FRIEND_MS);
        return () => { window.clearTimeout(w); window.clearTimeout(t); };
    }, [onDone]);
    useEggSkip(onDone);

    return (
        <div className="ff-root" aria-hidden="true" data-testid="first-friend">
            <EggScrim inMs={300} outAtMs={EXIT_AT_MS} outMs={EXIT_MS} />
            <div className="ff-scene" style={{ ['--ff-exit-at' as string]: ms(EXIT_AT_MS), ['--ff-exit' as string]: ms(EXIT_MS) }}>
                {BUBBLES.map((b, i) => (
                    <span
                        key={`b${i}`}
                        className="ff-bubble"
                        style={{ left: b.left, width: b.size, height: b.size, ['--d' as string]: ms(b.delay), ['--t' as string]: ms(b.dur), ['--drift' as string]: px(b.drift) }}
                    />
                ))}
                <div className="ff-anchor">
                    <span className="ff-glow" />
                    <span className="ff-ring" />
                    <span className="ff-ring ff-ring-2" />
                    {BURST.map((p, i) => (
                        <span
                            key={i}
                            className={`ff-p ff-p--${p.shape}`}
                            style={{
                                color: p.color,
                                ['--s' as string]: px(p.size),
                                ['--dx' as string]: px(p.dx),
                                ['--dy' as string]: px(p.dy),
                                ['--sink' as string]: px(p.sink),
                                ['--rot' as string]: `${p.rot}deg`,
                                ['--d' as string]: ms(p.delay),
                                ['--t' as string]: ms(p.dur),
                            }}
                        />
                    ))}
                    <div className="ff-keys">
                        <div className="ff-keys-pop">
                            <Keys size={128} face="happy" interactive={false} waveOnMount={false} idleSway={false} wave={wave} />
                        </div>
                    </div>
                    <div className="ff-text">
                        <div className="ff-headline" data-read>{FIRST_FRIEND_HEADLINE}</div>
                        <div className="ff-line" data-read>{FIRST_FRIEND_LINE}</div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FirstFriendCelebration;
