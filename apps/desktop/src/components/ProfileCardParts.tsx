import React, { useEffect, useState } from 'react';
import { BadgeCheck, Lock, ShieldCheck } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { Banner } from './Banner';
import { ProfileBadgeRow } from './ProfileBadgeRow';
import { ProPill } from './ProPill';
import type { ProfileBadge } from '../utils/profileBadges';
import { AvatarDecoration } from './ProfileCosmetics';
import { useClTooltip } from './cl/useClTooltip';
import { ProfileLinkIcon } from './ProfileLinkIcon';
import {
    displayHandle, openProfileLink, platformLabel, profileLinkUrl, sanitizeLinks, type ProfileLink,
} from '../utils/profileLinks';
import type { ProfileWidgets } from '../utils/profileCosmetics';
import { formatLocalTime, isFriendsOnly } from '../utils/profileVisibility';
import { interestLabel, youBothLikeLine } from '../utils/profileExtras';
import { splitFold } from '../utils/profileCardLayout';
import '../styles/profile-extras.css';
import '../styles/profile-card.css';

/**
 * The profile card's presentational pieces.
 *
 *  - Header parts (banner, avatar, name row, status line, about, footer) are
 *    shared with the onboarding profile step's live 3D preview
 *    (onboarding/ProfileCardPreview), which uses the `className` props to put
 *    each layer at its own depth. The real card (profile/ProfileCard.tsx)
 *    composes its own header from the banner + avatar parts.
 *  - Body sections (eggs, games, links, interests, verified, the fold) are the
 *    card's About column, drawn by profile/ProfileCard.tsx for both the
 *    popover (ProfileModal) and the Settings preview.
 *
 * Behaviour (fetching, menus, lightbox, nickname editing) stays in ProfileModal.
 */

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** The card's own navy (`bg-cl-deep`), which the banner fades into and the
 *  avatar / status-dot rings are cut from. */
export const PROFILE_CARD_BG = '#131A30';
export const PROFILE_CARD_WIDTH = 360;
/** The card frame (without positioning / scrolling, which are the popover's). */
export const PROFILE_CARD_FRAME_CLASS = 'bg-cl-deep border border-cl-border rounded-[20px] shadow-[0_24px_64px_rgba(0,0,0,0.6)]';
/** The info block under the avatar. */
export const PROFILE_CARD_INFO_CLASS = 'px-5 pt-3 pb-4 flex flex-col';
/** The centred identity column (name row, status, game, custom status). */
export const PROFILE_CARD_IDENTITY_CLASS = 'flex flex-col items-center text-center';

/** Mono uppercase section label — same vocabulary as the settings zone labels. */
export const ProfileCardEyebrow: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p
        className="text-[10px] font-semibold uppercase text-cl-faint m-0 mb-1.5"
        style={{ fontFamily: 'var(--cl-font-mono)', letterSpacing: '1.2px' }}
    >
        {children}
    </p>
);

/** Banner — rounded top corners (matching the card's 20px), fades into card bg at the bottom. */
export const ProfileCardBanner: React.FC<{
    attachmentId: string | null;
    fallbackAvatarAttachmentId?: string | null;
    userId: string;
    token: string;
    /** A local preview (blob: URL) shown instead of the attachment — the onboarding preview's not-yet-uploaded pick. */
    src?: string | null;
    /** The owner restricted the banner to friends: show the lock. */
    friendsOnly?: boolean;
    /** Animated banners play (the card does; default is the first frame). */
    animate?: boolean;
    /** What the banner fades into (the themed card's top colour). */
    fadeColor?: string;
}> = ({ attachmentId, fallbackAvatarAttachmentId = null, userId, token, src, friendsOnly, animate, fadeColor }) => (
    <div className="relative rounded-t-[20px] overflow-hidden" data-hx-layer="banner">
        {friendsOnly && <FriendsOnlyLock className="absolute top-2.5 left-2.5 z-10 rounded-full bg-black/40 p-1" />}
        <Banner
            attachmentId={attachmentId}
            fallbackAvatarAttachmentId={fallbackAvatarAttachmentId}
            fallbackUserId={userId}
            token={token}
            height={120}
            fadeToColor={fadeColor ?? PROFILE_CARD_BG}
            bypassFriendGate
            animate={animate}
            src={src}
        />
    </div>
);

/**
 * Avatar — overlaps banner, horizontally centered, status badge in corner.
 * -mt-6 (24px) overlaps only a quarter of the avatar for a more "dropped" look.
 * A plain button, NOT a ClButton: the kit button's visible face is its inner
 * .cap (fixed icon-button size), so sizing classes on the wrapper produce a
 * big empty ring with a tiny avatar floating inside it.
 */
export const ProfileCardAvatar: React.FC<{
    ariaLabel: string;
    title?: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Cursor / hover classes for the button (they depend on what a click does). */
    interactionClassName: string;
    /** The face (EncryptedAvatar, a skeleton, a local preview) plus any overlay. */
    children: React.ReactNode;
    /** The status badge (dot or mobile glyph), positioned against the avatar. */
    badge?: React.ReactNode;
    className?: string;
    /** Avatar decoration id (utils/profileCosmetics.ts); unknown / null = none. */
    decoration?: string | null;
    /** "Match theme" colour for the free ring decorations (utils/profileTheme.matchTint). */
    decorationTint?: string | null;
}> = ({ ariaLabel, title, onClick, interactionClassName, children, badge, className, decoration, decorationTint }) => (
    <div className={cx('px-5 -mt-6 flex justify-center', className)} data-hx-layer="avatar">
        <AvatarDecoration decoration={decoration} block tint={decorationTint}>
            <button
                type="button"
                aria-label={ariaLabel}
                title={title}
                onClick={onClick}
                className={`block w-24 h-24 rounded-full ring-4 ring-[color:var(--pc-ring,#131A30)] overflow-hidden bg-cl-raise p-0 border-none transition-transform duration-200 ${interactionClassName}`}
            >
                {children}
            </button>
            {badge}
        </AvatarDecoration>
    </div>
);

/** Status badge — bottom-right of the avatar, ringed to separate from the avatar face. */
export const ProfileCardStatusDot: React.FC<{ color: string; title: string }> = ({ color, title }) => (
    <span
        className="absolute z-[3] w-5 h-5 rounded-full ring-[3px] ring-[color:var(--pc-ring,#131A30)]"
        style={{ backgroundColor: color, right: 2, bottom: 2 }}
        title={title}
    />
);

/** Name, the #tag pill, the Pro pill and admin badges. */
export const ProfileCardNameRow: React.FC<{
    name: React.ReactNode;
    discriminator: number | null | undefined;
    isPro?: boolean;
    /** Month ("YYYY-MM") the Pro period began; adds the hover/focus tip. */
    proSince?: string | null;
    badges?: ProfileBadge[];
    /** Profile level (utils/profileExtras.ts); shown as a small pill from level 1. */
    level?: number;
    className?: string;
}> = ({ name, discriminator, isPro, proSince, badges, level, className }) => (
    <div className={cx('flex items-center gap-2 flex-wrap justify-center', className)}>
        <h2
            className="text-[21px] font-semibold text-cl-text leading-tight m-0"
            style={{ fontFamily: 'var(--cl-font-display)' }}
        >
            {name}
        </h2>
        {discriminator !== null && discriminator !== undefined && (
            <span
                className="text-[11px] font-semibold text-cl-muted bg-cl-surface border border-cl-border px-2 py-0.5 rounded-full"
                style={{ fontFamily: 'var(--cl-font-mono)', letterSpacing: '0.5px' }}
            >
                #{padDiscriminator(discriminator)}
            </span>
        )}
        {isPro && <ProPill proSince={proSince} />}
        {!!level && level > 0 && (
            <span className="pe-level" title={`Profile level ${level}`} aria-label={`Profile level ${level}`} data-testid="profile-level">Lv {level}</span>
        )}
        <ProfileBadgeRow badges={badges} />
    </div>
);

/** Status label / last seen — the row under the name. */
export const ProfileCardStatusLine: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
    <div className={cx('flex items-center gap-1.5 mt-1.5 justify-center', className)}>
        {children}
    </div>
);

/** The live-status dot + label inside ProfileCardStatusLine. */
export const ProfileCardStatusLabel: React.FC<{ color: string; label: string }> = ({ color, label }) => (
    <>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden="true" />
        <span className="text-[12px] font-semibold" style={{ color }}>{label}</span>
    </>
);

/** Hairline between identity and the detail sections. */
export const ProfileCardHairline: React.FC = () => (
    <div className="h-px bg-cl-border/50 mt-4 mb-3.5" aria-hidden="true" />
);

/** Small lock + "Friends only" tooltip, for fields the owner restricted.
 *  Focusable so the tooltip (native title) and the label reach keyboard and
 *  screen-reader users too. */
export const FriendsOnlyLock: React.FC<{ className?: string }> = ({ className }) => (
    <span
        className={cx('inline-flex items-center text-cl-faint', className)}
        title="Friends only"
        aria-label="Friends only"
        role="img"
        tabIndex={0}
        data-friends-only="true"
    >
        <Lock size={11} aria-hidden="true" />
    </span>
);

/** "3:42 PM local time", recomputed on-device every 30 s. */
export const LocalTimeText: React.FC<{ timeZone: string }> = ({ timeZone }) => {
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const t = window.setInterval(() => setNow(new Date()), 30_000);
        return () => window.clearInterval(t);
    }, []);
    return <>{formatLocalTime(timeZone, now)}</>;
};

/**
 * Local time line. Omitted when the value is absent (unset, or hidden from the
 * viewer by the server) and carries the lock when `friendsOnlyFields` lists it.
 */
export const ProfileCardFacts: React.FC<{
    timeZone?: string | null;
    friendsOnlyFields?: readonly string[] | null;
    className?: string;
}> = ({ timeZone, friendsOnlyFields, className }) => {
    const showTime = !!timeZone && formatLocalTime(timeZone) !== null;
    if (!showTime) return null;
    return (
        <div className={cx('flex items-center justify-center gap-x-3 gap-y-0.5 flex-wrap mt-1.5 text-[12px] text-cl-muted', className)}>
            <span className="inline-flex items-center gap-1" data-field="local_time">
                <LocalTimeText timeZone={timeZone!} />
                {isFriendsOnly(friendsOnlyFields, 'local_time') && <FriendsOnlyLock />}
            </span>
        </div>
    );
};

/** Bio — the ABOUT section. */
export const ProfileCardAbout: React.FC<{ bio: string; className?: string; friendsOnly?: boolean }> = ({ bio, className, friendsOnly }) => (
    <div className={className}>
        <ProfileCardEyebrow>
            About{friendsOnly && <FriendsOnlyLock className="ml-1.5 align-[-1px]" />}
        </ProfileCardEyebrow>
        <p className="text-[13px] text-cl-muted leading-relaxed whitespace-pre-wrap break-words m-0">
            {bio}
        </p>
    </div>
);

/** Bottom action — full-width. */
export const ProfileCardFooter: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
    <div className={cx('px-5 pb-5 space-y-2', className)}>
        {children}
    </div>
);

// ── body sections (the card's About column) ──────────────────────────────────
//
// Every section is the same shape: a small sentence-case heading (with the
// friends-only lock when the owner restricted it) over its content, on the
// card's one 18px rhythm (styles/profile-card.css). Chips are rounded
// rectangles; badges and achievements are round, so the two never blur.

/** Heading + content. `aside` sits at the right of the heading (a count, a button). */
export const ProfileCardSection: React.FC<{
    title: React.ReactNode;
    icon?: React.ReactNode;
    friendsOnly?: boolean;
    aside?: React.ReactNode;
    testId?: string;
    className?: string;
    children: React.ReactNode;
}> = ({ title, icon, friendsOnly, aside, testId, className, children }) => {
    const id = React.useId();
    return (
        <section className={cx('pcd-sec', className)} aria-labelledby={id} data-testid={testId}>
            <div className="pcd-sec-head">
                <h3 className="pcd-sec-title" id={id}>
                    {icon}{title}{friendsOnly && <FriendsOnlyLock className="pcd-lock" />}
                </h3>
                {aside}
            </div>
            {children}
        </section>
    );
};

const EGG_HUES = ['#25E0C8', '#5E8EE0', '#FFC94D', '#FF8FB1', '#4ADE80', '#FF6B5E'];
const eggHue = (id: string) => EGG_HUES[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % EGG_HUES.length];

/** A small egg glyph tinted from the egg's id (stable per egg). */
export const EggGlyph: React.FC<{ id: string; size?: number }> = ({ id, size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 2C7 2 4 9 4 14a8 8 0 0 0 16 0C20 9 17 2 12 2z" fill={eggHue(id)} />
        <path d="M8.5 13.5c0-3 1.2-6 3.5-8" fill="none" stroke="#fff" strokeOpacity=".55" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
);

// The "Eggs found" section was retired 2026-10-24: naming the eggs someone
// found gave away what the eggs are. The Egg hunter badge keeps the count.

/** Favourite games. Renders nothing when there is nothing to show. */
export const ProfileCardWidgets: React.FC<{
    widgets: ProfileWidgets | null | undefined;
    friendsOnly?: boolean;
    className?: string;
}> = ({ widgets, friendsOnly, className }) => {
    if (!widgets || widgets.games.length === 0) return null;
    return (
        <ProfileCardSection title="Favorite games" friendsOnly={friendsOnly} className={className} testId="profile-widgets">
            <ul className="pcd-chips">
                {widgets.games.map((g) => <li key={g} className="pcd-chip"><span>{g}</span></li>)}
            </ul>
        </ProfileCardSection>
    );
};

/** One link chip: platform glyph + handle. Opens through the validated external-link path. */
const ProfileLinkChip: React.FC<{ link: ProfileLink; onOpen: (l: ProfileLink) => void }> = ({ link, onOpen }) => {
    const label = platformLabel(link.platform);
    const openable = profileLinkUrl(link) !== null;
    const tip = openable
        ? `${label}: opens in your browser. Unverified: Cipherline does not check that this account is theirs.`
        : `${label} username. Unverified: Cipherline does not check that this account is theirs.`;
    const { anchorProps, tooltip, describedBy } = useClTooltip(tip, { wide: true });
    const { ref: tipRef, ...tipHandlers } = anchorProps;
    const inner = (<><ProfileLinkIcon platform={link.platform} size={14} /><span>{displayHandle(link)}</span></>);
    return (
        <li className="m-0 p-0 max-w-full">
            {openable ? (
                <button
                    type="button" ref={tipRef as React.Ref<HTMLButtonElement>} {...tipHandlers}
                    className="pcd-chip pcd-chip--icon" aria-label={`${label}: ${displayHandle(link)}. Unverified. Opens in your browser.`}
                    aria-describedby={describedBy} data-platform={link.platform}
                    onClick={(e) => { e.stopPropagation(); onOpen(link); }}
                >{inner}</button>
            ) : (
                <span
                    ref={tipRef as React.Ref<HTMLSpanElement>} {...tipHandlers} tabIndex={0}
                    className="pcd-chip pcd-chip--icon" aria-label={`${label}: ${displayHandle(link)}. Unverified.`}
                    aria-describedby={describedBy} data-platform={link.platform}
                >{inner}</span>
            )}
            {tooltip}
        </li>
    );
};

/** The verified Steam chip: Steam proved this account is theirs (Steam OpenID). */
const VerifiedSteamChip: React.FC<{ steam: VerifiedSteam; onOpen: (steamId: string) => void }> = ({ steam, onOpen }) => {
    const name = steam.personaName ?? 'Steam account';
    const { anchorProps, tooltip, describedBy } = useClTooltip(`Steam, verified: Steam confirmed this account is theirs. Opens in your browser.`, { wide: true });
    const { ref: tipRef, ...tipHandlers } = anchorProps;
    return (
        <li className="m-0 p-0 max-w-full">
            <button
                type="button" ref={tipRef as React.Ref<HTMLButtonElement>} {...tipHandlers}
                className="pcd-chip pcd-chip--icon pcd-chip--verified" aria-label={`Steam: ${name}. Verified. Opens in your browser.`}
                aria-describedby={describedBy} data-platform="steam" data-verified="true"
                onClick={(e) => { e.stopPropagation(); onOpen(steam.steamId); }}
            >
                <ProfileLinkIcon platform="steam" size={14} /><span>{name}</span>
                <BadgeCheck size={13} strokeWidth={2.4} className="pcd-verified-tick" aria-hidden="true" />
            </button>
            {tooltip}
        </li>
    );
};

export interface VerifiedSteam { steamId: string; personaName: string | null; avatar: string | null }

/**
 * Steam + socials the owner listed. Renders nothing when there are none. A
 * verified Steam account (`steam`) leads with a ticked chip and replaces any
 * unverified Steam handle the owner typed.
 */
export const ProfileCardLinks: React.FC<{
    links: readonly ProfileLink[] | null | undefined;
    friendsOnly?: boolean;
    className?: string;
    /** Test seam; defaults to the validated external-link path. */
    onOpen?: (l: ProfileLink) => void;
    steam?: VerifiedSteam | null;
    onOpenSteam?: (steamId: string) => void;
}> = ({ links, friendsOnly, className, onOpen = openProfileLink, steam, onOpenSteam }) => {
    const safe = sanitizeLinks(links).filter((l) => !(steam && l.platform === 'steam'));
    if (safe.length === 0 && !steam) return null;
    return (
        <ProfileCardSection title="Links" friendsOnly={friendsOnly} className={className} testId="profile-links">
            <ul className="pcd-chips">
                {steam && <VerifiedSteamChip steam={steam} onOpen={onOpenSteam ?? (() => onOpen({ platform: 'steam', handle: steam.steamId }))} />}
                {safe.map((l) => <ProfileLinkChip key={`${l.platform}:${l.handle}`} link={l} onOpen={onOpen} />)}
            </ul>
        </ProfileCardSection>
    );
};

/** The Steam block: the verified account's persona and avatar (both from Steam's public profile, via our server). */
export const ProfileCardSteam: React.FC<{
    steam: VerifiedSteam;
    friendsOnly?: boolean;
    onOpen: (steamId: string) => void;
    className?: string;
}> = ({ steam, friendsOnly, onOpen, className }) => (
    <ProfileCardSection title="Steam" friendsOnly={friendsOnly} className={className} testId="profile-steam">
        <button
            type="button" className="pcd-steam" aria-label={`${steam.personaName ?? 'Steam account'}, verified on Steam. Opens in your browser.`}
            onClick={(e) => { e.stopPropagation(); onOpen(steam.steamId); }}
        >
            <span className="pcd-steam-av">
                {steam.avatar ? <img src={steam.avatar} alt="" draggable={false} /> : <ProfileLinkIcon platform="steam" size={20} />}
            </span>
            <span className="pcd-steam-txt">
                <b>{steam.personaName ?? 'Steam account'}</b>
                <span><BadgeCheck size={12} strokeWidth={2.5} aria-hidden="true" /> Verified on Steam</span>
            </span>
            <span className="pcd-steam-go" aria-hidden="true">Open</span>
        </button>
    </ProfileCardSection>
);

/** Shown only when THIS device's local safety-number state says the contact is verified. Never sent anywhere. */
export const ProfileCardVerified: React.FC<{ className?: string }> = ({ className }) => (
    <p className={cx('pcd-verified', className)} data-testid="verified-mark">
        <ShieldCheck size={14} aria-hidden="true" />
        You verified their safety number
    </p>
);

/**
 * Interest tags. With `mine` (the viewer's own) the shared ones are
 * highlighted and a "You both like: ..." line appears; the line is for OTHER
 * people's cards only, so pass `mine` only then.
 */
export const ProfileCardInterests: React.FC<{
    interests: readonly string[] | null | undefined;
    mine?: readonly string[] | null;
    friendsOnly?: boolean;
    className?: string;
}> = ({ interests, mine, friendsOnly, className }) => {
    if (!interests || interests.length === 0) return null;
    const mineSet = new Set(mine ?? []);
    const shared = interests.filter((id) => mineSet.has(id));
    // The shared ones are highlighted; the heading says how many, the tooltip names them.
    const line = mine ? youBothLikeLine(shared) : null;
    const aside = line ? <span className="pcd-shared-note" title={line} data-testid="you-both-like">{shared.length} in common</span> : undefined;
    return (
        <ProfileCardSection title="Interests" friendsOnly={friendsOnly} className={className} testId="profile-interests" aside={aside}>
            <ul className="pcd-chips">
                {interests.map((id) => {
                    const on = mineSet.has(id);
                    return (
                        <li key={id} className="pcd-chip" data-shared={on ? 'true' : undefined} title={on ? 'You like this too' : undefined}>
                            <span>{interestLabel(id)}</span>
                        </li>
                    );
                })}
            </ul>
        </ProfileCardSection>
    );
};

/**
 * Body sections, at most `ABOUT_BLOCKS_EXPANDED_MAX` open; the rest fold under
 * "Show N more" so a card with everything switched on stays calm. Rendered as
 * siblings (a fragment) so each section is a direct child of the card body and
 * takes its place in the staggered entrance (`--i`).
 */
export const ProfileCardBlocks: React.FC<{ blocks: React.ReactNode[]; startIndex?: number }> = ({ blocks, startIndex = 0 }) => {
    const [more, setMore] = React.useState(false);
    const shown = blocks.filter(Boolean);
    const { open, folded } = splitFold(shown);
    if (shown.length === 0) return null;
    const wrap = (node: React.ReactNode, i: number) => (
        <div key={i} className="pcd-sec-wrap" style={{ ['--i' as string]: startIndex + i } as React.CSSProperties}>{node}</div>
    );
    return (
        <>
            {open.map(wrap)}
            {folded.length > 0 && !more && (
                <button
                    type="button" aria-expanded={false} onClick={(e) => { e.stopPropagation(); setMore(true); }} data-testid="profile-blocks-more"
                    className="pcd-more"
                >Show {folded.length} more</button>
            )}
            {more && folded.map((n, i) => wrap(n, open.length + i))}
        </>
    );
};
