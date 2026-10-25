import React from 'react';
import '../../../styles/moment-note-to-self.css';

/**
 * "Read receipt: also you." — your first message to your own notes chat.
 *
 * 0.0–0.5 s  notice: the backdrop dims and a Lume swell rolls in;
 * 0.5–1.7    a message in a bottle bobs up out of the deep on the swell;
 * 2.0        the cork pops;
 * 2.3–3.2    the rolled note slides out of the neck; the bottle sinks away;
 * 2.8–3.6    the note unrolls sideways between its two rods: "Dear me, —
 *            Message delivered." (up ~0.8 s before the punchline);
 * 4.3–4.8    "Read receipt: also you.";
 * 4.8–8.4    read, then the settled frame; 8.4–9.0 it fades.
 */
export const NoteToSelfMoment: React.FC = () => (
    <div className="mo-nts mo-view" aria-hidden="true">
        <div className="mo-dim" />
        <div className="mo-anchor">
            <div className="mo-nts-swell">
                <svg viewBox="0 0 600 60" width="600" height="60">
                    <path d="M0 30 Q75 0 150 30 T300 30 T450 30 T600 30" stroke="rgba(37,224,200,.55)" strokeWidth="4" fill="none" strokeLinecap="round" />
                    <path d="M0 50 Q75 22 150 50 T300 50 T450 50 T600 50" stroke="rgba(37,224,200,.25)" strokeWidth="3" fill="none" strokeLinecap="round" />
                </svg>
            </div>
            <div className="mo-nts-bottle">
                <div className="mo-nts-bob">
                    <svg viewBox="0 0 90 180" width="90" height="180">
                        <path d="M33 10 L57 10 L57 48 Q84 62 84 96 L84 160 Q84 172 72 172 L18 172 Q6 172 6 160 L6 96 Q6 62 33 48 Z"
                            fill="rgba(37,224,200,.16)" stroke="rgba(37,224,200,.75)" strokeWidth="3" />
                        <rect x="24" y="92" width="42" height="64" rx="6" fill="#F6F1E4" />
                        <path d="M30 104 H60 M30 116 H58 M30 128 H52" stroke="#C9BFA6" strokeWidth="3" strokeLinecap="round" />
                        <path d="M18 70 Q14 100 16 140" stroke="rgba(244,247,255,.5)" strokeWidth="3" fill="none" strokeLinecap="round" />
                    </svg>
                    <div className="mo-nts-cork">
                        <svg viewBox="0 0 30 24" width="30" height="24"><rect x="2" y="0" width="26" height="24" rx="5" fill="#B8865A" /><path d="M8 6 H22 M8 14 H22" stroke="#9A6E46" strokeWidth="2" /></svg>
                    </div>
                </div>
            </div>
            <div className="mo-nts-note">
                <div className="mo-nts-paper">
                    <div className="mo-nts-text">
                        <div className="mo-nts-dear">Dear me,</div>
                        <div className="mo-nts-body">Message delivered.</div>
                        <div className="mo-nts-punch mo-punch" data-read>Read receipt: also you.</div>
                    </div>
                </div>
                <span className="mo-nts-rod mo-nts-rod-l" />
                <span className="mo-nts-rod mo-nts-rod-r" />
            </div>
        </div>
    </div>
);

export default NoteToSelfMoment;
