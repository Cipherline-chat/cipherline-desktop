import React from 'react';
import { ConnectionsPane } from '../../integrations/ConnectionsPane';
import { MostPlayedSetting } from './MostPlayedSetting';
import { MyEmojisCard } from './PersonalizePane';
import { CallPersonalizeCard } from './CallPersonalizeCard';
import '../../../styles/settings-ui.css';

/**
 * Surface · Activity & Style - the old Connections and Personalize panes as
 * one section (owner, 2026-10-28: "put Personalize and Connections together
 * and name it something better"). Two groups, each under its own heading:
 *
 *  - Activity: what friends can see you up to. Listening / watching status and
 *    the Spotify showcase (ConnectionsPane), and your most played games.
 *    Everything here is OFF until you turn it on.
 *  - Style: things that are yours alone. My Emojis, and how you look and sound
 *    in a call (speaking ring, entrance sound).
 *
 * Steam is not here: it lives only under Profile > Showcase
 * (ProfileSteamSection). Your card's theme, decoration and effect are Profile >
 * Style. The old pane ids still land here (paneAliases.ts), and every card
 * keeps its old disclosure id, so a row you left open stays open.
 */
export const ActivityStylePane: React.FC = () => (
    <div className="as-pane pz-main" data-testid="activity-style-pane">
        <section className="as-group" aria-labelledby="as-activity-h" data-testid="as-group-activity">
            <header className="as-group-head">
                <h2 id="as-activity-h">Activity</h2>
                <p>What friends can see you up to. Nothing is shared until you turn it on.</p>
            </header>
            <ConnectionsPane />
            <MostPlayedSetting />
        </section>

        <section className="as-group" aria-labelledby="as-style-h" data-testid="as-group-style">
            <header className="as-group-head">
                <h2 id="as-style-h">Style</h2>
                <p>Yours alone: your emojis, and how you look and sound in a call. Your card&rsquo;s theme and effects are in Profile, under Style.</p>
            </header>
            <MyEmojisCard />
            <CallPersonalizeCard />
        </section>
    </div>
);

export default ActivityStylePane;
