import React from 'react';
import { useEncryptedAvatar } from '../hooks/useEncryptedAvatar';
import { userColor } from '../utils/avatarColor';
import { useIsFriendOrSelf } from '../contexts/FriendshipContext';

interface BannerProps {
    /** Encrypted attachment ID — resolved via useEncryptedAvatar. Null = fallback to avatar or gradient. */
    attachmentId: string | null;
    /** Avatar attachment ID to use (blurred + darkened) when the banner is missing. */
    fallbackAvatarAttachmentId?: string | null;
    /** When the user has neither a banner nor an avatar, use their deterministic color as the fallback. */
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
}

/**
 * Shared profile-banner component. All sizing is enforced via CSS rules in
 * index.css (.cipherline-banner*) with !important declarations so no Tailwind
 * preflight or cascade battle can cause the image to render smaller than the
 * container. Always call this component — never render a banner <img> by hand.
 */
export const Banner: React.FC<BannerProps> = ({
    attachmentId,
    fallbackAvatarAttachmentId = null,
    fallbackUserId = null,
    token,
    height = 120,
    aspectRatio,
    borderRadius,
    fadeToColor,
    className = '',
    bypassFriendGate = false,
}) => {
    const isFriendOrSelf = useIsFriendOrSelf();
    // Privacy gate: strangers in a shared group / call should never see this
    // user's real banner or avatar. Skip both network fetches and force the
    // colored-fallback branch below. When no `fallbackUserId` is provided
    // (legacy callers that pre-date the privacy gate) we fall through to the
    // old behaviour.
    const allowImage = bypassFriendGate || !fallbackUserId || isFriendOrSelf(fallbackUserId);

    const bannerUrl = useEncryptedAvatar(allowImage ? attachmentId : null, token);
    // Only resolve the fallback avatar when there's no real banner (cached hook — no extra fetch if already loaded elsewhere).
    const fallbackAvatarUrl = useEncryptedAvatar(
        allowImage && !attachmentId ? fallbackAvatarAttachmentId ?? null : null,
        token
    );

    const sizeStyle: React.CSSProperties = aspectRatio
        ? { aspectRatio, height: 'auto' }
        : { height };

    // Strangers always see the user-color fallback even if an attachmentId is
    // present — `allowImage` suppresses the image fetch, so only this branch
    // can render below.
    const colorFallback = fallbackUserId && (!allowImage || (!attachmentId && !fallbackAvatarAttachmentId))
        ? userColor(fallbackUserId)
        : null;

    return (
        <div
            className={`cipherline-banner ${className}`}
            style={{ ...sizeStyle, ...(borderRadius ? { borderRadius } : {}) }}
        >
            {/* Fallback — colored if we have a userId, otherwise the neutral gradient. Always rendered underneath. */}
            {colorFallback ? (
                <div
                    className="cipherline-banner-fallback-colored"
                    style={{ backgroundColor: colorFallback }}
                />
            ) : (
                <div className="cipherline-banner-fallback" />
            )}
            {/* The image itself — real banner wins; else use the avatar as a blurred/darkened fill. */}
            {bannerUrl ? (
                <img src={bannerUrl} alt="" className="cipherline-banner-img" />
            ) : fallbackAvatarUrl ? (
                <img
                    src={fallbackAvatarUrl}
                    alt=""
                    className="cipherline-banner-img cipherline-banner-img-blurred"
                />
            ) : null}
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
