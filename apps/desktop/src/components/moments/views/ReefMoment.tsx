import React from 'react';
import '../../../styles/moment-reef.css';

/**
 * "Ten servers. You’ve built a reef." — the server count crossing 10.
 *
 * One coral per server.
 * 0.0–0.5 s  notice: a few bubbles start rising from the bottom edge;
 * 0.5–2.8    ten corals grow up from the bottom one after another, in the
 *            brand colours; bubbles rise between them;
 * 2.4–3.1    "Ten servers." then "You’ve built a reef.";
 * 3.1–7.3    read, then the settled frame; 7.3–8.0 the reef sinks back down.
 * Deterministic shapes (three coral silhouettes, cycled).
 */
const SHAPES = [
    'M30 120 L30 70 Q30 50 16 40 L16 18 M30 70 Q30 52 44 44 L44 10 M16 40 L6 30 M44 44 L56 34',
    'M30 120 L30 30 M30 80 L12 60 L12 36 M30 64 L48 46 L48 22 M30 46 L40 30',
    'M30 120 Q28 90 20 76 Q10 60 14 40 M24 84 Q40 70 42 50 Q44 34 36 20 M42 56 Q54 48 52 34',
];
const COLORS = ['#25E0C8', '#FF6B5E', '#FFC94D', '#5e8ee0', '#FF8FB1'];
const CORALS = Array.from({ length: 10 }, (_, i) => ({
    x: `${-44 + i * 9.6}vw`,
    h: 0.75 + ((i * 7) % 5) * 0.12,
    d: `${500 + i * 170}ms`,
    shape: SHAPES[i % SHAPES.length],
    c: COLORS[i % COLORS.length],
}));
const BUBBLES = Array.from({ length: 14 }, (_, i) => ({ x: `${-42 + i * 6.3}vw`, d: `${(i * 263) % 3400}ms`, s: 8 + (i % 4) * 4 }));

export const ReefMoment: React.FC = () => (
    <div className="mo-reef mo-view" aria-hidden="true">
        <div className="mo-reef-floor">
            {CORALS.map((c, i) => (
                <span key={i} className="mo-coral" style={{ left: `calc(50% + ${c.x})`, animationDelay: c.d, ['--h' as string]: c.h }}>
                    <svg viewBox="0 0 60 120" width="78" height="156">
                        <path d={c.shape} stroke={c.c} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                    </svg>
                </span>
            ))}
            {BUBBLES.map((b, i) => (
                <span key={`b${i}`} className="mo-reef-bubble" style={{ left: `calc(50% + ${b.x})`, width: b.s, height: b.s, animationDelay: b.d }} />
            ))}
        </div>
        <div className="mo-anchor">
            <div className="mo-reef-count mo-punch" data-read>Ten servers.</div>
            <div className="mo-reef-line mo-punch" data-read>You’ve built a reef.</div>
        </div>
    </div>
);

export default ReefMoment;
