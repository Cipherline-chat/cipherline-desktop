import { isFriendsOnly } from '../../utils/profileVisibility';
import { sanitizeLinks } from '../../utils/profileLinks';
import { readTheme } from '../../utils/profileTheme';
import { cleanInterests, showcaseBlocksOf } from '../../utils/profileExtras';
import { readItemOptions } from '../../utils/profileCosmetics';
import type { PublicProfile } from '../../utils/profileCache';
import type { PlayedGame } from '../../utils/achievements/mostPlayed';
import type { ProfileCardData } from './profileCardData';

/** What the viewer's own device adds to a person's public profile response. */
export interface ProfileCardContext {
    isOwn: boolean;
    /** Whole years when today is your friendship anniversary (friends only), else 0. */
    anniversary: number;
    /** Your own interests, to highlight the shared ones (others' cards only). */
    myInterests: readonly string[] | null;
    mostPlayed: readonly PlayedGame[];
    /** "You verified their safety number" (read locally; never sent anywhere). */
    verified: boolean;
    steamPersona?: string | null;
    steamAvatar?: string | null;
}

/**
 * Everything the profile card draws, from the profile response (the server
 * already withheld whatever this viewer may not see; the friends-only flags
 * only draw the lock a friend sees). Shared by the preview popover
 * (ProfileModal) and the DM side panel card (DmProfileCard).
 */
export function buildProfileCardData(profile: PublicProfile, c: ProfileCardContext): ProfileCardData {
    const showcase = showcaseBlocksOf(profile.showcase);
    return {
        name: profile.username || '',
        discriminator: profile.discriminator,
        theme: readTheme(profile.profile_theme),
        decoration: profile.avatar_decoration ?? null,
        effect: profile.profile_effect ?? null,
        decorationOptions: readItemOptions(profile.cosmetic_options?.d, 'decoration', profile.avatar_decoration),
        effectOptions: readItemOptions(profile.cosmetic_options?.e, 'effect', profile.profile_effect),
        // Card hover animation: removed on owner request 2026-10-23; the server field users.hover_animation is now unused by the desktop.
        isPro: profile.is_pro,
        proSince: profile.pro_since,
        badges: profile.badges,
        level: profile.level,
        levelPoints: typeof profile.level_points === 'number' ? profile.level_points : null,
        bio: profile.bio,
        bioFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'bio'),
        timeZone: profile.time_zone ?? null,
        localTimeFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'local_time'),
        friendsSince: profile.friends_since ?? null,
        anniversaryYears: c.anniversary,
        highFiveCount: profile.high_five_count ?? 0,
        blocks: showcase.blocks,
        topAchievements: showcase.top_achievements,
        games: profile.widgets?.games ?? [],
        gamesFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'widgets'),
        links: sanitizeLinks(profile.links),
        linksFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'links'),
        interests: cleanInterests(profile.interests),
        myInterests: c.isOwn ? null : (c.myInterests ?? []),
        interestsFriendsOnly: isFriendsOnly(profile.friends_only_fields, 'widgets'),
        achievementCount: profile.achievement_count ?? null,
        mostPlayed: c.mostPlayed,
        verified: c.verified,
        steam: profile.steam?.steam_id ? { steamId: profile.steam.steam_id, personaName: c.steamPersona ?? null, avatar: c.steamAvatar ?? null } : null,
    };
}
