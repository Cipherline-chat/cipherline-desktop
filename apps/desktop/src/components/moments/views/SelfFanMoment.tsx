import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-self-fan.css';

/**
 * "Ten reactions. All yours." — reacting to your own messages, ten times.
 *
 * 0.0–0.5 s  notice: the first hearts float up from the bottom edge;
 * 0.5–1.3    Keys rises up from below;
 * 1.2–1.7    he swings up a big stadium pennant on a stick: "#1 FAN"
 *            (a pennant, not a foam hand: the old "#1" finger read as a
 *            different finger at this size — owner, 2026-10-20);
 * 1.7–4.7    he waves it side to side; hearts and stars float up around him
 *            like a one-fan stadium;
 * 2.0–2.5    "Your biggest fan. (It’s you.)";
 * 2.5–6.5    read, then the settled frame; 6.5–7.1 he sinks back down.
 */
const FLOATERS = Array.from({ length: 12 }, (_, i) => ({
    x: `${-260 + i * 47}px`,
    d: `${(i * 311) % 3600}ms`,
    k: i % 3,
}));

/** A felt sports pennant on a wooden stick. Drawn at 170×150. */
const Pennant: React.FC = () => (
    <svg viewBox="0 0 170 150" width="170" height="150">
        <rect x="8" y="10" width="7" height="138" rx="3.5" fill="#C9A06A" />
        <path d="M15 16 L166 52 L15 88 Z" fill="#FF6B5E" />
        <path d="M15 16 L33 20.3 L33 83.7 L15 88 Z" fill="#FFC94D" />
        <path d="M15 16 L166 52 L15 88" fill="none" stroke="#C94A3F" strokeWidth="2" strokeLinejoin="round" />
        <text x="84" y="59" textAnchor="middle" fontFamily="var(--cl-font-display, Fredoka)" fontWeight="700" fontSize="19" letterSpacing=".5" fill="#F4F7FF">#1 FAN</text>
        <circle cx="11.5" cy="9" r="7" fill="#FFC94D" />
    </svg>
);

export const SelfFanMoment: React.FC = () => (
    <div className="mo-fan mo-view" aria-hidden="true">
        <div className="mo-anchor">
            {FLOATERS.map((f, i) => (
                <span key={i} className={`mo-fan-float mo-fan-k${f.k}`} style={{ left: f.x, animationDelay: f.d }}>
                    {f.k === 0 ? (
                        <svg viewBox="0 0 24 22" width="28" height="26"><path d="M12 21 C2 13 0 8 3 4 C6 0 10 2 12 5 C14 2 18 0 21 4 C24 8 22 13 12 21 Z" fill="#FF6B5E" /></svg>
                    ) : f.k === 1 ? (
                        <svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 1 L15 9 L23 9 L17 14 L19 22 L12 17 L5 22 L7 14 L1 9 L9 9 Z" fill="#FFC94D" /></svg>
                    ) : (
                        <svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="10" fill="none" stroke="#25E0C8" strokeWidth="3" /></svg>
                    )}
                </span>
            ))}
            <div className="mo-fan-keys">
                <div className="mo-fan-pennant">
                    <div className="mo-fan-wave"><Pennant /></div>
                </div>
                <Keys size={140} interactive={false} waveOnMount={false} face="happy" />
            </div>
            <div className="mo-pill mo-fan-pill" data-read>Your biggest fan. <b>(It’s you.)</b></div>
        </div>
    </div>
);

export default SelfFanMoment;
