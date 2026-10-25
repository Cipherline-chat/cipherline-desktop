import React from 'react';
import '../../../styles/moment-echo-everyone.css';

/**
 * "@everyone… everyone… one…" — pinging everyone in a server that is only you.
 *
 * 0.0–0.5 s  notice: the backdrop dims, a dusty horizon fades in;
 * 0.5–3.9    the ping echoes away: "@everyone", "…everyone", "…one", each
 *            fainter and further off (each up long enough to read);
 * 0.9–4.6    a tumbleweed bounces across the screen, kicking up sand;
 * 2.1, 3.5   two lonely "chirp."s;
 * 3.6–4.2    "It’s just you in here." — and the host's real "Invite friends"
 *            button (MomentDef.action) comes up with it.
 * Then everything settles (by 4.7) and the moment WAITS: the button stays
 * until it is pressed, the backdrop is clicked, or a key is pressed.
 */
const Tumbleweed: React.FC = () => (
    <svg viewBox="0 0 100 100" width="96" height="96">
        <g fill="none" stroke="#B89A66" strokeWidth="3.2" strokeLinecap="round">
            <circle cx="50" cy="50" r="40" />
            <path d="M14 40 Q50 8 86 42 Q60 90 18 62 Q40 30 76 30 Q88 66 50 86 Q22 70 30 34" />
            <path d="M24 26 Q66 46 70 82 M80 26 Q44 50 28 80 M50 12 Q36 52 62 88" />
            <path d="M36 18 Q72 30 84 58 Q52 62 20 50" stroke="#9C7F4F" />
        </g>
    </svg>
);

export const EchoEveryoneMoment: React.FC = () => (
    <div className="mo-echo mo-view" aria-hidden="true">
        <div className="mo-dim" />
        <div className="mo-anchor">
            <div className="mo-echo-word mo-echo-w1 mo-punch">@everyone</div>
            <div className="mo-echo-word mo-echo-w2 mo-punch">…everyone</div>
            <div className="mo-echo-word mo-echo-w3 mo-punch">…one</div>
            <div className="mo-echo-ground" />
            <div className="mo-echo-tw-x">
                <div className="mo-echo-tw-y">
                    <div className="mo-echo-tw-r"><Tumbleweed /></div>
                </div>
            </div>
            {[0, 1, 2].map(i => <span key={i} className={`mo-echo-dust mo-echo-dust-${i}`} />)}
            <div className="mo-echo-chirp mo-echo-chirp-1">chirp.</div>
            <div className="mo-echo-chirp mo-echo-chirp-2">chirp.</div>
            <div className="mo-echo-line mo-punch" data-read>It’s just you in here.</div>
        </div>
    </div>
);

export default EchoEveryoneMoment;
