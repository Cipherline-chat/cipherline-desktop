import { useMemo } from 'react';
import { useArt } from './useIntegrations';
import { useSteamCard } from './useProfileRelations';
import { SOURCE_LABEL, useListening } from '../utils/integrations/listening';

/**
 * What someone is doing right now, from every source the integrations know,
 * in display order - the data behind the profile's activity row
 * (hooks/useProfileActivity.ts seam, INTEGRATION_SLOTS.md):
 *
 *  1. Playing: the game THIS app detected (presence), else - only when that
 *     has nothing - what Steam says they are in (verified Steam + the API's
 *     STEAM_WEB_API_KEY), with the store header art via our art proxy.
 *  2. Listening to: friends-only (the API only ever sends it to friends), from
 *     their own device's media session. Art only on YOUR profile (your cover
 *     never leaves your device).
 *
 * Structurally the profile UI's `ProfileActivity` (components/profile/integrationTypes.ts).
 */
export interface IntegrationActivity {
    kind: 'playing' | 'listening';
    title: string;
    detail?: string | null;
    art?: string | null;
    source: string;
    progress?: { startedAt: number; durationMs: number } | null;
    url?: string | null;
}

export interface IntegrationActivityInput {
    userId: string;
    token: string | null;
    /** The verified Steam id the profile carries (null = none / hidden). */
    steamId: string | null;
    liveGame: string | null;
    /** Published presence; nothing shows for someone offline. */
    offline: boolean;
}

export function useIntegrationActivity({ userId, token, steamId, liveGame, offline }: IntegrationActivityInput): IntegrationActivity[] {
    const steam = useSteamCard(steamId ? userId : null, token);
    const steamNow = !offline && !liveGame ? steam?.activity?.nowPlaying ?? null : null;
    const steamArt = useArt(steamNow?.art ? [steamNow.art.portrait, steamNow.art.header, steamNow.art.capsule] : null, token);
    const heard = useListening(offline ? null : userId);

    return useMemo(() => {
        const out: IntegrationActivity[] = [];
        if (!offline && liveGame) {
            out.push({ kind: 'playing', title: liveGame, source: 'game' });
        } else if (steamNow) {
            out.push({
                kind: 'playing', title: steamNow.name, detail: 'on Steam', source: 'steam', art: steamArt ?? null,
                url: steamNow.appId !== null ? `https://store.steampowered.com/app/${steamNow.appId}/` : null,
            });
        }
        if (heard) {
            const app = SOURCE_LABEL[heard.source];
            out.push({
                kind: 'listening',
                title: heard.track,
                detail: app ? `by ${heard.artist} on ${app}` : `by ${heard.artist}`,
                source: heard.source,
                art: heard.art ?? null,
                progress: heard.durationMs ? { startedAt: heard.startedAt, durationMs: heard.durationMs } : null,
            });
        }
        return out;
    }, [offline, liveGame, steamNow, steamArt, heard]);
}
