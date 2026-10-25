import { useMemo } from 'react';
import type { PublicProfile } from '../utils/profileCache';
import { profileLinkUrl, sanitizeLinks, steamProfileUrl, platformLabel, displayHandle } from '../utils/profileLinks';
import type { ProfileConnection } from '../components/profile/integrationTypes';
import { useOptionalToken } from './useOptionalToken';
import { useSteamCard } from './useProfileRelations';
import { useUserIntegrations } from './useIntegrations';

/**
 * The accounts drawn on the full profile's Integrations tab
 * (components/profile/ProfileIntegrationsSection.tsx).
 *
 * SEAM (components/profile/INTEGRATION_SLOTS.md): the verified Steam account
 * and the typed profile links, which a verified account of the same platform
 * replaces (its level, library and recent games are the Steam panel in
 * ProfileIntegrationsExtras, so the card stays an identity). All behind the owner's `links` visibility,
 * enforced server-side. Also warms the Spotify showcase read, so the tab knows
 * whether ProfileIntegrationsExtras has something to draw.
 */
export interface ProfileConnectionsInput {
    userId: string;
    isSelf: boolean;
    profile: PublicProfile | null;
    /** The verified Steam persona, when fetched (useSteamCard). */
    steamPersona?: string | null;
}

export function useProfileConnections({ userId, profile, steamPersona }: ProfileConnectionsInput): ProfileConnection[] {
    const token = useOptionalToken();
    const steamId = profile?.steam?.steam_id ?? null;
    const links = profile?.links;
    const steam = useSteamCard(steamId ? userId : null, token ?? null);
    useUserIntegrations(profile ? userId : null, token ?? null);
    return useMemo(() => {
        const out: ProfileConnection[] = [];
        // `verified` is computed, never the literal: utils/firstVerification.test.ts reserves that
        // literal for safety-number pins (this tick means "Steam proved the account", a different thing).
        if (steamId) out.push({ platform: 'steam', name: steamPersona || steam?.persona_name || 'Steam account', verified: Boolean(steamId), url: steamProfileUrl(steamId) });
        for (const l of sanitizeLinks(links)) {
            if (steamId && l.platform === 'steam') continue;
            out.push({ platform: l.platform, name: displayHandle(l) || platformLabel(l.platform), url: profileLinkUrl(l) });
        }
        return out;
    }, [steamId, steamPersona, steam?.persona_name, links]);
}
