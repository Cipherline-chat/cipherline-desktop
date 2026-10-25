import React from 'react';
import '../../../styles/moment-nye-call.css';

/**
 * "Midnight, mid-call. Happy New Year!" — midnight on New Year's Eve, while you
 * are in a call. Real fireworks (not the underwater ones) over the call stage.
 *
 * 0.0–0.5 s  notice: the first rocket climbs from the middle of the screen;
 * 0.5–3.0    six fireworks go up and burst, one after another, across the
 *            upper part of the screen; each is a ring of streaks plus a
 *            sprinkle of glitter that drifts down as it fades;
 * 1.4–2.4    the new year's number pops up in gold;
 * 2.4–3.5    "Midnight, mid-call. Happy New Year!";
 * 3.5–6.8    read, then the settled frame (the last sparks have faded by 5.0);
 * 7.8–8.5    it fades.
 * Passive and kind to a call: no backdrop, nothing below the middle of the
 * screen (the call controls), no full-screen flash, clicks go straight through.
 */
const RAYS = Array.from({ length: 16 }, (_, i) => `${i * (360 / 16)}deg`);
const GLITTER = Array.from({ length: 10 }, (_, i) => `${i * 36 + 18}deg`);

// Where each firework bursts (vw / vh from the centre), when, and its colour.
const BURSTS = [
    { x: -27, y: -26, d: 100, c: '#FFC94D' },
    { x: 25, y: -32, d: 650, c: '#FF8FB1' },
    { x: -4, y: -38, d: 1200, c: '#25E0C8' },
    { x: 32, y: -8, d: 1650, c: '#F4F7FF' },
    { x: -33, y: -6, d: 2050, c: '#5e8ee0' },
    { x: 17, y: -21, d: 2450, c: '#FFC94D' },
];

/** The year being rung in: after midnight it is this year; a hair early it is next year. */
function newYear(d: Date): number { return d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear(); }

export const NyeCallMoment: React.FC = () => (
    <div className="mo-nye mo-view" aria-hidden="true">
        <div className="mo-anchor">
            {BURSTS.map((b, i) => (
                <div key={i} className="mo-nye-fw" style={{ left: `${b.x}vw`, top: `${b.y}vh`, ['--c' as string]: b.c }}>
                    <span className="mo-nye-rocket" style={{ animationDelay: `${b.d}ms` }} />
                    <div className="mo-nye-fall" style={{ animationDelay: `${b.d + 800}ms` }}>
                        {RAYS.map((a, j) => <span key={j} className="mo-nye-ray" style={{ ['--a' as string]: a, animationDelay: `${b.d + 800}ms` }} />)}
                        {GLITTER.map((a, j) => <span key={j} className="mo-nye-glit" style={{ ['--a' as string]: a, animationDelay: `${b.d + 950}ms` }} />)}
                    </div>
                    <span className="mo-nye-flash" style={{ animationDelay: `${b.d + 800}ms` }} />
                </div>
            ))}
            <div className="mo-nye-year mo-punch">{newYear(new Date())}</div>
            <div className="mo-pill mo-nye-pill" data-read><b>Midnight, mid-call.</b> Happy New Year!</div>
        </div>
    </div>
);

export default NyeCallMoment;
