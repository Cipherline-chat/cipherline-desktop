import { cleanInterests, type ShowcaseBlock } from '../../../utils/profileExtras';
import type { ProfileTheme } from '../../../utils/profileTheme';
import type { VisibilityField } from '../../../utils/profileVisibility';
import type { ProfileLink } from '../../../utils/profileLinks';
import type { ProfileBadge } from '../../../utils/profileBadges';
import type { PlayedGame } from '../../../utils/achievements/mostPlayed';
import type { ItemOptions } from '../../../utils/profileCosmetics';
import type { ProfileCardData } from '../../profile/profileCardData';

/** Your own profile as the real card renders it. Drafts + saved values. */
export interface ProfilePreviewData {
    userId: string | undefined;
    token: string | null;
    username: string;
    discriminator: number | null | undefined;
    timeZone: string;
    bio: string;
    bannerAttachmentId: string | null;
    /** A picked-but-unsaved banner (blob: URL). */
    bannerSrc?: string | null;
    avatarAttachmentId: string | null;
    theme: ProfileTheme | null;
    decoration: string | null;
    effect: string | null;
    decorationOptions?: ItemOptions | null;
    effectOptions?: ItemOptions | null;
    games: string[];
    links: ProfileLink[];
    level?: number;
    /** About blocks in the owner's order (default: the legacy three). */
    blocks?: readonly ShowcaseBlock[];
    topAchievements?: readonly string[];
    interests?: readonly string[];
    isPro?: boolean;
    proSince?: string | null;
    badges?: readonly ProfileBadge[] | null;
    achievementCount?: number | null;
    highFiveCount?: number;
    /** Your most played (shown to friends only, when you opted in). */
    mostPlayed?: readonly PlayedGame[];
    /** Your verified Steam (follows the `links` visibility like the card). */
    steam?: { steamId: string; personaName: string | null; avatar: string | null } | null;
}

/** The card data an audience sees, from your drafts (`seen` = what that audience is shown). */
export function previewCardData(data: ProfilePreviewData, seen: Record<VisibilityField, boolean>, friendsOnly: VisibilityField[], asFriend: boolean): ProfileCardData {
    const locked = (f: VisibilityField) => asFriend && friendsOnly.includes(f);
    return {
        name: data.username,
        discriminator: data.discriminator,
        theme: data.theme,
        decoration: data.decoration,
        effect: data.effect,
        decorationOptions: data.decorationOptions ?? null,
        effectOptions: data.effectOptions ?? null,
        isPro: data.isPro,
        proSince: data.proSince,
        badges: data.badges,
        level: data.level,
        bio: seen.bio ? data.bio : null,
        bioFriendsOnly: locked('bio'),
        timeZone: seen.local_time ? data.timeZone.trim() || null : null,
        localTimeFriendsOnly: locked('local_time'),
        blocks: data.blocks ?? ['steam', 'games', 'links'],
        topAchievements: data.topAchievements ?? [],
        steam: seen.links ? data.steam ?? null : null,
        games: seen.widgets ? data.games : [],
        gamesFriendsOnly: locked('widgets'),
        links: seen.links ? data.links : [],
        linksFriendsOnly: locked('links'),
        interests: seen.widgets ? cleanInterests(data.interests ? [...data.interests] : []) : [],
        interestsFriendsOnly: locked('widgets'),
        achievementCount: data.achievementCount ?? null,
        // Strangers get the same empty list as someone with nothing; friends see it when you opted in.
        mostPlayed: asFriend ? data.mostPlayed ?? [] : [],
    };
}
