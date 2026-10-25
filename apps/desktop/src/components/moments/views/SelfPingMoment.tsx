import React from 'react';
import '../../../styles/moment-self-ping.css';

/**
 * "You pinged yourself." — an @mention of your own name.
 *
 * 0.0–0.5 s  notice: a Lume "@" bubble pops up by the composer and crouches;
 * 0.5–2.9    it launches, sails up the screen, loops like a boomerang and
 *            comes straight back (one long ease-in-out trip);
 * 2.9–3.2    it lands where it started with a squash and stays; a sonar
 *            double-ring spreads from it;
 * 2.95–3.4   "Ping! …it was you.";
 * 3.4–6.9    read, then the settled frame; 6.9–7.5 it fades.
 * Passive: clicks go straight through to the app.
 */
export const SelfPingMoment: React.FC = () => (
    <div className="mo-sp mo-view" aria-hidden="true">
        <div className="mo-anchor">
            <div className="mo-sp-trail mo-sp-trail-1" />
            <div className="mo-sp-trail mo-sp-trail-2" />
            <div className="mo-sp-dot"><span>@</span></div>
            <span className="mo-sp-ring mo-sp-ring-1" />
            <span className="mo-sp-ring mo-sp-ring-2" />
            <div className="mo-pill mo-sp-pill" data-read><b>Ping!</b> …it was you.</div>
        </div>
    </div>
);

export default SelfPingMoment;
