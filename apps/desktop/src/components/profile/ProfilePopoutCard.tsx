import React, { useEffect, useState } from 'react';
import { Clock, PartyPopper, Hand, Maximize2 } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { EncryptedAvatar } from '../EncryptedAvatar';
import { AvatarDecoration, ProfileEffect } from '../ProfileCosmetics';
import { ProfileBadgeStrip } from '../ProfileBadgeRow';
import { FriendsOnlyLock, LocalTimeText, PROFILE_CARD_BG } from '../ProfileCardParts';
import { Banner } from '../Banner';
import { ProfileActivityRow } from './ProfileActivityRow';
import { AchievementMedallion } from './AchievementsPanel';
import { prefersReducedMotion } from '../../utils/prefersReducedMotion';
import { matchTint, themeCardStyle, themeSurface } from '../../utils/profileTheme';
import { featuredAchievements } from '../../utils/profileCardLayout';
import { interestLabel, sharedInterests } from '../../utils/profileExtras';
import { formatLocalTime } from '../../utils/profileVisibility';
import type { Mutuals } from '../../hooks/useProfileRelations';
import type { ProfileActivity } from './integrationTypes';
import type { ProfileCardData, ProfileFullTab } from './profileCardData';
import '../../styles/profile-card.css';
import '../../styles/profile-v3.css';
import '../../styles/profile-motion.css';

/**
 * The profile PREVIEW: what opens when you click someone's name or avatar.
 * Quick and fun, never long: who they are (banner, avatar + decoration,
 * effect, name, badges), what they are doing (presence, custom status, the
 * activity row), a three-line bio, the facts, the mutuals and ONE highlight
 * from their showcase. Everything else lives on the full profile
 * (ProfileFullView), one click away: the avatar, the name, the mutuals line,
 * the highlight and the "Open profile" button all lead there.
 *
 * Sized to fit a small window by design (~450px tall for a full profile);
 * the popover frame (ProfileModal) only scrolls it as a last resort.
 *
 * The SAME card is the Settings > Profile preview, so what you edit is what
 * people see when they click you.
 */

export interface ProfilePopoutCardProps {
    userId: string;
    token: string;
    isSelf: boolean;
    data: ProfileCardData | null;
    avatarId: string | null;
    bannerId: string | null;
    /** A local (blob:) banner preview instead of the attachment (Settings drafts). */
    bannerSrc?: string | null;
    bannerFriendsOnly?: boolean;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    /** Presence and custom status lines. */
    presence?: React.ReactNode;
    activities?: readonly ProfileActivity[];
    avatarBadge?: React.ReactNode;
    avatarLabel?: string;
    /** Top-right over the banner (the "more" menu). */
    menu?: React.ReactNode;
    /** The action row. */
    actions?: React.ReactNode;
    /** The actions are only a picture (Settings preview): not focusable, hidden from assistive tech. */
    actionsInert?: boolean;
    /** Server context (roles, nickname). */
    extras?: React.ReactNode;
    mutuals?: Mutuals | null;
    /** Open the full profile (on a tab). Omit for a card that cannot (the Settings preview passes its own). */
    onOpenFull?: (tab?: ProfileFullTab) => void;
    /** Effects keep playing while the window is in front (default). */
    loop?: boolean;
    label?: string;
    className?: string;
    style?: React.CSSProperties;
    testId?: string;
}

/** How long the entrance takes; `data-enter` is dropped after it so nothing replays. */
export const POPOUT_ENTER_MS = 900;

/** One highlight from the owner's showcase, in their order: achievements > games > interests > most played. */
function pickHighlight(d: ProfileCardData): 'achievements' | 'games' | 'interests' | 'most_played' | null {
    for (const b of d.blocks) {
        if (b === 'achievements' && d.topAchievements.length > 0) return b;
        if (b === 'games' && d.games.length > 0) return b;
        if (b === 'interests' && d.interests.length > 0) return b;
        if (b === 'most_played' && d.mostPlayed.length > 0) return b;
    }
    return null;
}

const hours = (m: number) => (m >= 60 ? `${Math.round(m / 60)} h` : `${m} min`);

export const ProfilePopoutCard: React.FC<ProfilePopoutCardProps> = ({
    userId, token, isSelf, data, avatarId, bannerId, bannerSrc, bannerFriendsOnly, loading, error, onRetry,
    presence, activities = [], avatarBadge, avatarLabel, menu, actions, actionsInert, extras, mutuals, onOpenFull,
    loop = true, label, className, style, testId,
}) => {
    const [entering, setEntering] = useState(() => !prefersReducedMotion());
    const hasData = !!data;
    useEffect(() => {
        if (!entering || !hasData) return;
        const t = window.setTimeout(() => setEntering(false), POPOUT_ENTER_MS);
        return () => window.clearTimeout(t);
    }, [entering, hasData]);

    const theme = data?.theme ?? null;
    const surface = theme ? themeSurface(theme) : null;
    const tint = matchTint(theme);
    const localTime = !!data?.timeZone && formatLocalTime(data.timeZone) !== null;
    const anniversary = data?.anniversaryYears ?? 0;
    const ownHighFives = isSelf ? data?.highFiveCount ?? 0 : 0;
    const friendsN = !isSelf ? mutuals?.friends.length ?? 0 : 0;
    const serversN = !isSelf ? mutuals?.servers.length ?? 0 : 0;
    const highlight = data ? pickHighlight(data) : null;
    const open = (tab?: ProfileFullTab) => (e: React.MouseEvent) => { e.stopPropagation(); onOpenFull?.(tab); };

    let i = 0;
    const next = () => ({ ['--i' as string]: i++ } as React.CSSProperties);

    return (
        <div
            className={`ppo${className ? ` ${className}` : ''}`}
            data-enter={entering ? 'true' : undefined}
            style={{ ...(themeCardStyle(theme) ?? {}), ...style }}
            aria-label={label}
            data-testid={testId}
        >
            <ProfileEffect effect={data?.effect} tint={tint} options={data?.effectOptions} loop={loop} />
            {anniversary > 0 && !prefersReducedMotion() && data?.effect !== 'confetti' && <ProfileEffect effect="confetti" />}

            <div className="ppo-banner" data-hx-layer="banner">
                {bannerFriendsOnly && <span className="pcd-banner-lock"><FriendsOnlyLock /></span>}
                <Banner
                    attachmentId={bannerSrc ? null : bannerId}
                    fallbackAvatarAttachmentId={avatarId}
                    fallbackUserId={userId}
                    token={token}
                    height={96}
                    fadeToColor={surface?.from ?? PROFILE_CARD_BG}
                    bypassFriendGate
                    animate
                    src={bannerSrc}
                />
            </div>
            {menu && <div className="ppo-menu">{menu}</div>}

            <div className="ppo-head">
                <div className="ppo-avatar" data-hx-layer="avatar">
                    <AvatarDecoration decoration={data?.decoration} block tint={tint} options={data?.decorationOptions}>
                        <button
                            type="button" className="ppo-avatar-btn"
                            aria-label={avatarLabel ?? (onOpenFull ? `Open ${data?.name || 'this'}'s full profile` : 'Avatar')}
                            tabIndex={onOpenFull ? 0 : -1}
                            data-open={onOpenFull ? 'true' : undefined}
                            onClick={onOpenFull ? open('overview') : (e) => e.stopPropagation()}
                        >
                            {!data && loading && !avatarId
                                ? <span className="block bg-white/5 animate-pulse" />
                                : <EncryptedAvatar attachmentId={avatarId} userId={userId} token={token} className="w-full h-full" fallbackSize={32} disableClickProfile bypassFriendGate animate />}
                        </button>
                        {avatarBadge}
                    </AvatarDecoration>
                </div>
                {data && (
                    <ProfileBadgeStrip
                        className="ppo-badges" badges={data.badges} isPro={data.isPro} proSince={data.proSince} level={data.level}
                        onLevel={onOpenFull ? () => onOpenFull('achievements') : undefined}
                        steam={data.steam ? { label: data.steam.personaName ?? 'Steam account', onOpen: () => onOpenFull?.('integrations') } : null}
                    />
                )}
            </div>

            {!data ? (
                loading ? (
                    <div className="ppo-skel animate-pulse" role="status" aria-label="Loading profile">
                        <i style={{ width: 132, height: 18 }} /><i style={{ width: 84 }} /><i style={{ width: 220, marginTop: 10 }} /><i style={{ width: 180 }} />
                    </div>
                ) : (
                    <div className="pcd-error" role="alert">
                        <p>{error || 'Could not load profile.'}</p>
                        {onRetry && <button type="button" className="pcd-link-btn" onClick={(e) => { e.stopPropagation(); onRetry(); }}>Try again</button>}
                    </div>
                )
            ) : (
                <div className="ppo-body">
                    <div className="ppo-id" style={next()}>
                        <h2 className="ppo-name">
                            {onOpenFull ? (
                                <button type="button" className="ppo-name-btn" onClick={open('overview')} title="Open full profile">{data.name}</button>
                            ) : data.name}
                            {data.discriminator !== null && data.discriminator !== undefined && (
                                <span className="ppo-tag" aria-label={`tag ${padDiscriminator(data.discriminator)}`}>#{padDiscriminator(data.discriminator)}</span>
                            )}
                        </h2>
                    </div>

                    {presence && <div className="ppo-presence" style={next()}>{presence}</div>}
                    {activities.length > 0 && <div style={next()}><ProfileActivityRow activities={activities} variant="compact" /></div>}

                    {data.bio && data.bio.trim() && (
                        <p className="ppo-bio" style={next()} data-testid="profile-bio">
                            {data.bioFriendsOnly && <><FriendsOnlyLock className="pcd-lock" />{' '}</>}{data.bio}
                        </p>
                    )}

                    {(localTime || anniversary > 0 || ownHighFives > 0) && (
                        <ul className="ppo-facts" style={next()} aria-label="About">
                            {localTime && (
                                <li data-field="local_time">
                                    <Clock size={13} aria-hidden="true" /><LocalTimeText timeZone={data.timeZone!} />
                                    {data.localTimeFriendsOnly && <FriendsOnlyLock className="pcd-lock" />}
                                </li>
                            )}
                            {anniversary > 0 && (
                                <li className="pcd-anniv" data-testid="anniversary"><PartyPopper size={13} aria-hidden="true" />{anniversary === 1 ? 'One year' : `${anniversary} years`} of friendship today</li>
                            )}
                            {ownHighFives > 0 && <li data-testid="high-five-count"><Hand size={13} aria-hidden="true" />{ownHighFives} high-five{ownHighFives === 1 ? '' : 's'}</li>}
                        </ul>
                    )}

                    {(friendsN > 0 || serversN > 0) && (
                        <button type="button" className="ppo-mutuals" style={next()} data-testid="profile-mutuals"
                            onClick={open(friendsN > 0 ? 'friends' : 'servers')} disabled={!onOpenFull}>
                            {friendsN > 0 && (
                                <span className="ppo-pile" aria-hidden="true">
                                    {mutuals!.friends.slice(0, 3).map((f) => (
                                        <span key={f.user_id}><EncryptedAvatar attachmentId={f.avatar_url} userId={f.user_id} token={token} className="w-full h-full" fallbackSize={12} disableClickProfile bypassFriendGate /></span>
                                    ))}
                                </span>
                            )}
                            <span>
                                {[friendsN > 0 && `${friendsN} mutual friend${friendsN === 1 ? '' : 's'}`, serversN > 0 && `${serversN} mutual server${serversN === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
                            </span>
                        </button>
                    )}

                    {highlight && (
                        <Highlight data={data} kind={highlight} isSelf={isSelf} style={next()} onOpen={onOpenFull ? open(highlight === 'achievements' ? 'achievements' : 'overview') : undefined} />
                    )}

                    {extras}
                </div>
            )}

            {actions && data && (
                <div className="ppo-actions" inert={actionsInert || undefined} aria-hidden={actionsInert || undefined}>
                    {actions}
                </div>
            )}
        </div>
    );
};

/** One showcase item, compact (one line). Pressing it opens the full profile there. */
const Highlight: React.FC<{
    data: ProfileCardData;
    kind: 'achievements' | 'games' | 'interests' | 'most_played';
    isSelf: boolean;
    style: React.CSSProperties;
    onOpen?: (e: React.MouseEvent) => void;
}> = ({ data, kind, isSelf, style, onOpen }) => {
    let title = '';
    let body: React.ReactNode = null;
    if (kind === 'achievements') {
        const defs = featuredAchievements(null, data.topAchievements);
        title = 'Achievements';
        body = (
            <span className="ppo-hl-medals">
                {defs.map((d) => <span key={d.id} title={d.name}><AchievementMedallion def={d} unlocked size={26} /></span>)}
                <span className="ppo-hl-meta">{data.achievementCount ?? defs.length} unlocked</span>
            </span>
        );
    } else if (kind === 'games' || kind === 'interests') {
        const items = kind === 'games' ? data.games : data.interests;
        const shared = kind === 'interests' && !isSelf ? new Set(sharedInterests(data.myInterests ?? [], data.interests)) : new Set<string>();
        title = kind === 'games' ? 'Games' : 'Into';
        body = (
            <span className="ppo-hl-chips">
                {items.slice(0, 2).map((g) => (
                    <span key={g} className="ppo-chip" data-shared={shared.has(g) ? 'true' : undefined}>{kind === 'interests' ? interestLabel(g) : g}</span>
                ))}
                {items.length > 2 && <span className="ppo-hl-meta">+{items.length - 2}</span>}
            </span>
        );
    } else {
        const top = data.mostPlayed[0];
        title = 'Most played this week';
        body = <span className="ppo-hl-line"><b>{top.game}</b><span className="ppo-hl-meta">{hours(top.minutes)}</span></span>;
    }
    const inner = (
        <>
            <span className="ppo-hl-title">{title}</span>
            {body}
        </>
    );
    return onOpen
        ? <button type="button" className="ppo-hl" style={style} onClick={onOpen} data-testid={`profile-highlight-${kind}`}>{inner}</button>
        : <div className="ppo-hl" style={style} data-testid={`profile-highlight-${kind}`}>{inner}</div>;
};

/** The "Open profile" icon button for the action row. */
export const OpenProfileButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
    <button type="button" className="ppo-open" onClick={(e) => { e.stopPropagation(); onClick(); }} aria-label="Open full profile" title="Open full profile" data-testid="open-full-profile">
        <Maximize2 size={15} aria-hidden="true" />
    </button>
);

export default ProfilePopoutCard;
