import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-first-call.css';

/**
 * "Your first call. You’re connected. Say something." — the first call that
 * connects on a new account. A tin-can telephone.
 *
 * 0.0–0.5 s  notice: a soft ring at the right, where the far can will be;
 * 0.5–1.2    the far can pops up; Keys is already there with his own;
 * 0.9–1.7    the string between them hangs slack;
 * 1.7–2.1    it pulls taut (the far can is tugged a little closer, the line
 *            trembles and settles);
 * 2.1–3.0    three little voice dots travel along it, there and back;
 * 2.6–3.3    "You’re connected. Say something." under it; "Your first call."
 *            above;
 * 3.3–6.5    read, then the settled frame; 6.5–7.5 it fades.
 * Passive, in the upper half, so the call's own controls stay reachable.
 */
const DOTS = [0, 1, 2];

export const FirstCallMoment: React.FC = () => (
    <div className="mo-fc mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-fc-scene">
                <div className="mo-fc-keys">
                    <Keys size={104} interactive={false} waveOnMount={false} face="happy" />
                </div>
                <div className="mo-fc-can mo-fc-can-near">
                    <svg viewBox="0 0 50 64" width="50" height="64">
                        <ellipse cx="25" cy="10" rx="21" ry="8" fill="#B9C3DD" />
                        <path d="M4 10 L8 56 Q25 66 42 56 L46 10 Q25 20 4 10 Z" fill="#8D9AB8" />
                        <path d="M10 22 Q25 28 40 22" stroke="#FF6B5E" strokeWidth="5" fill="none" />
                        <ellipse cx="25" cy="10" rx="14" ry="4.5" fill="#5B6788" />
                    </svg>
                </div>
                <svg className="mo-fc-line mo-fc-slack" viewBox="0 0 300 80" width="300" height="80">
                    <path d="M0 4 Q150 84 300 4" stroke="#F4F7FF" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                </svg>
                <div className="mo-fc-taut">
                    <svg className="mo-fc-line" viewBox="0 0 300 80" width="300" height="80">
                        <path d="M0 4 L300 4" stroke="#F4F7FF" strokeWidth="2.5" fill="none" strokeLinecap="round" />
                    </svg>
                    {DOTS.map(i => <span key={i} className={`mo-fc-voice mo-fc-voice-${i}`} />)}
                </div>
                <span className="mo-fc-ping" />
                <div className="mo-fc-far">
                    <div className="mo-fc-can">
                        <svg viewBox="0 0 50 64" width="50" height="64">
                            <ellipse cx="25" cy="10" rx="21" ry="8" fill="#B9C3DD" />
                            <path d="M4 10 L8 56 Q25 66 42 56 L46 10 Q25 20 4 10 Z" fill="#8D9AB8" />
                            <path d="M10 22 Q25 28 40 22" stroke="#25E0C8" strokeWidth="5" fill="none" />
                            <ellipse cx="25" cy="10" rx="14" ry="4.5" fill="#5B6788" />
                        </svg>
                    </div>
                </div>
            </div>
            <div className="mo-fc-cap">Your first call.</div>
            <div className="mo-pill mo-fc-pill" data-read>You’re connected. Say something.</div>
        </div>
    </div>
);

export default FirstCallMoment;
