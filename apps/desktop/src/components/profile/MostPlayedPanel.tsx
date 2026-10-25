import React from 'react';
import { Gamepad2 } from 'lucide-react';
import { formatPlayTime } from '../../utils/achievements/format';
import type { PlayedGame } from '../../utils/achievements/mostPlayed';
import '../../styles/profile-card.css';

/**
 * "Most played this week": the top three games of the last 7 days as three
 * quiet bars. The server answers only for yourself and accepted friends; for
 * anyone else (or someone who has not opted in) it is the same empty list, and
 * the card simply leaves this section out (utils/profileCardLayout.ts).
 */
export const MostPlayedPanel: React.FC<{ games: readonly PlayedGame[] }> = ({ games }) => {
    if (games.length === 0) return null;
    const top = Math.max(1, ...games.map((g) => g.minutes));
    return (
        <section className="pcd-sec" aria-label="Most played this week" data-testid="most-played-panel">
            <div className="pcd-sec-head">
                <h3 className="pcd-sec-title"><Gamepad2 size={13} aria-hidden="true" /> Most played this week</h3>
            </div>
            <ol className="pcd-played">
                {games.map((g, i) => (
                    <li key={g.game} data-testid={`most-played-${i}`} style={{ ['--j' as string]: i } as React.CSSProperties}>
                        <div className="pcd-played-row"><b>{g.game}</b><span>{formatPlayTime(g.minutes)}</span></div>
                        <div
                            className="pcd-bar" role="progressbar" aria-valuemin={0} aria-valuemax={top} aria-valuenow={g.minutes}
                            aria-label={`${g.game}: ${formatPlayTime(g.minutes)} this week`}
                        >
                            <i style={{ width: `${(g.minutes / top) * 100}%` }} />
                        </div>
                    </li>
                ))}
            </ol>
        </section>
    );
};

export default MostPlayedPanel;
