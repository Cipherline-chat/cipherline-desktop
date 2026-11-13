import { useEffect, useMemo } from 'react';
import { useArt } from './useIntegrations';
import { useSteamCardEntry } from './useProfileRelations';
import { steamNowPlayingTrusted } from '../utils/integrations/ownGameEnd';
import { listeningDetail, SOURCE_LABEL, useListening } from '../utils/integrations/listening';
import { activityLink } from '../utils/integrations/activityLinks';
import { useListeningArt } from '../utils/integrations/listeningArt';
import { useFriendCover } from '../utils/integrations/friendCover';
import { buildCoverEvidence } from '../utils/integrations/coverReport';
import { useReportOpen } from '../contexts/ReportOpenContext';
import { useGameArt, useGameArtRecord } from './useGameArt';
import { gameArtCache } from '../utils/gameArt';
import type { GameGlyph } from '../utils/gameCatalog';

/**
 * What someone is doing right now, from every source the integrations know,
 * in display order - the data behind the profile's activity row
 * (hooks/useProfileActivity.ts seam, INTEGRATION_SLOTS.md):
 *
 *  1. Playing: the game THIS app detected (presence), else - only when that
 *     has nothing - what Steam says they are in (verified Steam + the API's
 *     STEAM_WEB_API_KEY), with the store header art via our art proxy.
 *  2. Listening to / Watching: friends-only (the API only ever sends it to
 *     friends), from their own device's media session. On YOUR profile, the
 *     cover your device read; on a friend's, for the Spotify app, THEIR own
 *     cover, end-to-end encrypted and decrypted here (friendCover.ts - a
 *     PROFILE-VIEW-only fetch, reportable through `report`), else the cover
 *     the SERVER picked for the track, fetched through our API
 *     (listeningArt.ts), else the music note. Watching: never a picture.
 *     Pressing it opens the song / video (activityLinks.ts): the exact item
 *     when the sharer's player gave its id, else a search on that platform,
 *     else nothing (local players).
 *
 * Structurally the profile UI's `ProfileActivity` (components/profile/integrationTypes.ts).
 */
export interface IntegrationActivity {
    kind: 'playing' | 'listening' | 'watching';
    title: string;
    detail?: string | null;
    art?: string | null;
    source: string;
    progress?: { startedAt: number; durationMs: number } | null;
    url?: string | null;
    linkLabel?: string | null;
    /** 'icon' = an executable icon (contained in the art box), 'cover' = a store picture (fills it). */
    artShape?: 'icon' | 'cover' | null;
    /** A plain drawing for when there is no picture (Minecraft's cube). */
    glyph?: GameGlyph | null;
    /** Report the picture shown (a friend's end-to-end encrypted cover only). */
    report?: (() => void) | null;
}

export interface IntegrationActivityInput {
    userId: string;
    token: string | null;
    /** The verified Steam id the profile carries (null = none / hidden). */
    steamId: string | null;
    liveGame: string | null;
    /** Your own profile: your own game's executable icon is available (main read it on this computer). */
    isSelf?: boolean;
    /** Published presence; nothing shows for someone offline. */
    offline: boolean;
    /** For the report dialog's title; the report action is offered only when known. */
    username?: string | null;
}

export function useIntegrationActivity({ userId, token, steamId, liveGame, isSelf = false, offline, username }: IntegrationActivityInput): IntegrationActivity[] {
    // Steam's now-playing expires 90 s after its fetch and is re-read every minute while this stays open
    // (hooks/useProfileRelations.ts); on YOUR profile it also waits out a game this app saw end.
    const { card: steam, at: steamAt } = useSteamCardEntry(steamId ? userId : null, token);
    const steamNow = !offline && !liveGame && (!isSelf || steamNowPlayingTrusted(steamAt)) ? steam?.activity?.nowPlaying ?? null : null;
    const steamArt = useArt(steamNow?.art ? [steamNow.art.portrait, steamNow.art.header, steamNow.art.capsule] : null, token);
    // Steam's own "playing" row remembers its picture per game on this device, so the next time it is instant.
    const steamRec = useGameArtRecord(steamNow?.name ?? null);
    useEffect(() => {
        if (steamNow && steamArt) gameArtCache.put(steamNow.name, { cover: steamArt, ...(steamNow.appId !== null ? { appId: steamNow.appId } : {}) });
    }, [steamNow, steamArt]);
    // The detected game: its icon / store picture / source label / link (hooks/useGameArt.ts).
    const game = useGameArt(!offline ? liveGame : null, { isSelf, token });
    const heard = useListening(offline ? null : userId);
    const friendArt = useListeningArt(heard && !heard.art && heard.kind === 'listening' ? userId : null, heard?.artRef);
    // A friend's own Spotify cover, end-to-end encrypted (never your own record: you have `art`).
    const sealed = useFriendCover(heard && !heard.art && heard.kind === 'listening' && heard.source === 'spotify' ? userId : null, heard?.coverId);
    const openReport = useReportOpen();

    return useMemo(() => {
        const out: IntegrationActivity[] = [];
        if (!offline && liveGame) {
            out.push({
                kind: 'playing', title: liveGame, source: 'game', art: game.art, artShape: game.artShape,
                detail: game.detail, url: game.url, linkLabel: game.linkLabel, glyph: game.glyph,
            });
        } else if (steamNow) {
            out.push({
                kind: 'playing', title: steamNow.name, detail: 'on Steam', source: 'steam', art: steamArt ?? steamRec?.cover ?? null, artShape: 'cover',
                url: steamNow.appId !== null ? `https://store.steampowered.com/app/${steamNow.appId}/` : null,
            });
        }
        if (heard) {
            const app = SOURCE_LABEL[heard.source];
            const link = activityLink(heard);
            out.push({
                kind: heard.kind,
                title: heard.track,
                // Watching: the channel / app ("Kurzgesagt · YouTube"), never "by".
                detail: heard.kind === 'watching' ? listeningDetail(heard) : app ? `by ${heard.artist} on ${app}` : `by ${heard.artist}`,
                source: heard.source,
                art: heard.art ?? sealed?.url ?? friendArt ?? null,
                progress: heard.durationMs ? { startedAt: heard.startedAt, durationMs: heard.durationMs } : null,
                url: link?.url ?? null,
                linkLabel: link?.label ?? null,
                report: sealed && !heard.art && openReport && username
                    ? () => {
                        void buildCoverEvidence({ track: heard.track, artist: heard.artist, album: heard.album, cover: sealed })
                            .then(ev => openReport(userId, username, undefined, ev), () => openReport(userId, username));
                    }
                    : null,
            });
        }
        return out;
    }, [offline, liveGame, game, steamNow, steamArt, steamRec, heard, friendArt, sealed, openReport, username, userId]);
}
