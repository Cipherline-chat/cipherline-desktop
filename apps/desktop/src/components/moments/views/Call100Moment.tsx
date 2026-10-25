import React from 'react';
import '../../../styles/moment-call-100.css';

/**
 * "100 calls. Somebody was on mute." — the 100th call that connects.
 *
 * 0.0–0.5 s  notice: a counter panel pops in showing 097;
 * 0.5–2.2    it ticks up: 098, 099, then everything rolls over to 100 at once;
 * 2.2–2.9    a ring and a few specks burst off the new number;
 * 2.6–3.4    a muted microphone drops in beside it and gives a little shake;
 *            "100 calls. Somebody was on mute." under it; "Your 100th call."
 *            above;
 * 3.4–6.6    read, then the settled frame; 6.6–7.6 it fades.
 * Passive, in the upper half, so the call's own controls stay reachable.
 */
const SPECKS = Array.from({ length: 10 }, (_, i) => `${i * 36 + 12}deg`);
const COLORS = ['#25E0C8', '#FFC94D', '#FF8FB1', '#5e8ee0'];

const Col: React.FC<{ digits: string; cls: string; gold?: boolean }> = ({ digits, cls, gold }) => (
    <div className="mo-hundred-col">
        <div className={`mo-hundred-strip ${cls}`}>
            {[...digits].map((d, i) => <span key={i} className={gold && d === '1' ? 'mo-hundred-gold' : undefined}>{d}</span>)}
        </div>
    </div>
);

export const Call100Moment: React.FC = () => (
    <div className="mo-hundred mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <div className="mo-hundred-cap">Your 100th call.</div>
            <div className="mo-hundred-scene">
                <div className="mo-hundred-panel">
                    <Col digits="01" cls="mo-hundred-h" gold />
                    <Col digits="90" cls="mo-hundred-t" />
                    <Col digits="7890" cls="mo-hundred-o" />
                </div>
                <span className="mo-hundred-ring" />
                {SPECKS.map((a, i) => (
                    <span key={i} className="mo-hundred-speck" style={{ ['--a' as string]: a, background: COLORS[i % COLORS.length] }} />
                ))}
                <div className="mo-hundred-mic">
                    <div className="mo-hundred-shake">
                        <svg viewBox="0 0 48 60" width="48" height="60">
                            <rect x="16" y="2" width="16" height="30" rx="8" fill="#9AA6C8" />
                            <path d="M8 26 Q8 44 24 44 Q40 44 40 26" stroke="#9AA6C8" strokeWidth="4.5" fill="none" strokeLinecap="round" />
                            <path d="M24 44 V54 M15 55 H33" stroke="#9AA6C8" strokeWidth="4.5" strokeLinecap="round" />
                            <path d="M6 6 L42 52" stroke="#FF6B5E" strokeWidth="6" strokeLinecap="round" />
                        </svg>
                    </div>
                </div>
            </div>
            <div className="mo-pill mo-hundred-pill" data-read>100 calls. Somebody was on mute.</div>
        </div>
    </div>
);

export default Call100Moment;
