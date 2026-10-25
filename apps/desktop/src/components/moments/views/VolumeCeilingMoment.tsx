import React, { useEffect } from 'react';
import { getHasActiveCall } from '../../../utils/activeCallRegistry';
import '../../../styles/moment-volume-ceiling.css';

/**
 * "200% is the ceiling." — pushing a volume slider past its max, three times.
 *
 * 0.0–0.5 s  notice: the top of Keys' head peeks up from the bottom edge;
 * 0.5–0.95   he pops up the rest of the way, his two front tentacles
 *            clamped over the sides of his head, eyes squeezed shut;
 * 0.8–3.0    sound-wave arcs pulse at him from both sides; he trembles;
 * 1.0        the whole window gives one small shake (skipped during a call —
 *            nothing jiggles a call or a screen share);
 * 1.3–1.8    "200% is the ceiling."; 1.8–5.3 read, then the settled frame
 *            (ears still clamped); 5.3–5.9 he ducks back down.
 */
export const VolumeCeilingMoment: React.FC = () => {
    useEffect(() => {
        if (getHasActiveCall()) return;
        const a = document.documentElement.animate?.([
            { transform: 'none' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' },
            { transform: 'translateX(-3px)' }, { transform: 'translateX(2px)' }, { transform: 'none' },
        ], { duration: 420, delay: 1000, easing: 'ease-out' });
        return () => a?.cancel();
    }, []);
    return (
        <div className="mo-vc mo-view" aria-hidden="true">
            <div className="mo-anchor">
                {[0, 1, 2].map(i => (
                    <React.Fragment key={i}>
                        <span className={`mo-vc-wave mo-vc-wave-l mo-vc-w${i}`}>
                            <svg viewBox="0 0 30 80" width="30" height="80"><path d="M24 4 Q4 40 24 76" stroke="#FFC94D" strokeWidth="5" fill="none" strokeLinecap="round" /></svg>
                        </span>
                        <span className={`mo-vc-wave mo-vc-wave-r mo-vc-w${i}`}>
                            <svg viewBox="0 0 30 80" width="30" height="80"><path d="M6 4 Q26 40 6 76" stroke="#FFC94D" strokeWidth="5" fill="none" strokeLinecap="round" /></svg>
                        </span>
                    </React.Fragment>
                ))}
                <div className="mo-vc-keys">
                    <div className="mo-vc-tremble">
                        <svg viewBox="0 0 110 92" width="150" height="125" style={{ overflow: 'visible' }}>
                            <g stroke="#25E0C8" strokeWidth="13" strokeLinecap="round" fill="none">
                                <path d="M46 54 L46 74" /><path d="M64 54 L64 74" />
                                {/* the outer two, bent up and clamped over his "ears" */}
                                <path d="M30 54 Q10 50 14 30 Q16 20 24 22" />
                                <path d="M80 54 Q100 50 96 30 Q94 20 86 22" />
                            </g>
                            <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8" />
                            <g stroke="#0B0F1E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" fill="none">
                                <path d="M37 33 L45 37 L37 41" /><path d="M73 33 L65 37 L73 41" />
                                <path d="M48 46 Q55 42 62 46" />
                            </g>
                        </svg>
                    </div>
                </div>
                <div className="mo-pill mo-vc-pill" data-read><b>200%</b> is the ceiling.</div>
            </div>
        </div>
    );
};

export default VolumeCeilingMoment;
