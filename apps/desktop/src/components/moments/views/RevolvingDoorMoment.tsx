import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-revolving-door.css';

/**
 * "Back already? The door spins both ways." — leaving a server and rejoining
 * it inside a minute.
 *
 * 0.0–0.5 s  notice: a revolving door fades in;
 * 0.5–3.3    Keys scoots into it; the glass panels spin (1.3–3.1); he comes straight
 *            back out the side he went in, and wobbles, a little dizzy (3.3–4.4);
 * 3.1–3.6    "Welcome back. That was quick.";
 * 3.6–7.6    read, then the settled frame; 7.6–8.2 it fades.
 */
export const RevolvingDoorMoment: React.FC = () => (
    <div className="mo-rd mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <div className="mo-rd-door">
                <svg className="mo-rd-frame" viewBox="0 0 240 290" width="240" height="290">
                    <rect x="6" y="30" width="228" height="256" rx="10" fill="rgba(28,37,66,.85)" stroke="#2A3558" strokeWidth="4" />
                    <path d="M0 36 Q120 -10 240 36 L240 44 L0 44 Z" fill="#243056" />
                    <rect x="112" y="44" width="16" height="242" fill="#5B6788" />
                </svg>
                <div className="mo-rd-spin">
                    {[0, 1, 2, 3].map(i => <span key={i} className="mo-rd-panel" style={{ ['--p' as string]: `${i * 90}deg` }} />)}
                </div>
            </div>
            <div className="mo-rd-keys">
                <div className="mo-rd-dizzy">
                    <Keys size={110} interactive={false} waveOnMount={false} idleSway={false} />
                </div>
            </div>
            <div className="mo-pill mo-rd-pill" data-read>Welcome back. <b>That was quick.</b></div>
        </div>
    </div>
);

export default RevolvingDoorMoment;
