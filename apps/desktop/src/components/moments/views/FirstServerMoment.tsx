import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-first-server.css';

/**
 * "Your first server. Population: 1." — you create your first server.
 *
 * 0.0–0.5 s  notice: a soft ring in the middle, where the island will surface;
 * 0.5–1.4    a small island rises into place;
 * 1.2–1.9    Keys drops onto it and squashes on landing;
 * 1.9–2.8    he plants a flag: the pole grows, the cloth unfurls and waves;
 * 2.5–3.5    a little signpost gets its one tally mark; "Population: 1."
 *            under it; "Your first server." above;
 * 3.5–6.0    read, then the settled frame; 6.0–7.0 it fades.
 * Passive. (The new server is already open underneath.)
 */
export const FirstServerMoment: React.FC = () => (
    <div className="mo-fs mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-fs-cap">Your first server.</div>
            <div className="mo-fs-scene">
                <div className="mo-fs-island">
                    <svg viewBox="0 0 260 96" width="260" height="96">
                        <path d="M10 36 Q12 80 130 90 Q248 80 250 36 Q130 70 10 36 Z" fill="#7B5A3A" />
                        <ellipse cx="130" cy="36" rx="120" ry="26" fill="#F2D49B" />
                        <ellipse cx="130" cy="40" rx="104" ry="18" fill="#E7C58A" opacity=".55" />
                        <path d="M44 34 Q54 26 66 34 M170 40 Q184 32 198 40" stroke="#CFA865" strokeWidth="3" fill="none" strokeLinecap="round" />
                    </svg>
                </div>
                <div className="mo-fs-keys">
                    <div className="mo-fs-land">
                        <Keys size={92} interactive={false} waveOnMount={false} face="happy" />
                    </div>
                </div>
                <div className="mo-fs-flag">
                    <div className="mo-fs-pole" />
                    <div className="mo-fs-cloth-wrap">
                        <div className="mo-fs-cloth">
                            <svg viewBox="0 0 70 44" width="70" height="44">
                                <path d="M0 0 L70 0 L58 22 L70 44 L0 44 Z" fill="#25E0C8" />
                                <circle cx="22" cy="22" r="9" fill="#0B0F1E" />
                                <rect x="20" y="16" width="4" height="14" rx="2" fill="#25E0C8" />
                            </svg>
                        </div>
                    </div>
                </div>
                <div className="mo-fs-sign">
                    <svg viewBox="0 0 70 90" width="70" height="90">
                        <rect x="32" y="40" width="6" height="50" rx="3" fill="#6B4A2E" />
                        <rect x="2" y="2" width="66" height="44" rx="8" fill="#B8865A" />
                        <rect x="6" y="6" width="58" height="36" rx="5" fill="#E7C593" />
                    </svg>
                    <span className="mo-fs-tally" />
                </div>
            </div>
            <div className="mo-pill mo-fs-pill" data-read>Population: 1.</div>
        </div>
    </div>
);

export default FirstServerMoment;
