import React from 'react';
import '../../../styles/moment-new-year.css';

/**
 * "Happy New Year! Fireworks, but underwater." — first open on January 1st.
 *
 * 0.1–1.1 s  notice + launch: the first firework rises as a wobbling bubble
 *            from the sea floor;
 * 1.1–6.0    four of them, one after another, burst into rings of glowing
 *            plankton that drift and sink slowly (no gravity snap);
 * 1.6–3.0    "Happy New Year!", then "Fireworks, but underwater.";
 * 3.0–7.8    read, then the settled frame (the last plankton has faded by 6.0);
 * 7.8–8.5    it fades. Deterministic.
 */
const BURSTS = [
    { x: '-26vw', y: '-18vh', c: '#25E0C8', d: 100 },
    { x: '22vw', y: '-26vh', c: '#FFC94D', d: 850 },
    { x: '-6vw', y: '-34vh', c: '#FF8FB1', d: 1600 },
    { x: '30vw', y: '4vh', c: '#5e8ee0', d: 2300 },
];
const SPARKS = Array.from({ length: 14 }, (_, i) => `${i * (360 / 14)}deg`);

export const NewYearMoment: React.FC = () => (
    <div className="mo-ny mo-view" aria-hidden="true">
        <div className="mo-anchor">
            {BURSTS.map((b, i) => (
                <div key={i} className="mo-ny-burst" style={{ left: b.x, top: b.y, ['--c' as string]: b.c }}>
                    <span className="mo-ny-rocket" style={{ animationDelay: `${b.d}ms` }} />
                    {SPARKS.map((a, j) => (
                        <span key={j} className="mo-ny-spark" style={{ ['--a' as string]: a, animationDelay: `${b.d + 1000}ms` }} />
                    ))}
                    <span className="mo-ny-flash" style={{ animationDelay: `${b.d + 1000}ms` }} />
                </div>
            ))}
            <div className="mo-ny-title mo-punch" data-read>Happy New Year!</div>
            <div className="mo-ny-sub mo-punch" data-read>Fireworks, but underwater.</div>
        </div>
    </div>
);

export default NewYearMoment;
