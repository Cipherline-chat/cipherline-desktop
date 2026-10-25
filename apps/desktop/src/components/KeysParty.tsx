import React, { useEffect } from 'react';
import { Keys } from './mascot/Keys';
import '../styles/egg-party.css';

/**
 * Keys party — the Konami payoff. Keys, in a party hat, swims the width of the
 * window waving, trailing bubbles, while confetti falls. Wordless on purpose
 * (doctrine rule 2: a joke that needs a conjured banner isn't ready) and
 * aria-hidden: it carries no information, so a screen reader loses nothing.
 *
 * Deterministic field (no Math.random: same reasoning as seasonal.ts), 6 s,
 * then `onDone`. Under reduced motion (rule 9) nothing travels or falls: a
 * still Keys in his hat sits in the corner for a moment instead — the same
 * hello, without the motion.
 */
export const PARTY_MS = 6200;
export const PARTY_STILL_MS = 3000;

const COLORS = ['#25E0C8', '#5e8ee0', '#FFC94D', '#4ADE80', '#FF8FB1', '#FF6B5E'];
const PIECES = Array.from({ length: 28 }, (_, i) => ({
    left: `${3 + ((i * 37) % 94)}%`,
    size: 5 + (i % 4) * 2,
    color: COLORS[i % COLORS.length],
    dur: `${2.4 + (i % 5) * 0.35}s`,
    delay: `${0.3 + (i % 9) * 0.28}s`,
    spin: `${(i % 2 ? 1 : -1) * (320 + (i * 53) % 400)}deg`,
}));
const BUBBLES = Array.from({ length: 12 }, (_, i) => ({
    left: `${6 + ((i * 29) % 88)}%`,
    size: 8 + (i % 4) * 5,
    dur: `${3.2 + (i % 4) * 0.5}s`,
    delay: `${(i % 6) * 0.55}s`,
    drift: `${(i % 2 ? 1 : -1) * (14 + (i * 7) % 30)}px`,
}));

export const KeysParty: React.FC<{ reduced: boolean; onDone: () => void }> = ({ reduced, onDone }) => {
    useEffect(() => {
        const t = window.setTimeout(onDone, reduced ? PARTY_STILL_MS : PARTY_MS);
        return () => window.clearTimeout(t);
    }, [reduced, onDone]);

    if (reduced) {
        return (
            <div className="egg-party egg-party--still" aria-hidden="true" data-testid="keys-party">
                <div className="egg-party-still">
                    <Keys size={84} costume="party" interactive={false} waveOnMount={false} idleSway={false} />
                </div>
            </div>
        );
    }
    return (
        <div className="egg-party" aria-hidden="true" data-testid="keys-party">
            {BUBBLES.map((b, i) => (
                <span
                    key={`b${i}`}
                    className="egg-party-bubble"
                    style={{ left: b.left, width: b.size, height: b.size, ['--dur' as string]: b.dur, ['--delay' as string]: b.delay, ['--drift' as string]: b.drift }}
                />
            ))}
            {PIECES.map((p, i) => (
                <span
                    key={`p${i}`}
                    className="egg-party-piece"
                    style={{ left: p.left, width: p.size, height: p.size, background: p.color, ['--dur' as string]: p.dur, ['--delay' as string]: p.delay, ['--spin' as string]: p.spin }}
                />
            ))}
            <div className="egg-party-swimmer">
                <div className="egg-party-bob">
                    <Keys size={120} costume="party" interactive={false} waveOnMount={false} wave />
                </div>
            </div>
        </div>
    );
};

export default KeysParty;
