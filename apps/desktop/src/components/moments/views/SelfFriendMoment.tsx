import React from 'react';
import { Keys } from '../../mascot/Keys';
import '../../../styles/moment-self-friend.css';

/**
 * "You played yourself." — Add Friend with your own tag.
 *
 * 0.0–0.5 s  notice: the backdrop dims; a soft glint at the lower left;
 * 0.5–1.75   a wax-stamped envelope flies in on a long curved arc (separate X
 *            and Y easings), fluttering like paper; 1.75 lands with a squash;
 * 2.05–2.8   the seal pops (a coral burst); the flap swings open;
 * 2.8–3.85   the letter rises out and its top panel unfolds:
 *            "Friend request — From: you / To: you" (up ~1 s to be read);
 * 3.95       Keys peeks over the envelope's rim;
 * 4.4–4.9    the stamp lands: "You played yourself.";
 * 4.9–8.4    read, then the settled frame; 8.4–9.0 it drifts up and fades.
 *
 * Pure CSS keyframes on transform/opacity (styles/moment-self-friend.css);
 * the whole thing is decorative (aria-hidden) — the host announces the line.
 */
export const SelfFriendMoment: React.FC = () => (
    <div className="mo-sf mo-view" aria-hidden="true">
        <div className="mo-dim" />
        <div className="mo-anchor">
            <span className="mo-notice" />
            <div className="mo-sf-all">
                <div className="mo-sf-fx">
                    <div className="mo-sf-fy">
                        <div className="mo-sf-flutter">
                            <div className="mo-sf-land">
                                <div className="mo-sf-env">
                                    <svg className="mo-sf-back" viewBox="0 0 260 168" width="260" height="168">
                                        <rect x="0" y="0" width="260" height="168" rx="10" fill="#D8CDB4" />
                                    </svg>
                                    <svg className="mo-sf-flap-open" viewBox="0 0 260 92" width="260" height="92">
                                        <path d="M0 92 L130 6 L260 92 Z" fill="#CFC2A6" />
                                    </svg>
                                    <div className="mo-sf-keysclip">
                                        <div className="mo-sf-keys">
                                            <Keys size={88} interactive={false} waveOnMount={false} idleSway={false} face="happy" />
                                        </div>
                                    </div>
                                    <div className="mo-sf-letter">
                                        <div className="mo-sf-panel mo-sf-panel-bottom">
                                            <div className="mo-sf-row"><span>To:</span> <b>you</b></div>
                                        </div>
                                        {/* After the bottom panel in the DOM: folded, it lies on top. */}
                                        <div className="mo-sf-panel mo-sf-panel-top">
                                            <div className="mo-sf-face mo-sf-face-front">
                                                <div className="mo-sf-kicker">Friend request</div>
                                                <div className="mo-sf-row"><span>From:</span> <b>you</b></div>
                                            </div>
                                            <div className="mo-sf-face mo-sf-face-back" />
                                        </div>
                                    </div>
                                    <svg className="mo-sf-front" viewBox="0 0 260 168" width="260" height="168">
                                        <path d="M0 64 L130 116 L260 64 L260 158 Q260 168 250 168 L10 168 Q0 168 0 158 Z" fill="#EDE5D2" />
                                        <path d="M0 168 L118 110 M260 168 L142 110" stroke="#D8CDB4" strokeWidth="2" />
                                    </svg>
                                    <svg className="mo-sf-flap" viewBox="0 0 260 104" width="260" height="104">
                                        <path d="M0 0 L130 100 L260 0 Z" fill="#E4DAC3" />
                                        <path d="M0 0 L130 100 L260 0" stroke="#CFC2A6" strokeWidth="2" fill="none" />
                                    </svg>
                                    <div className="mo-sf-seal">
                                        <svg viewBox="0 0 40 40" width="40" height="40">
                                            <circle cx="20" cy="20" r="17" fill="#FF6B5E" />
                                            <circle cx="20" cy="20" r="12" fill="none" stroke="#C94A3F" strokeWidth="2" />
                                            <path d="M13 22 A7 7 0 0 1 27 22 L27 24 L13 24 Z" fill="#C94A3F" />
                                        </svg>
                                    </div>
                                    {[0, 1, 2, 3, 4, 5].map(i => (
                                        <span key={i} className="mo-sf-bit" style={{ ['--a' as string]: `${i * 60 + 15}deg` }} />
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div className="mo-sf-stamp mo-punch" data-read>You played yourself.</div>
        </div>
    </div>
);

export default SelfFriendMoment;
