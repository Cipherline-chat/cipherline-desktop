import React, { useState } from 'react';
import { useEncryptedAvatar, evictAvatar } from '../hooks/useEncryptedAvatar';
import { useIsFriendOrSelf } from '../contexts/FriendshipContext';
import cipherlineMark from '../assets/cipherline-mark.svg';

interface BannerProps {
    /** Encrypted attachment ID — resolved via useEncryptedAvatar. Null = the default Cipherline banner. */
    attachmentId: string | null;
    /** No longer rendered: the default banner replaced the blurred-avatar
     *  fallback (owner decision, 2026-10-05). Kept so existing callers compile. */
    fallbackAvatarAttachmentId?: string | null;
    /** The banner's owner, for the friend/self privacy gate. (It no longer
     *  picks a colour: the default banner replaced that fallback too.) */
    fallbackUserId?: string | null;
    token: string;
    /** Pixel height of the banner (default 120). Ignored when `aspectRatio` is set. */
    height?: number;
    /** CSS aspect-ratio string (e.g. "16 / 9") — if set, height is computed from container width. */
    aspectRatio?: string;
    /** Optional border-radius (e.g. '12px 12px 0 0' for top-only rounding). */
    borderRadius?: string;
    /** If set, renders a linear-gradient fade from transparent → this color at the bottom (for avatar overlap). */
    fadeToColor?: string;
    /** Passthrough className for the root container (positioning, margin, etc.). */
    className?: string;
    /** Pass true to skip the friend/self privacy gate — same semantics as
     *  EncryptedAvatar.bypassFriendGate.  Use in contexts where the viewer
     *  is already in a shared server or group with the subject (e.g. profile
     *  modal opened from a server member list). */
    bypassFriendGate?: boolean;
    /** A local preview (a blob: URL of a just-cropped image that is not
     *  uploaded yet) shown INSTEAD of the attachment. The onboarding profile
     *  card uses it; everything else leaves it unset. */
    src?: string | null;
}

/**
 * The default banner (owner request, 2026-10-05; the design from the round-6
 * onboarding prototype): a deep navy field with a faint fine grid, the Keys
 * mark small and dim near the top, and a soft teal glow rising from below
 * behind the avatar. It replaces the old fallbacks (the avatar blurred, or
 * the user's colour) everywhere a user has no banner of their own: the
 * profile popover, Settings → Profile, the DM partner panel, the onboarding
 * card. Pure CSS (index.css `.cipherline-banner-default*`) + the bundled mark.
 */
export const DefaultBanner: React.FC = () => (
    <div className="cipherline-banner-default" aria-hidden>
        <span className="cipherline-banner-default-grid" />
        <span className="cipherline-banner-default-glow" />
        <img src={cipherlineMark} alt="" className="cipherline-banner-default-mark" draggable={false} />
    </div>
);

const BANNER_KIND = { kind: 'banner' } as const;

/**
 * Shared profile-banner component. All sizing is enforced via CSS rules in
 * index.css (.cipherline-banner*) with !important declarations so no Tailwind
 * preflight or cascade battle can cause the image to render smaller than the
 * container. Always call this component — never render a banner <img> by hand.
 */
export const Banner: React.FC<BannerProps> = ({
    attachmentId,
    fallbackUserId = null,
    token,
    height = 120,
    aspectRatio,
    borderRadius,
    fadeToColor,
    className = '',
    bypassFriendGate = false,
    src = null,
}) => {
    const isFriendOrSelf = useIsFriendOrSelf();
    // Privacy gate: strangers in a shared group / call never see this user's
    // real banner — the fetch is skipped and they get the default banner.
    // When no `fallbackUserId` is provided (legacy callers that pre-date the
    // privacy gate) we fall through to the old behaviour.
    const allowImage = bypassFriendGate || !fallbackUserId || isFriendOrSelf(fallbackUserId);

    // `kind: 'banner'` only picks the persisted blob's prune budget — banners
    // are ~3x an avatar and must not evict the avatars every chat row paints.
    const resolvedUrl = useEncryptedAvatar(allowImage && !src ? attachmentId : null, token, null, BANNER_KIND);
    const bannerUrl = src || resolvedUrl;

    // ── No blank flash, no pop ───────────────────────────────────────────────
    // The default banner is ALWAYS underneath, so there is never an empty box.
    // An image that was already decrypted when the card mounted (memory cache
    // hit — the common case once a profile has been seen, prefetched on hover,
    // or warmed) paints solid on the first frame. One that resolves later
    // (download + decrypt) cross-fades in over the default instead of
    // hard-swapping — the same rule EncryptedAvatar uses, for the same reason.
    // The URL present at mount, captured once (state, not a ref: it is read
    // during render).
    const [firstUrl] = useState(bannerUrl);
    const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
    // A blob URL that fails to decode (revoked after a long session, corrupt
    // cache entry) must not leave a broken image over the default: evict it so
    // the next open re-downloads, and fall back to the default banner. Keyed by
    // attachment id, like EncryptedAvatar, so a re-minted URL for the same bad
    // attachment does not loop.
    const [broken, setBroken] = useState<string | null>(null);
    const showImage = !!bannerUrl && (src ? true : broken !== attachmentId);
    const fades = bannerUrl !== firstUrl;

    const sizeStyle: React.CSSProperties = aspectRatio
        ? { aspectRatio, height: 'auto' }
        : { height };

    return (
        <div
            className={`cipherline-banner ${className}`}
            style={{ ...sizeStyle, ...(borderRadius ? { borderRadius } : {}) }}
        >
            {/* Always underneath: the default banner, until (unless) a real one loads. */}
            <DefaultBanner />
            {showImage && (
                <img
                    src={bannerUrl!}
                    alt=""
                    className="cipherline-banner-img"
                    style={fades ? { opacity: loadedUrl === bannerUrl ? 1 : 0, transition: 'opacity .2s ease' } : undefined}
                    onLoad={fades ? () => setLoadedUrl(bannerUrl) : undefined}
                    onError={() => {
                        if (src) return;
                        if (attachmentId) evictAvatar(attachmentId);
                        setBroken(attachmentId);
                    }}
                />
            )}
            {/* Optional bottom fade for avatar-overlap contexts */}
            {fadeToColor && (
                <div
                    className="cipherline-banner-fade"
                    style={{
                        background: `linear-gradient(to bottom,
                            transparent 45%,
                            color-mix(in srgb, ${fadeToColor} 10%, transparent) 70%,
                            color-mix(in srgb, ${fadeToColor} 45%, transparent) 85%,
                            ${fadeToColor} 100%)`,
                    }}
                />
            )}
        </div>
    );
};
