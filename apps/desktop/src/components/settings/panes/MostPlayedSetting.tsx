import React, { useEffect, useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import { ClToggle } from '../../cl';
import { SettingsDisclosure } from '../SettingsDisclosure';
import { getTracker, subscribeBind } from '../../../utils/achievements/tracker';

/**
 * Settings → Personalize → "Show my most played games to friends".
 *
 * OFF by default. The setting is account-wide (it rides the encrypted
 * achievements snapshot to your other devices; the latest change wins, and a
 * tie resolves to off). Turning it ON publishes only your rolling-week top 3
 * {game, minutes} for accepted friends to see; turning it OFF deletes every
 * published row on the server. Play time is counted on this computer from the
 * same game detection as your status, so it needs "Share what you're playing"
 * (Game Activity) to be on.
 */
export const MostPlayedSetting: React.FC = () => {
    const [on, setOn] = useState(false);
    const [ready, setReady] = useState(false);

    useEffect(() => {
        let off: (() => void) | undefined;
        const attach = () => {
            off?.();
            const t = getTracker();
            setReady(!!t);
            if (!t) return;
            const read = () => setOn(t.getState().prefs.mostPlayed);
            read();
            off = t.subscribe(read);
        };
        attach();
        const offBind = subscribeBind(attach);
        return () => { off?.(); offBind(); };
    }, []);

    return (
        <SettingsDisclosure
            id="personalize.activity" variant="card" title="Activity"
            summary={on ? 'Most played shown to friends' : 'Most played is private'}
            labels={['Most played this week', 'Show my most played games to friends']}
        >
            <p className="su-hint" style={{ margin: '0 0 4px' }}>
                Friends see your top three games from the last 7 days, with their minutes, only if you accept them as friends.
                Play time is counted on this computer and needs &ldquo;Share what you&rsquo;re playing&rdquo; in Game Activity.
            </p>
            <div className="su-row">
                <span className={`sd-tile${on ? '' : ' sd-tile--dim'}`}><Gamepad2 size={16} /></span>
                <div className="su-row-text">
                    <span className="su-row-label">Show my most played games to friends</span>
                    <span className="su-row-hint">{on ? 'On. Turn it off and everything shared is deleted.' : 'Off. Nothing is shared.'}</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle
                        checked={on}
                        disabled={!ready}
                        onChange={v => getTracker()?.setMostPlayed(v)}
                        aria-label="Show my most played games to friends"
                    />
                </div>
            </div>
        </SettingsDisclosure>
    );
};
