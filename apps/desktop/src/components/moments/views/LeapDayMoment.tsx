import React from 'react';
import '../../../styles/moment-leap-day.css';

/**
 * "Bonus day. Try not to waste it." — February 29th.
 *
 * 0.0–0.5 s  notice: a tear-off calendar pops in showing FEBRUARY 28;
 * 0.5–1.5    it sits there, ordinary;
 * 1.5–2.2    the page flips over to reveal a 29 nobody expected, with a few
 *            sparkles;
 * 2.2–3.1    a frog leaps in from the left on a long arc and lands on the
 *            top edge of the calendar (squash, settle);
 * 2.6–3.5    "Bonus day. Try not to waste it." under it;
 * 3.5–6.6    read, then the settled frame; 6.6–7.6 it fades.
 * Passive and ambient: it waits until you're not typing or in a call.
 */
const SPARKS = [
    { x: -98, y: -46, d: 0 }, { x: 98, y: -34, d: 90 }, { x: -86, y: 60, d: 180 }, { x: 92, y: 70, d: 40 },
];

export const LeapDayMoment: React.FC = () => (
    <div className="mo-ld mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-ld-scene">
                <div className="mo-ld-cal">
                    <div className="mo-ld-rings"><i /><i /><i /><i /></div>
                    {/* the page underneath: 29 */}
                    <div className="mo-ld-page mo-ld-under">
                        <div className="mo-ld-month">FEBRUARY</div>
                        <div className="mo-ld-num mo-ld-num-29">29</div>
                    </div>
                    {/* the top page: 28, which flips away */}
                    <div className="mo-ld-flipper">
                        <div className="mo-ld-page mo-ld-over">
                            <div className="mo-ld-month">FEBRUARY</div>
                            <div className="mo-ld-num">28</div>
                        </div>
                    </div>
                    {SPARKS.map((s, i) => (
                        <span key={i} className="mo-ld-spark" style={{ left: 100 + s.x, top: 115 + s.y, animationDelay: `${1950 + s.d}ms` }}>
                            <svg viewBox="0 0 20 20" width="20" height="20"><path d="M10 0 L12 8 L20 10 L12 12 L10 20 L8 12 L0 10 L8 8 Z" fill="#FFC94D" /></svg>
                        </span>
                    ))}
                </div>
                <div className="mo-ld-frog">
                    <div className="mo-ld-land">
                        <svg viewBox="0 0 84 60" width="84" height="60">
                            <ellipse cx="42" cy="44" rx="30" ry="15" fill="#4ADE80" />
                            <ellipse cx="42" cy="50" rx="19" ry="8" fill="#B6F2C9" />
                            <ellipse cx="14" cy="50" rx="13" ry="8" fill="#3BC56D" />
                            <ellipse cx="70" cy="50" rx="13" ry="8" fill="#3BC56D" />
                            <circle cx="28" cy="26" r="11" fill="#4ADE80" />
                            <circle cx="56" cy="26" r="11" fill="#4ADE80" />
                            <circle cx="28" cy="25" r="7" fill="#F4F7FF" />
                            <circle cx="56" cy="25" r="7" fill="#F4F7FF" />
                            <circle cx="29" cy="26" r="3.4" fill="#0B0F1E" />
                            <circle cx="57" cy="26" r="3.4" fill="#0B0F1E" />
                            <path d="M30 42 Q42 50 54 42" stroke="#1F7A44" strokeWidth="2.6" fill="none" strokeLinecap="round" />
                        </svg>
                    </div>
                </div>
            </div>
            <div className="mo-pill mo-ld-pill" data-read>Bonus day. Try not to waste it.</div>
        </div>
    </div>
);

export default LeapDayMoment;
