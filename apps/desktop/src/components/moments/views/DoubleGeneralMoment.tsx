import React from 'react';
import '../../../styles/moment-double-general.css';

/**
 * "#general, meet #general." — creating a second channel called general.
 *
 * 0.0–0.5 s  notice: a soft ripple in the middle;
 * 0.5–1.8    two identical "# general" signposts slide in from opposite sides,
 *            bump in the middle ("!"), spring apart;
 * 1.9–3.9    they look each other up and down (a little tilt each way), then
 *            both shrug; 2.1–2.6 "#general, meet #general.";
 * 2.6–6.3    read, then the settled frame; 6.3–6.9 they back off and fade.
 */
const Sign: React.FC = () => (
    <svg viewBox="0 0 170 150" width="170" height="150">
        <rect x="78" y="56" width="14" height="94" rx="4" fill="#5B6788" />
        <rect x="0" y="4" width="170" height="60" rx="14" fill="#1C2542" stroke="#2A3558" strokeWidth="3" />
        <text x="85" y="45" textAnchor="middle" fontFamily="var(--cl-font-display, Fredoka)" fontWeight="600" fontSize="28" fill="#F4F7FF">
            <tspan fill="#25E0C8">#</tspan> general
        </text>
    </svg>
);

export const DoubleGeneralMoment: React.FC = () => (
    <div className="mo-dg mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-dg-l"><div className="mo-dg-tilt mo-dg-tilt-l"><Sign /></div></div>
            <div className="mo-dg-r"><div className="mo-dg-tilt mo-dg-tilt-r"><Sign /></div></div>
            <span className="mo-dg-bonk">!</span>
            <div className="mo-pill mo-dg-pill" data-read><b>#general</b>, meet <b>#general</b>.</div>
        </div>
    </div>
);

export default DoubleGeneralMoment;
