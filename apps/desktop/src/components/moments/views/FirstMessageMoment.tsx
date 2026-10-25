import React from 'react';
import '../../../styles/moment-first-message.css';

/**
 * "Your first message. Encrypted, like everything else." — the first message a
 * new account gets delivered.
 *
 * 0.0–0.5 s  notice: a soft ring at the bottom centre, where the composer is;
 * 0.5–2.6    the send plane lifts off from there and climbs in a long curve,
 *            dropping a trail of dots that fade out behind it;
 * 2.3–2.9    a padlock clicks shut on it (squash, a ring);
 * 2.6–3.1    "Encrypted, like everything else." under it; "Your first
 *            message." above;
 * 3.1–6.4    read, then the settled frame; 6.4–7.4 it fades.
 * Passive: nothing but the plane and its words, up in the middle of the screen.
 */
// Points along the plane's curve (vw / vh from the centre) where the trail drops a dot.
const TRAIL = [
    { x: -9.55, y: 27.9, t: 0.14 }, { x: -9.48, y: 19.9, t: 0.29 }, { x: -8.66, y: 12.0, t: 0.45 },
    { x: -6.95, y: 4.6, t: 0.62 }, { x: -4.2, y: -2.4, t: 0.8 }, { x: -1.4, y: -7.2, t: 0.94 },
];

export const FirstMessageMoment: React.FC = () => (
    <div className="mo-fm mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            {TRAIL.map((d, i) => (
                <span key={i} className="mo-fm-dot" style={{ left: `${d.x}vw`, top: `${d.y}vh`, animationDelay: `${(500 + 2100 * d.t).toFixed(0)}ms` }} />
            ))}
            <div className="mo-fm-plane">
                <div className="mo-fm-bank">
                    <svg viewBox="0 0 72 60" width="84" height="70">
                        <path d="M2 28 L70 2 L50 58 L36 38 Z" fill="#25E0C8" />
                        <path d="M2 28 L36 38 L70 2 Z" fill="#7EF0DF" />
                        <path d="M36 38 L50 58 L44 34 Z" fill="#12A593" />
                    </svg>
                    <div className="mo-fm-lock">
                        <span className="mo-fm-click" />
                        <svg viewBox="0 0 34 40" width="34" height="40">
                            <path d="M9 18 V12 a8 8 0 0 1 16 0 V18" stroke="#F4F7FF" strokeWidth="4.5" fill="none" strokeLinecap="round" />
                            <rect x="3" y="17" width="28" height="21" rx="6" fill="#FFC94D" />
                            <circle cx="17" cy="26.5" r="3.2" fill="#6B4A2E" />
                            <rect x="15.6" y="27" width="2.8" height="6" rx="1.4" fill="#6B4A2E" />
                        </svg>
                    </div>
                </div>
            </div>
            <div className="mo-fm-cap">Your first message.</div>
            <div className="mo-pill mo-fm-pill" data-read>Encrypted, like everything else.</div>
        </div>
    </div>
);

export default FirstMessageMoment;
