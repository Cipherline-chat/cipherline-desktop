import React from 'react';
import '../../../styles/moment-school.css';

/**
 * "100 friends. That’s officially a school." — the friends count crossing 100.
 *
 * One fish per friend.
 * 0.0–0.5 s  notice: a soft ripple in the middle of the screen;
 * 0.5–2.9    the fish spiral in from every edge into three rings round the centre;
 * 2.4–3.2    "100" surfaces, then "friends. That’s officially a school.";
 * 3.2–6.8    read, while the school's slow circling eases to a stop (settled
 *            by 6.8); 7.8–8.5 the fish scatter outward and away.
 * Each fish's transform keeps the SAME function list in every keyframe
 * (rotate · translateX · rotate) so the path interpolates as a true spiral.
 * Deterministic: no Math.random.
 */
const COLORS = ['#25E0C8', '#3BEAD6', '#12B79F', '#FFC94D', '#5e8ee0'];
const FISH = Array.from({ length: 100 }, (_, i) => {
    const ring = i % 3;
    return {
        a: `${(i * 3.6 + ring * 1.2).toFixed(1)}deg`,
        r: `${190 + ring * 38}px`,
        c: COLORS[(i * 7) % COLORS.length],
        d: `${500 + ((i * 37) % 23) * 22}ms`,
        s: (0.8 + ((i * 13) % 5) * 0.1).toFixed(2),
    };
});

export const SchoolMoment: React.FC = () => (
    <div className="mo-school mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-school-spin">
                {FISH.map((f, i) => (
                    <span
                        key={i}
                        className="mo-fish"
                        style={{ ['--a' as string]: f.a, ['--r' as string]: f.r, ['--c' as string]: f.c, ['--s' as string]: f.s, ['--d' as string]: f.d }}
                    />
                ))}
            </div>
            <div className="mo-school-count mo-punch" data-read>100</div>
            <div className="mo-school-line mo-punch" data-read>friends. That’s officially a school.</div>
        </div>
    </div>
);

export default SchoolMoment;
