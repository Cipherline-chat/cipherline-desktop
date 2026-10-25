import React from 'react';
import { EyeOff } from 'lucide-react';
import { ProfileLinkIcon } from '../ProfileLinkIcon';
import { IntegrationArt } from './IntegrationArt';
import { openExternalLink } from '../../utils/openExternalLink';
import { formatPlaytime, steamLevelColor, type SteamActivity } from '../../utils/integrations/api';
import '../../styles/integrations.css';

/**
 * The Steam showcase: Steam level (in Steam's own ring colour for that band),
 * library size, and the games played in the last two weeks with their store
 * capsule, time this fortnight and all-time. Data: GET /v1/users/:id/steam
 * `activity` (the API's STEAM_WEB_API_KEY; absent = this whole block is not
 * drawn). Capsules come through our art proxy. A game opens its Steam store
 * page through the validated external-link path.
 */

export const SteamLevelBadge: React.FC<{ level: number; size?: 'sm' | 'md' }> = ({ level, size = 'md' }) => (
    <span
        className="ig-lvl" data-size={size}
        style={{ ['--ig-lvl' as string]: steamLevelColor(level) } as React.CSSProperties}
        title={`Steam level ${level}`} aria-label={`Steam level ${level}`}
    >{level}</span>
);

const storeUrl = (appId: number) => `https://store.steampowered.com/app/${appId}/`;

export const SteamShowcase: React.FC<{
    activity: SteamActivity;
    token: string | null;
    isSelf?: boolean;
    /** The Steam persona, for the heading line. */
    personaName?: string | null;
    className?: string;
}> = ({ activity, token, isSelf = false, personaName, className }) => {
    const { level, gameCount, recent } = activity;
    const peak = Math.max(1, ...recent.map((g) => g.minutes2w));
    const hasHead = level !== null || gameCount !== null;
    const games = gameCount !== null ? `${gameCount.toLocaleString('en-US')} ${gameCount === 1 ? 'game' : 'games'}` : null;
    return (
        <section className={['ig-steam', className ?? ''].filter(Boolean).join(' ')} aria-label="Steam" data-testid="steam-showcase">
            {hasHead && (
                <div className="ig-steam-head">
                    {level !== null && <SteamLevelBadge level={level} />}
                    <span className="ig-steam-id">
                        {personaName ? (
                            <>
                                <b><ProfileLinkIcon platform="steam" size={13} />{personaName}</b>
                                <span>{[level !== null ? `Level ${level}` : null, games].filter(Boolean).join(', ')}</span>
                            </>
                        ) : (
                            // Identity already shown next to it (Settings): just the numbers.
                            <>
                                <b>{level !== null ? `Steam level ${level}` : 'Steam'}</b>
                                {games && <span>{games} in the library</span>}
                            </>
                        )}
                    </span>
                </div>
            )}

            {activity.private ? (
                <p className="ig-steam-private">
                    <EyeOff size={14} aria-hidden="true" />
                    {isSelf
                        ? 'Your Steam game details are private, so recent games cannot show. Set Game details to Public in Steam’s privacy settings.'
                        : 'Their Steam game details are private.'}
                </p>
            ) : recent.length > 0 ? (
                <>
                    <h4 className="ig-sub">Last two weeks</h4>
                    <ul className="ig-games">
                        {recent.map((g) => (
                            <li key={g.appId}>
                                <button
                                    type="button" className="ig-game"
                                    onClick={(e) => { e.stopPropagation(); openExternalLink(storeUrl(g.appId)); }}
                                    aria-label={`${g.name}: ${formatPlaytime(g.minutes2w)} in the last two weeks, ${formatPlaytime(g.minutesTotal)} in total. Opens the Steam store page.`}
                                >
                                    <IntegrationArt refs={[g.art.capsule, g.art.icon]} token={token} className="ig-capsule"
                                        fallback={<ProfileLinkIcon platform="steam" size={16} />} />
                                    <span className="ig-game-txt">
                                        <b>{g.name}</b>
                                        <span className="ig-game-meter" aria-hidden="true"><i style={{ transform: `scaleX(${g.minutes2w / peak})` }} /></span>
                                    </span>
                                    <span className="ig-game-hours">
                                        <b>{formatPlaytime(g.minutes2w)}</b>
                                        <span>{formatPlaytime(g.minutesTotal)} total</span>
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </>
            ) : (
                <p className="ig-steam-private">{isSelf ? 'Nothing played on Steam in the last two weeks.' : 'Nothing played on Steam lately.'}</p>
            )}
        </section>
    );
};

export default SteamShowcase;
