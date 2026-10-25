import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-anniversary.css';

/**
 * "Happy Cipherversary. Thanks for sticking around." — your account's birthday.
 *
 * 0.0–0.6 s  notice: a single bubble wobbles up from the bottom;
 * 0.5–1.5    a cake rises up from the bottom; 1.2–1.8 Keys pops up beside it
 *            in a party hat and waves;
 * 1.7–2.7    "Happy Cipherversary.", then "Thanks for sticking around.";
 * 1.5–6.5    the candle's flame is a bubble: it wobbles and lets go a stream
 *            of little bubbles (candles don't work down here), then settles;
 * 2.7–7.8    read, then the settled frame; 7.8–8.5 everything sinks back.
 */
export const AnniversaryMoment: React.FC = () => (
    <div className="mo-anv mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-anv-lead" />
            <div className="mo-anv-scene">
                <div className="mo-anv-cake">
                    {[0, 1, 2, 3, 4].map(i => <span key={i} className={`mo-anv-bub mo-anv-bub-${i}`} />)}
                    <span className="mo-anv-flame" />
                    <svg viewBox="0 0 160 150" width="160" height="150">
                        <rect x="76" y="16" width="8" height="34" rx="3" fill="#F4F7FF" />
                        <path d="M76 24 L84 30 M76 34 L84 40" stroke="#FF6B5E" strokeWidth="2.5" />
                        <rect x="14" y="50" width="132" height="44" rx="10" fill="#FF8FB1" />
                        <path d="M14 64 Q30 78 46 64 Q62 78 78 64 Q94 78 110 64 Q126 78 146 64 L146 60 L14 60 Z" fill="#F4F7FF" />
                        <rect x="4" y="90" width="152" height="52" rx="12" fill="#25E0C8" />
                        <circle cx="34" cy="116" r="5" fill="#FFC94D" /><circle cx="80" cy="120" r="5" fill="#FFC94D" /><circle cx="126" cy="116" r="5" fill="#FFC94D" />
                        <rect x="0" y="138" width="160" height="10" rx="5" fill="#9AA6C8" />
                    </svg>
                </div>
                <div className="mo-anv-keys">
                    <Keys size={96} costume="party" interactive={false} waveOnMount={false} wave />
                </div>
            </div>
            <div className="mo-anv-title mo-punch" data-read>Happy Cipherversary.</div>
            <div className="mo-anv-sub mo-punch" data-read>Thanks for sticking around.</div>
        </div>
    </div>
);

export default AnniversaryMoment;
