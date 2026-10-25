import React from 'react';
import '../../../styles/moment-wish.css';

/**
 * "11:11. Make a wish." — joining a voice channel at 11:11.
 *
 * 0.0–0.5 s  notice: a star twinkles on at the upper left;
 * 0.5–2.5    it streaks across the upper screen, its tail stretching behind
 *            it, scattering glints that twinkle out slowly;
 * 2.1–2.6    "11:11 — make a wish." in a pill under its path;
 * 2.6–6.1    read, then the settled frame; 6.1–6.7 it fades.
 * Passive: the call you just joined is never covered or blocked.
 */
const GLINTS = [
    { x: '-28vw', y: '-30vh', d: '.85s' }, { x: '-14vw', y: '-26vh', d: '1.15s' },
    { x: '0vw', y: '-22vh', d: '1.45s' }, { x: '14vw', y: '-18vh', d: '1.75s' }, { x: '28vw', y: '-14vh', d: '2.05s' },
];

export const WishMoment: React.FC = () => (
    <div className="mo-wish mo-view" aria-hidden="true">
        <div className="mo-anchor">
            {GLINTS.map((g, i) => (
                <span key={i} className="mo-wish-glint" style={{ left: g.x, top: g.y, animationDelay: g.d }} />
            ))}
            <div className="mo-wish-star">
                <span className="mo-wish-tail" />
                <svg className="mo-wish-head" viewBox="0 0 40 40" width="68" height="68">
                    <path d="M20 0 L24 16 L40 20 L24 24 L20 40 L16 24 L0 20 L16 16 Z" fill="#FFF6D6" />
                    <circle cx="20" cy="20" r="6" fill="#FFC94D" />
                </svg>
            </div>
            <div className="mo-pill mo-wish-pill" data-read><b>11:11</b> — make a wish.</div>
        </div>
    </div>
);

export default WishMoment;
