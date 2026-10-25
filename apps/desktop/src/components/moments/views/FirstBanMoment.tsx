import React from 'react';
import '../../../styles/moment-first-ban.css';

/**
 * "Justice has been served." — the first time you ban a member.
 *
 * 0.0–0.5 s  notice: a judge's sound block and a raised gavel fade in, with
 *            a blank, generic member silhouette off to one side (never the
 *            banned person's name or picture: it is a drawing);
 * 0.5–1.25   the gavel winds back slowly;
 * 1.25–1.45  BANG: it comes down on the block; a shockwave and a burst of
 *            bubbles;
 * 1.5–3.6    a bubble closes round the silhouette and it floats gently up and
 *            away (bubbled out, not hurt);
 * 2.6–3.1    "Justice has been served.";
 * 3.1–6.8    read, then the settled frame; 6.8–7.4 it fades.
 * Passive: the moderation UI underneath stays usable.
 */
const BURST = Array.from({ length: 8 }, (_, i) => `${i * 45 + 10}deg`);

export const FirstBanMoment: React.FC = () => (
    <div className="mo-fb mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <div className="mo-fb-scene">
                <div className="mo-fb-member">
                    <div className="mo-fb-float">
                        <svg viewBox="0 0 80 80" width="80" height="80">
                            <circle cx="40" cy="40" r="38" fill="#1C2542" />
                            <circle cx="40" cy="31" r="13" fill="#5B6788" />
                            <path d="M17 66 Q40 38 63 66 Q52 76 40 76 Q28 76 17 66 Z" fill="#5B6788" />
                        </svg>
                        <span className="mo-fb-bubble" />
                    </div>
                </div>
                <div className="mo-fb-block">
                    <svg viewBox="0 0 160 40" width="160" height="40">
                        <rect x="0" y="6" width="160" height="34" rx="10" fill="#6B4A2E" />
                        <rect x="10" y="0" width="140" height="14" rx="7" fill="#9A6E46" />
                    </svg>
                </div>
                <span className="mo-fb-ring mo-fb-ring-1" />
                <span className="mo-fb-ring mo-fb-ring-2" />
                {BURST.map((a, i) => <span key={i} className="mo-fb-bit" style={{ ['--a' as string]: a }} />)}
                <div className="mo-fb-gavel">
                    <svg viewBox="0 0 260 70" width="260" height="70">
                        <rect x="80" y="27" width="180" height="16" rx="8" fill="#9A6E46" />
                        <rect x="0" y="0" width="80" height="70" rx="12" fill="#B8865A" />
                        <rect x="0" y="12" width="80" height="9" fill="#FFC94D" />
                        <rect x="0" y="49" width="80" height="9" fill="#FFC94D" />
                    </svg>
            </div>
            </div>
            <div className="mo-pill mo-fb-pill" data-read>Justice has been served.</div>
        </div>
    </div>
);

export default FirstBanMoment;
