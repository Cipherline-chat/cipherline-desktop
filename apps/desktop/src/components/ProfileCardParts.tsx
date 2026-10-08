import React from 'react';
import { Crown } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { ClRole } from './cl';
import { Banner } from './Banner';
import { ProfileBadgeRow } from './ProfileBadgeRow';
import type { ProfileBadge } from '../utils/profileBadges';

/**
 * The profile card's presentational pieces, shared by the real profile
 * popover (ProfileModal) and the onboarding profile step's live 3D preview
 * (onboarding/ProfileCardPreview), so the two cannot drift apart.
 *
 * Every part renders EXACTLY the markup ProfileModal rendered inline before
 * the extraction. The optional `className` props only append (they are unset
 * in ProfileModal); the onboarding preview uses them to put each layer at its
 * own 3D depth. Behaviour (fetching, menus, lightbox, nickname editing) stays
 * in ProfileModal.
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
}> = ({ attachmentId, fallbackAvatarAttachmentId = null, userId, token, src }) => (
    <div className="relative rounded-t-[20px] overflow-hidden">
        <Banner
            attachmentId={attachmentId}
            fallbackAvatarAttachmentId={fallbackAvatarAttachmentId}
            fallbackUserId={userId}
            token={token}
            height={120}
            fadeToColor={PROFILE_CARD_BG}
            bypassFriendGate
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
}> = ({ ariaLabel, title, onClick, interactionClassName, children, badge, className }) => (
    <div className={cx('px-5 -mt-6 flex justify-center', className)}>
        <div className="relative">
            <button
                type="button"
                aria-label={ariaLabel}
                title={title}
                onClick={onClick}
                className={`block w-24 h-24 rounded-full ring-4 ring-[#131A30] overflow-hidden bg-cl-raise p-0 border-none transition-transform duration-200 ${interactionClassName}`}
            >
                {children}
            </button>
            {badge}
        </div>
    </div>
);

/** Status badge — bottom-right of the avatar, ringed to separate from the avatar face. */
export const ProfileCardStatusDot: React.FC<{ color: string; title: string }> = ({ color, title }) => (
    <span
        className="absolute w-5 h-5 rounded-full ring-[3px] ring-[#131A30]"
        style={{ backgroundColor: color, right: 2, bottom: 2 }}
        title={title}
    />
);

/** Name, the #tag pill, the Pro pill and admin badges. */
export const ProfileCardNameRow: React.FC<{
    name: React.ReactNode;
    discriminator: number | null | undefined;
    isPro?: boolean;
    badges?: ProfileBadge[];
    className?: string;
}> = ({ name, discriminator, isPro, badges, className }) => (
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
        {isPro && (
            <ClRole variant="gold" style={{ fontSize: 11 }}>
                <Crown size={11} aria-hidden /> Pro
            </ClRole>
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

/** Bio — the ABOUT section. */
export const ProfileCardAbout: React.FC<{ bio: string; className?: string }> = ({ bio, className }) => (
    <div className={className}>
        <ProfileCardEyebrow>About</ProfileCardEyebrow>
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
