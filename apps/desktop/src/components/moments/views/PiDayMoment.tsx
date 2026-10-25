import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-pi-day.css';

/**
 * "Happy Pi Day. Keys brought pie." — March 14th, around 1:59 p.m.
 *
 * 0.0–0.5 s  notice: a soft ring at the right, where the pie rolls in from;
 * 0.5–1.9    a pie rolls in from the right, a full turn and a half, and stops
 *            (it is round; this is its one job);
 * 1.4–2.0    Keys pops up beside it, waving;
 * 1.8–2.4    the digits of pi appear in a ring around it and turn slowly into
 *            place (3.1415926535…);
 * 2.3–3.0    a slice slides out; steam curls up;
 * 2.6–3.3    "Happy Pi Day. Keys brought pie." under it; "3/14, 1:59." above;
 * 3.3–6.4    read, then the settled frame; 6.4–7.4 it fades.
 * Passive and ambient: it waits until you're not typing or in a call.
 */
const PI = '3.14159265358979323846264338327950288419';
const WEDGE_TOP = 'M65 65 L88.7 7.7 A62 62 0 1 0 122.3 41.3 Z';
const WEDGE = 'M65 65 L88.7 7.7 A62 62 0 0 1 122.3 41.3 Z';
const LATTICE = Array.from({ length: 14 }, (_, i) => i * 14 - 40);

const Lattice: React.FC<{ clip: string }> = ({ clip }) => (
    <g clipPath={`url(#${clip})`} stroke="#F6DDA6" strokeWidth="5" strokeLinecap="round">
        {LATTICE.map(o => <path key={`a${o}`} d={`M${o} -10 L${o + 150} 140`} />)}
        {LATTICE.map(o => <path key={`b${o}`} d={`M${o + 150} -10 L${o} 140`} />)}
    </g>
);

export const PiDayMoment: React.FC = () => (
    <div className="mo-pi mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-pi-cap">3/14, 1:59.</div>
            <div className="mo-pi-scene">
                <div className="mo-pi-keys">
                    <Keys size={104} interactive={false} waveOnMount={false} face="happy" wave />
                </div>
                <div className="mo-pi-ringwrap">
                    <div className="mo-pi-ring">
                        <svg viewBox="0 0 260 260" width="260" height="260">
                            <defs><path id="mo-pi-circle" d="M130 20 a110 110 0 1 1 -0.01 0" /></defs>
                            <text fill="#25E0C8" fontSize="17" fontFamily="'JetBrains Mono', ui-monospace, monospace" fontWeight="700" letterSpacing="1">
                                <textPath href="#mo-pi-circle" textLength="676" lengthAdjust="spacing">{PI}</textPath>
                            </text>
                        </svg>
                    </div>
                </div>
                <div className="mo-pi-roll">
                    <div className="mo-pi-pie">
                        <svg viewBox="0 0 130 130" width="130" height="130">
                            <defs>
                                <clipPath id="mo-pi-clip"><path d={WEDGE_TOP} /></clipPath>
                                <clipPath id="mo-pi-clip-slice"><path d={WEDGE} /></clipPath>
                            </defs>
                            <circle cx="65" cy="65" r="62" fill="#C2415A" />
                            <circle cx="65" cy="65" r="40" fill="#E0627C" opacity=".55" />
                            <path d={WEDGE_TOP} fill="#E3B26B" />
                            <Lattice clip="mo-pi-clip" />
                            <path d={WEDGE_TOP} fill="none" stroke="#C98B3F" strokeWidth="8" strokeDasharray="9 6" />
                        </svg>
                        <div className="mo-pi-slice">
                            <svg viewBox="0 0 130 130" width="130" height="130">
                                <path d={WEDGE} fill="#E3B26B" />
                                <Lattice clip="mo-pi-clip-slice" />
                                <path d={WEDGE} fill="none" stroke="#C98B3F" strokeWidth="8" strokeDasharray="9 6" />
                            </svg>
                        </div>
                    </div>
                </div>
                {[0, 1].map(i => (
                    <span key={i} className={`mo-pi-steam mo-pi-steam-${i}`}>
                        <svg viewBox="0 0 16 40" width="16" height="40"><path d="M8 38 Q0 28 8 20 Q16 12 8 2" stroke="rgba(244,247,255,.7)" strokeWidth="3" fill="none" strokeLinecap="round" /></svg>
                    </span>
                ))}
            </div>
            <div className="mo-pill mo-pi-pill" data-read>Happy Pi Day. Keys brought pie.</div>
        </div>
    </div>
);

export default PiDayMoment;
