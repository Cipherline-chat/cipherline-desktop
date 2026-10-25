import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Clock, Hand, Handshake, PartyPopper, X } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { AvatarDecoration, ProfileEffect } from '../ProfileCosmetics';
import { ProfileBadgeStrip } from '../ProfileBadgeRow';
import {
    FriendsOnlyLock, LocalTimeText, PROFILE_CARD_BG, ProfileCardInterests, ProfileCardLinks, ProfileCardSteam,
    ProfileCardVerified, ProfileCardWidgets,
} from '../ProfileCardParts';
import { Banner } from '../Banner';
import { MutualsPanel } from './ProfileTabs';
import { AchievementsSheet, AchievementsSummary } from './AchievementsPanel';
import { MostPlayedPanel } from './MostPlayedPanel';
import { ProfileActivityRow } from './ProfileActivityRow';
import { ProfileIntegrationsSection } from './ProfileIntegrationsSection';
import * as IntegrationExtras from './ProfileIntegrationsExtras';
import { useEscape } from '../../hooks/useEscape';
import { useUserAchievements } from '../../hooks/useUserAchievements';
import { prefersReducedMotion } from '../../utils/prefersReducedMotion';
import { steamProfileUrl } from '../../utils/profileLinks';
import { openExternalLink } from '../../utils/openExternalLink';
import { matchTint, themeCardStyle, themeSurface } from '../../utils/profileTheme';
import { cardSections } from '../../utils/profileCardLayout';
import { formatFriendsSince, type ShowcaseBlock } from '../../utils/profileExtras';
import { formatLocalTime } from '../../utils/profileVisibility';
import type { PublicProfile } from '../../utils/profileCache';
import type { ProfileLink } from '../../utils/profileLinks';
import type { Mutuals } from '../../hooks/useProfileRelations';
import type { ProfileActivity, ProfileConnection } from './integrationTypes';
import type { ProfileCardData, ProfileFullTab } from './profileCardData';
import '../../styles/profile-card.css';
import '../../styles/profile-v3.css';
import '../../styles/profile-motion.css';

/**
 * The FULL profile: a large modal with everything. Opened from the preview
 * popover (its avatar, name, mutuals, highlight, or "Open profile").
 *
 *   header  banner, avatar + decoration, name #tag, badges, presence, actions
 *   tabs    Overview | Achievements | Mutual friends | Mutual servers | Integrations
 *   panel   scrolls on its own; the header never moves
 *
 * Overview is two columns: the owner's showcase in their order (main) and a
 * rail with what is happening now (activity), the facts, server context and
 * your private note. Below ~760px wide the rail drops under the main column.
 *
 * Keyboard: the tabs are a roving tablist (arrows, Home, End); Tab stays
 * inside the dialog; Escape closes it (through the shared escape stack, so
 * menus and the lightbox opened on top close first). The caller restores
 * focus to whatever opened the profile.
 */

export interface ProfileFullViewProps {
    userId: string;
    token: string;
    isSelf: boolean;
    data: ProfileCardData | null;
    /** The raw response, for the integrations seam (ProfileIntegrationsExtras). */
    profile: PublicProfile | null;
    avatarId: string | null;
    bannerId: string | null;
    bannerFriendsOnly?: boolean;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    presence?: React.ReactNode;
    activities?: readonly ProfileActivity[];
    connections?: readonly ProfileConnection[];
    avatarBadge?: React.ReactNode;
    onAvatarClick?: () => void;
    /** Header action buttons (Message / Add friend, High five, Edit profile, Share...). */
    actions?: React.ReactNode;
    /** The "more" menu trigger. */
    menu?: React.ReactNode;
    /** Rail extras: server nickname, roles. */
    extras?: React.ReactNode;
    /** Your private note about them (others only). */
    note?: React.ReactNode;
    mutuals?: Mutuals | null;
    initialTab?: ProfileFullTab;
    onClose: () => void;
    /** Closing animation in progress. */
    closing?: boolean;
    onOpenUser?: (userId: string, at: { x: number; y: number }) => void;
    onOpenServer?: (serverId: string) => void;
    renderServerIcon?: (serverId: string, name: string) => React.ReactNode;
    onOpenLink?: (l: ProfileLink) => void;
}

const TAB_LABEL: Record<ProfileFullTab, string> = {
    overview: 'Overview', achievements: 'Achievements', friends: 'Mutual friends', servers: 'Mutual servers', integrations: 'Integrations',
};

const hasExtras = (p: PublicProfile | null): boolean => {
    const f = (IntegrationExtras as { hasIntegrationExtras?: (p: PublicProfile) => boolean }).hasIntegrationExtras;
    return !!p && typeof f === 'function' && f(p);
};

/** Tab stays inside the dialog. */
function trapTab(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== 'Tab') return;
    const root = e.currentTarget;
    const els = [...root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((el) => !el.closest('[inert]') && el.offsetParent !== null);
    if (els.length === 0) return;
    const first = els[0], last = els[els.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === root)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
}

export const ProfileFullView: React.FC<ProfileFullViewProps> = ({
    userId, token, isSelf, data, profile, avatarId, bannerId, bannerFriendsOnly, loading, error, onRetry,
    presence, activities = [], connections = [], avatarBadge, onAvatarClick, actions, menu, extras, note, mutuals,
    initialTab = 'overview', onClose, closing, onOpenUser, onOpenServer, renderServerIcon, onOpenLink,
}) => {
    const ids = useId();
    const dialogRef = useRef<HTMLDivElement>(null);
    useEscape(onClose);

    // Focus goes into the dialog on open (the dialog itself, so the first Tab lands on its first control).
    useLayoutEffect(() => { dialogRef.current?.focus({ preventScroll: true }); }, []);

    const theme = data?.theme ?? null;
    const surface = theme ? themeSurface(theme) : null;
    const tint = matchTint(theme);

    const friendsN = mutuals?.friends.length ?? 0;
    const serversN = mutuals?.servers.length ?? 0;
    const achN = data?.achievementCount ?? 0;
    const tabs: ProfileFullTab[] = [
        'overview',
        ...((isSelf || achN > 0) ? ['achievements' as const] : []),
        ...(!isSelf ? ['friends' as const, 'servers' as const] : []),
        ...((isSelf || connections.length > 0 || hasExtras(profile)) ? ['integrations' as const] : []),
    ];
    const [pick, setTab] = useState<ProfileFullTab>(initialTab);
    const tab: ProfileFullTab = tabs.includes(pick) ? pick : 'overview';
    const count: Partial<Record<ProfileFullTab, number>> = {
        achievements: data ? achN : undefined, friends: mutuals ? friendsN : undefined, servers: mutuals ? serversN : undefined,
        integrations: connections.length || undefined,
    };
    const tabsRef = useRef<HTMLDivElement>(null);
    const onTabKey = (e: React.KeyboardEvent) => {
        const i = tabs.indexOf(tab);
        let j = i;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        else return;
        e.preventDefault();
        setTab(tabs[j]);
        tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
    };

    // The panel starts at the top whenever the tab changes.
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => { panelRef.current?.scrollTo?.({ top: 0 }); }, [tab]);

    // Achievements: the full list only when a tab shows it (or no picks to show on Overview).
    const picks = data?.topAchievements ?? [];
    const sections: ShowcaseBlock[] = data ? cardSections({
        blocks: data.blocks,
        has: {
            steam: !!data.steam, games: data.games.length > 0, links: data.links.length > 0, interests: data.interests.length > 0,
            achievements: isSelf || achN > 0, most_played: data.mostPlayed.length > 0,
        },
    }) : [];
    const wantAch = tab === 'achievements' || (tab === 'overview' && sections.includes('achievements') && picks.length === 0);
    const ach = useUserAchievements(wantAch ? userId : null, isSelf);

    const openSteam = (steamId: string) => {
        if (onOpenLink) onOpenLink({ platform: 'steam', handle: steamId });
        else openExternalLink(steamProfileUrl(steamId));
    };
    const sectionNode = (b: ShowcaseBlock): React.ReactNode => {
        if (!data) return null;
        switch (b) {
            case 'steam': return data.steam ? <ProfileCardSteam key={b} steam={data.steam} friendsOnly={data.linksFriendsOnly} onOpen={openSteam} /> : null;
            case 'games': return <ProfileCardWidgets key={b} widgets={{ games: [...data.games] }} friendsOnly={data.gamesFriendsOnly} />;
            case 'links': return <ProfileCardLinks key={b} links={data.links} friendsOnly={data.linksFriendsOnly} onOpen={onOpenLink} steam={data.steam ?? null} onOpenSteam={openSteam} />;
            case 'interests': return <ProfileCardInterests key={b} interests={data.interests} mine={isSelf ? null : data.myInterests ?? null} friendsOnly={data.interestsFriendsOnly} />;
            case 'achievements': return (
                <AchievementsSummary key={b} data={ach.data} count={data.achievementCount} picks={picks} isSelf={isSelf}
                    loading={ach.loading && !ach.data} onViewAll={() => setTab('achievements')} />
            );
            case 'most_played': return <MostPlayedPanel key={b} games={data.mostPlayed} />;
            default: return null;
        }
    };

    const localTime = !!data?.timeZone && formatLocalTime(data.timeZone) !== null;
    const friendsSince = formatFriendsSince(data?.friendsSince);
    const anniversary = data?.anniversaryYears ?? 0;
    const ownHighFives = isSelf ? data?.highFiveCount ?? 0 : 0;
    const hasFacts = localTime || !!friendsSince || anniversary > 0 || ownHighFives > 0;

    return (
        <>
            <div className="pfp-scrim" data-closing={closing ? 'true' : undefined} onClick={(e) => { e.stopPropagation(); onClose(); }} />
            <div className="pfp-frame" data-closing={closing ? 'true' : undefined}>
                <div
                    ref={dialogRef}
                    className="pfp"
                    role="dialog" aria-modal="true" aria-labelledby={`${ids}-name`}
                    tabIndex={-1}
                    style={themeCardStyle(theme)}
                    onKeyDown={trapTab}
                    onClick={(e) => e.stopPropagation()}
                    data-testid="profile-full"
                >
                    <ProfileEffect effect={data?.effect} tint={tint} options={data?.effectOptions} loop />
                    {anniversary > 0 && !prefersReducedMotion() && data?.effect !== 'confetti' && <ProfileEffect effect="confetti" />}

                    <header className="pfp-hero">
                        <div className="pfp-banner">
                            {bannerFriendsOnly && <span className="pcd-banner-lock"><FriendsOnlyLock /></span>}
                            <Banner
                                attachmentId={bannerId} fallbackAvatarAttachmentId={avatarId} fallbackUserId={userId} token={token}
                                height={176} fadeToColor={surface?.from ?? PROFILE_CARD_BG} bypassFriendGate animate
                            />
                        </div>
                        <button type="button" className="pfp-close" aria-label="Close profile" onClick={(e) => { e.stopPropagation(); onClose(); }} data-testid="profile-full-close">
                            <X size={18} aria-hidden="true" />
                        </button>
                        <div className="pfp-idrow">
                            <div className="pfp-avatar">
                                <AvatarDecoration decoration={data?.decoration} block tint={tint} options={data?.decorationOptions}>
                                    <button
                                        type="button" className="pfp-avatar-btn" data-zoom={onAvatarClick ? 'true' : undefined}
                                        tabIndex={onAvatarClick ? 0 : -1} aria-label={onAvatarClick ? `View ${data?.name || 'avatar'} full size` : `${data?.name || 'User'} avatar`}
                                        onClick={(e) => { e.stopPropagation(); onAvatarClick?.(); }}
                                    >
                                        <EncryptedAvatar attachmentId={avatarId} userId={userId} token={token} className="w-full h-full" fallbackSize={48} disableClickProfile bypassFriendGate animate />
                                    </button>
                                    {avatarBadge}
                                </AvatarDecoration>
                            </div>
                            <div className="pfp-ident">
                                <h2 className="pfp-name" id={`${ids}-name`}>
                                    {data?.name ?? (loading ? '' : 'Profile')}
                                    {data && data.discriminator !== null && data.discriminator !== undefined && (
                                        <span className="ppo-tag" aria-label={`tag ${padDiscriminator(data.discriminator)}`}>#{padDiscriminator(data.discriminator)}</span>
                                    )}
                                </h2>
                                {data && (
                                    <ProfileBadgeStrip
                                        className="pfp-badges" badges={data.badges} isPro={data.isPro} proSince={data.proSince} level={data.level}
                                        onLevel={() => setTab('achievements')}
                                        steam={data.steam ? { label: data.steam.personaName ?? 'Steam account', onOpen: () => setTab(tabs.includes('integrations') ? 'integrations' : 'overview') } : null}
                                    />
                                )}
                                {presence && <div className="pfp-presence">{presence}</div>}
                            </div>
                            {(actions || menu) && data && (
                                <div className="pfp-actions">{actions}{menu}</div>
                            )}
                        </div>
                    </header>

                    {!data ? (
                        loading ? (
                            <div className="pfp-loading animate-pulse" role="status" aria-label="Loading profile"><i /><i /><i /></div>
                        ) : (
                            <div className="pcd-error" role="alert">
                                <p>{error || 'Could not load profile.'}</p>
                                {onRetry && <button type="button" className="pcd-link-btn" onClick={(e) => { e.stopPropagation(); onRetry(); }}>Try again</button>}
                            </div>
                        )
                    ) : (
                        <>
                            <div ref={tabsRef} className="pfp-tabs" role="tablist" aria-label="Profile sections" onKeyDown={onTabKey}>
                                {tabs.map((t) => (
                                    <button
                                        key={t} type="button" role="tab" id={`${ids}-tab-${t}`} aria-selected={tab === t} aria-controls={`${ids}-panel`}
                                        tabIndex={tab === t ? 0 : -1} className="pfp-tab" data-testid={`profile-full-tab-${t}`}
                                        onClick={(e) => { e.stopPropagation(); setTab(t); }}
                                    >
                                        {TAB_LABEL[t]}
                                        {count[t] !== undefined && <span className="pfp-tab-n">{count[t]}</span>}
                                    </button>
                                ))}
                            </div>

                            <div ref={panelRef} className="pfp-panel custom-scrollbar" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-tab-${tab}`} data-tab={tab} data-testid={`profile-full-panel-${tab}`}>
                                {tab === 'overview' && (
                                    <div className="pfp-overview">
                                        <div className="pfp-main">
                                            {data.bio && data.bio.trim() ? (
                                                <section className="pfp-about">
                                                    <h3 className="pcd-sec-title">About me {data.bioFriendsOnly && <FriendsOnlyLock className="pcd-lock" />}</h3>
                                                    <p className="pfp-bio" data-testid="profile-bio">{data.bio}</p>
                                                </section>
                                            ) : null}
                                            {sections.map(sectionNode)}
                                            {!data.bio?.trim() && sections.length === 0 && (
                                                <p className="pfp-empty">{isSelf ? 'Your showcase is empty. Add games, links and achievements in Settings > Profile.' : 'Nothing in this showcase yet.'}</p>
                                            )}
                                        </div>
                                        <aside className="pfp-rail" aria-label="Details">
                                            {activities.length > 0 && (
                                                <section className="pfp-panel-card">
                                                    <h3 className="pcd-sec-title">Right now</h3>
                                                    <ProfileActivityRow activities={activities} variant="full" />
                                                </section>
                                            )}
                                            {hasFacts && (
                                                <section className="pfp-panel-card">
                                                    <ul className="pfp-facts" aria-label="About">
                                                        {localTime && (
                                                            <li data-field="local_time"><Clock size={14} aria-hidden="true" /><span><LocalTimeText timeZone={data.timeZone!} /></span>
                                                                {data.localTimeFriendsOnly && <FriendsOnlyLock className="pcd-lock" />}</li>
                                                        )}
                                                        {friendsSince && <li data-testid="friends-since"><Handshake size={14} aria-hidden="true" /><span>Friends since {friendsSince}</span></li>}
                                                        {anniversary > 0 && <li className="pcd-anniv"><PartyPopper size={14} aria-hidden="true" /><span>{anniversary === 1 ? 'One year' : `${anniversary} years`} of friendship today</span></li>}
                                                        {ownHighFives > 0 && <li><Hand size={14} aria-hidden="true" /><span>{ownHighFives} high-five{ownHighFives === 1 ? '' : 's'} received</span></li>}
                                                    </ul>
                                                </section>
                                            )}
                                            {extras}
                                            {note && <section className="pfp-panel-card">{note}</section>}
                                            {data.verified && <ProfileCardVerified />}
                                        </aside>
                                    </div>
                                )}
                                {tab === 'achievements' && (
                                    <AchievementsSheet data={ach.data} loading={ach.loading} error={ach.error} isSelf={isSelf} onRetry={ach.reload} />
                                )}
                                {(tab === 'friends' || tab === 'servers') && (
                                    mutuals && (tab === 'friends' ? friendsN : serversN) > 0 ? (
                                        <MutualsPanel idBase={`${ids}-m`} kind={tab} mutuals={mutuals} token={token} embedded
                                            onOpenUser={onOpenUser} onOpenServer={onOpenServer} renderServerIcon={renderServerIcon} />
                                    ) : (
                                        <p className="pfp-empty">{!mutuals ? 'Loading…' : tab === 'friends' ? 'No mutual friends yet.' : 'No servers in common yet.'}</p>
                                    )
                                )}
                                {tab === 'integrations' && (
                                    <ProfileIntegrationsSection connections={connections} isSelf={isSelf} onBeforeOpenSettings={onClose}>
                                        {profile && <IntegrationExtras.ProfileIntegrationsExtras userId={userId} isSelf={isSelf} profile={profile} token={token} />}
                                    </ProfileIntegrationsSection>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </>
    );
};

export default ProfileFullView;
