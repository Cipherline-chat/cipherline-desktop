import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-coffee.css';

/**
 * "Twelve hours straight. Coffee’s on Keys." — the app open for 12 hours.
 *
 * 0.0–0.5 s  notice: a soft ripple at the right, where he comes in;
 * 0.5–1.9    Keys swims in from the right, balancing a steaming mug;
 * 1.8–6.3    he holds it out to you, bobbing, steam curling up (settles by 6.3);
 *            2.2–2.7 "Twelve hours straight. Coffee’s on Keys.";
 * 7.3–8.0    he swims off.
 * Passive and ambient: it waits until you're not typing or in a call.
 */
export const CoffeeMoment: React.FC = () => (
    <div className="mo-coffee mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-coffee-swim">
                <div className="mo-coffee-bob">
                    <Keys size={150} interactive={false} waveOnMount={false} face="happy" />
                    <div className="mo-coffee-mug">
                        {[0, 1, 2].map(i => (
                            <span key={i} className={`mo-coffee-steam mo-coffee-steam-${i}`}>
                                <svg viewBox="0 0 16 40" width="16" height="40"><path d="M8 38 Q0 28 8 20 Q16 12 8 2" stroke="rgba(244,247,255,.7)" strokeWidth="3" fill="none" strokeLinecap="round" /></svg>
                            </span>
                        ))}
                        <svg viewBox="0 0 64 56" width="80" height="70">
                            <path d="M46 16 Q62 16 60 30 Q58 42 44 40" stroke="#F4F7FF" strokeWidth="6" fill="none" />
                            <path d="M4 8 L48 8 L44 50 Q43 54 38 54 L14 54 Q9 54 8 50 Z" fill="#F4F7FF" />
                            <path d="M8 14 L44 14" stroke="#6B4A2E" strokeWidth="5" />
                            <path d="M17 30 Q26 22 35 30 Q26 42 17 30" fill="#25E0C8" />
                        </svg>
                    </div>
                </div>
            </div>
            <div className="mo-pill mo-coffee-pill" data-read>Twelve hours straight. <b>Coffee’s on Keys.</b></div>
        </div>
    </div>
);

export default CoffeeMoment;
