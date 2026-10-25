import type { ProfileTheme } from '../../utils/profileTheme';
import type { ItemOptions } from '../../utils/profileCosmetics';
import type { ShowcaseBlock } from '../../utils/profileExtras';
import type { ProfileBadge } from '../../utils/profileBadges';
import type { ProfileLink } from '../../utils/profileLinks';
import type { PlayedGame } from '../../utils/achievements/mostPlayed';

/**
 * Everything the profile surfaces draw about a person, already filtered by the
 * server for this viewer. Built by ProfileModal (from the profile response)
 * and by the Settings preview (from your drafts). Drawn by the preview popover
 * (ProfilePopoutCard) and the full profile (ProfileFullView).
 */
export interface ProfileCardData {
    name: string;
    discriminator: number | null | undefined;
    theme: ProfileTheme | null;
    decoration: string | null;
    effect: string | null;
    /** The owner's knobs for the decoration / effect (hue, intensity, density, speed). */
    decorationOptions?: ItemOptions | null;
    effectOptions?: ItemOptions | null;
    isPro?: boolean;
    proSince?: string | null;
    badges?: readonly ProfileBadge[] | null;
    level?: number;
    bio?: string | null;
    bioFriendsOnly?: boolean;
    timeZone?: string | null;
    localTimeFriendsOnly?: boolean;
    /** 'YYYY-MM' (friends only). */
    friendsSince?: string | null;
    /** Whole years when today is your friendship anniversary, else 0. */
    anniversaryYears?: number;
    /** Shown in the facts on your OWN profile (others get it on the high-five button). */
    highFiveCount?: number;
    blocks: readonly ShowcaseBlock[];
    topAchievements: readonly string[];
    games: readonly string[];
    gamesFriendsOnly?: boolean;
    links: readonly ProfileLink[];
    linksFriendsOnly?: boolean;
    interests: readonly string[];
    /** The viewer's own interests (others' profiles only): highlights the shared ones. */
    myInterests?: readonly string[] | null;
    interestsFriendsOnly?: boolean;
    /** Unlocked achievements (public); null = unknown. */
    achievementCount: number | null;
    mostPlayed: readonly PlayedGame[];
    verified?: boolean;
    /** A verified Steam account (Steam OpenID) the viewer may see; persona is filled in when fetched. */
    steam?: { steamId: string; personaName: string | null; avatar: string | null } | null;
}

/** The full profile's tabs, in order. */
export type ProfileFullTab = 'overview' | 'achievements' | 'friends' | 'servers' | 'integrations';
