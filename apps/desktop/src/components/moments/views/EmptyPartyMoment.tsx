import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-empty-party.css';

/**
 * "Keys put the snacks out anyway." — joining voice in a server where nobody
 * else is online.
 *
 * 0.0–0.6 s  notice: an empty little table slides up at the bottom;
 * 0.5–1.5    Keys scoots in, in his party hat, and waves;
 * 1.7–3.05   snacks plop down one by one: chips, a fizzy drink, a cupcake;
 * 2.8–3.35   pennant bunting drops in over the table;
 * 3.2–3.7    "Snacks are out. Guests: any minute now.";
 * 3.7–8.3    read, then the settled frame;
 * 8.3–8.9    the party fades (nobody came).
 * Passive, bottom of the screen, so the call controls stay reachable.
 */
const FLAGS = ['#25E0C8', '#FFC94D', '#FF6B5E', '#5e8ee0', '#4ADE80', '#FF8FB1', '#25E0C8'];

export const EmptyPartyMoment: React.FC = () => (
    <div className="mo-ep mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <div className="mo-ep-scene">
                <div className="mo-ep-bunting">
                    <svg viewBox="0 0 280 40" width="280" height="40">
                        <path d="M0 4 Q140 26 280 4" stroke="#9AA6C8" strokeWidth="2" fill="none" />
                        {FLAGS.map((c, i) => {
                            const x = 14 + i * 38;
                            const y = 4 + 22 * (1 - Math.pow((x - 140) / 140, 2)) * 0.95;
                            return <path key={i} d={`M${x - 11} ${y} L${x + 11} ${y} L${x} ${y + 20} Z`} fill={c} />;
                        })}
                    </svg>
                </div>
                <div className="mo-ep-table">
                    <svg viewBox="0 0 280 90" width="280" height="90">
                        <rect x="0" y="0" width="280" height="14" rx="7" fill="#243056" />
                        <rect x="30" y="14" width="10" height="76" rx="4" fill="#1C2542" />
                        <rect x="240" y="14" width="10" height="76" rx="4" fill="#1C2542" />
                    </svg>
                </div>
                <div className="mo-ep-snack mo-ep-chips">
                    <svg viewBox="0 0 70 44" width="70" height="44">
                        <path d="M10 6 L58 4 L54 20 L14 22 Z" fill="#FFC94D" /><path d="M20 2 L30 10 L42 0 L50 8" stroke="#E0A92F" strokeWidth="3" fill="none" />
                        <path d="M2 18 Q35 50 68 18 Z" fill="#5e8ee0" />
                    </svg>
                </div>
                <div className="mo-ep-snack mo-ep-drink">
                    <svg viewBox="0 0 40 64" width="40" height="64">
                        <path d="M26 0 L22 22" stroke="#FF6B5E" strokeWidth="3" strokeLinecap="round" />
                        <path d="M4 18 L36 18 L31 62 L9 62 Z" fill="rgba(37,224,200,.75)" />
                        <circle cx="16" cy="40" r="2.5" fill="#E9FFFB" /><circle cx="24" cy="50" r="2" fill="#E9FFFB" /><circle cx="20" cy="30" r="1.8" fill="#E9FFFB" />
                    </svg>
                </div>
                <div className="mo-ep-snack mo-ep-cake">
                    <svg viewBox="0 0 50 64" width="50" height="64">
                        <rect x="23" y="2" width="4" height="16" rx="2" fill="#F4F7FF" /><path d="M25 -4 Q30 2 25 6 Q20 2 25 -4" fill="#FFC94D" />
                        <path d="M6 30 Q25 10 44 30 Z" fill="#FF8FB1" /><path d="M8 30 L42 30 L37 62 L13 62 Z" fill="#B8865A" />
                    </svg>
                </div>
                <div className="mo-ep-keys">
                    <Keys size={104} costume="party" interactive={false} waveOnMount={false} wave />
                </div>
            </div>
            <div className="mo-pill mo-ep-pill" data-read>Snacks are out. Guests: any minute now.</div>
        </div>
    </div>
);

export default EmptyPartyMoment;
