import React from 'react';
import { refreshSteamCard, useSteamCard } from '../../hooks/useProfileRelations';
import { useUserIntegrations } from '../../hooks/useIntegrations';
import { SteamPrivateNotice, SteamShowcase } from './SteamShowcase';
import { SpotifyShowcase } from './SpotifyShowcase';
import { steamHasShowcaseStats, steamNeedsOwnerNotice } from '../../utils/integrations/api';
import '../../styles/integrations.css';

/**
 * The integrations panels of a profile: the Steam showcase (identity, level +
 * XP, library, hours, most played, last two weeks, achievements) and the
 * Spotify showcase (picked playlists / albums). Drawn by the full profile's
 * Integrations tab (ProfileIntegrationsExtras seam, INTEGRATION_SLOTS.md).
 * Each panel renders only when it has something to show; both reads are
 * behind the owner's `links` visibility on the server, and Steam stats also
 * behind the owner's own "Show Steam stats" switch (on by default).
 */
export const ProfileIntegrationsPanels: React.FC<{
    userId: string;
    isSelf: boolean;
    token: string | null;
    /** The verified Steam id on the profile (null = none / hidden). */
    steamId: string | null;
}> = ({ userId, isSelf, token, steamId }) => {
    const steam = useSteamCard(steamId ? userId : null, token);
    const { spotify } = useUserIntegrations(userId, token);
    // Your own card carries your stats even while you hide them (for Settings); your profile follows the switch.
    const activity = steam && !(isSelf && steam.statsHidden) ? steam.activity ?? null : null;
    // Private Steam with nothing public to show: viewers get no card (the verified Steam row stands alone); you get the how-to.
    const showCard = !!activity && steamHasShowcaseStats(activity);
    const ownerNotice = isSelf && !!activity && steamNeedsOwnerNotice(activity);
    if (!showCard && !ownerNotice && spotify.length === 0) return null;
    return (
        <>
            {ownerNotice && activity && (
                <section className="pfp-panel-card ig-panel" aria-labelledby={`ig-steam-${userId}`}>
                    <h3 className="pcd-sec-title" id={`ig-steam-${userId}`}>Steam</h3>
                    <SteamPrivateNotice activity={activity} onCheckAgain={token ? () => refreshSteamCard(userId, token) : undefined} />
                </section>
            )}
            {showCard && activity && (
                <section className="pfp-panel-card ig-panel" aria-labelledby={`ig-steam-${userId}`}>
                    <h3 className="pcd-sec-title" id={`ig-steam-${userId}`}>Steam</h3>
                    <SteamShowcase activity={activity} token={token} isSelf={isSelf} personaName={steam?.persona_name ?? null} avatar={steam?.avatar ?? null} />
                </section>
            )}
            {spotify.length > 0 && (
                <section className="pfp-panel-card ig-panel" aria-labelledby={`ig-spotify-${userId}`}>
                    <h3 className="pcd-sec-title" id={`ig-spotify-${userId}`}>Spotify</h3>
                    <SpotifyShowcase items={spotify} token={token} />
                </section>
            )}
        </>
    );
};

export default ProfileIntegrationsPanels;
