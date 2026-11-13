import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { FriendStatusEntry } from '../../hooks/useUserStatus';
import { useProfileActivity } from '../../hooks/useProfileActivity';
import { fetchProfile as fetchProfileCached, peekProfile, __profilePrefetchTuning, type PublicProfile } from '../../utils/profileCache';
import { lookupUserBannerId } from '../../utils/peerIdentityCache';
import { formatLastSeen } from '../../utils/formatLastSeen';
import { anniversaryYearsFor } from '../../utils/profileMoments';
import { isFriendsOnly } from '../../utils/profileVisibility';
import { getVerificationState } from '../../utils/keyVerification';
import { ProfilePopoutCard } from './ProfilePopoutCard';
import { buildProfileCardData } from './buildProfileCardData';
import type { ProfileFullTab } from './profileCardData';
import { ProfilePresence, ProfileAvatarBadge } from './ProfilePresence';

/**
 * The profile card in the RIGHT-HAND panel of a DM: the SAME card the preview
 * popover draws (ProfilePopoutCard, fed through buildProfileCardData), filling
 * the panel's width, in its small form (owner 2026-10-27): banner, avatar +
 * decoration, effect, theme, badges, presence + custom status, the activity
 * row (playing / listening), bio and local time. No showcase highlight, Steam
 * row, mutuals, high five or "Open profile" button; the avatar and the name
 * open the full profile, which has all of it.
 *
 * Visibility is the server's: the profile response already withholds what this
 * viewer may not see. The friendship anniversary is only read for a friend.
 *
 * Motion: the effect loops while Cipherline is the window in front (the CSS
 * pauses it when the window is not, or the card is off screen), like every
 * profile surface; no entrance replay when you switch chats, a still frame
 * under reduced motion. Mount it with `key={userId}` so a chat switch swaps
 * the whole card.
 */
export const DmProfileCard: React.FC<{
    userId: string;
    token: string;
    currentUserId: string;
    /** The live presence entry for this person (useUserStatus), if any. */
    status?: FriendStatusEntry;
    isFriend: boolean;
    /** Shown while the profile loads / when it cannot (the conversation's own title + avatar). */
    fallbackName?: string | null;
    fallbackAvatarId?: string | null;
    /** Open the full profile (the avatar, the name). */
    onOpenFull: (tab?: ProfileFullTab) => void;
}> = ({ userId, token, currentUserId, status, isFriend, fallbackName, fallbackAvatarId, onOpenFull }) => {
    // Seeded from the session profile cache; revalidated underneath.
    const [profile, setProfile] = useState<PublicProfile | null>(() => peekProfile(userId));
    const [loading, setLoading] = useState(() => !peekProfile(userId));
    const [error, setError] = useState<string | null>(null);
    const load = useCallback(async () => {
        const cached = peekProfile(userId);
        setProfile(cached);
        setLoading(!cached);
        setError(null);
        try {
            setProfile(await fetchProfileCached(userId, token, { maxAgeMs: __profilePrefetchTuning.FRESH_MS }));
        } catch {
            if (!cached) setError('Could not load profile.');
        } finally {
            setLoading(false);
        }
    }, [userId, token]);
    useEffect(() => { void load(); }, [load]);

    const entry: FriendStatusEntry = useMemo(() => status ?? {
        status: profile?.status ?? 'offline',
        custom_status_text: profile?.custom_status_text ?? null,
        custom_status_emoji: profile?.custom_status_emoji ?? null,
        custom_status_expires_at: profile?.custom_status_expires_at ?? null,
        current_game: null,
        on_mobile: profile?.on_mobile ?? false,
    }, [status, profile]);
    const onMobile = entry.status !== 'offline' && !!entry.on_mobile;
    const playingNow = !!entry.current_game && entry.status !== 'offline' && !onMobile;
    const lastSeen = entry.status === 'offline' ? formatLastSeen(profile?.last_seen_at ?? null) : null;
    const activities = useProfileActivity({ userId, isSelf: false, profile, liveGame: playingNow ? entry.current_game ?? null : null, status: entry.status });

    const data = useMemo(() => profile ? buildProfileCardData(profile, {
        isOwn: false,
        anniversary: isFriend ? anniversaryYearsFor(userId) : 0,
        myInterests: null,
        mostPlayed: [],
        verified: !!currentUserId && getVerificationState(currentUserId, userId) === 'verified',
    }) : null, [profile, isFriend, userId, currentUserId]);

    return (
        <ProfilePopoutCard
            userId={userId}
            token={token}
            isSelf={false}
            className="ppo--panel"
            testId="dm-profile-card"
            label={fallbackName ? `${fallbackName}'s profile` : 'Profile'}
            enter={false}
            data={data}
            avatarId={profile ? profile.avatar_url : fallbackAvatarId ?? null}
            bannerId={profile ? profile.banner_url : lookupUserBannerId(userId)}
            bannerFriendsOnly={isFriendsOnly(profile?.friends_only_fields, 'banner')}
            loading={loading}
            error={error}
            onRetry={() => void load()}
            presence={profile ? <ProfilePresence entry={entry} userId={userId} onMobile={onMobile} lastSeen={lastSeen} /> : null}
            activities={activities}
            avatarBadge={!loading && <ProfileAvatarBadge entry={entry} onMobile={onMobile} />}
            brief
            onOpenFull={onOpenFull}
        />
    );
};

export default DmProfileCard;
