import type { UserStatus } from './useUserStatus';
import type { PublicProfile } from '../utils/profileCache';
import type { ProfileActivity } from '../components/profile/integrationTypes';
import { useOptionalToken } from './useOptionalToken';
import { useIntegrationActivity } from './useIntegrationActivity';

/**
 * What a person is doing right now, for the activity row on the profile
 * preview and the full profile (components/profile/ProfileActivityRow.tsx).
 *
 * SEAM (components/profile/INTEGRATION_SLOTS.md), filled by the integrations
 * work (hooks/useIntegrationActivity.ts), in display order:
 *   1. Playing - the game this app detected, else (only then) what Steam says
 *      they are in, with the store art (verified Steam + STEAM_WEB_API_KEY);
 *   2. Listening to - friends only, from their own computer's media session.
 * Cheap on every open: the Steam card and art are cached per session, and
 * "listening" is a local store read.
 */
export interface ProfileActivityInput {
    userId: string;
    isSelf: boolean;
    /** Null while the profile is loading. */
    profile: PublicProfile | null;
    /** The live presence entry's game (null = none / offline / on mobile). */
    liveGame: string | null;
    status: UserStatus;
}

export function useProfileActivity({ userId, profile, liveGame, status }: ProfileActivityInput): ProfileActivity[] {
    const token = useOptionalToken();
    return useIntegrationActivity({
        userId,
        token: token ?? null,
        steamId: profile?.steam?.steam_id ?? null,
        liveGame,
        offline: status === 'offline',
    });
}
