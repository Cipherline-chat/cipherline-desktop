import React, { useEffect, useRef, useState } from 'react';
import { User, Users } from 'lucide-react';
import { useEncryptedAvatar , evictAvatar } from '../hooks/useEncryptedAvatar';
import { userColor } from '../utils/avatarColor';
import { useOpenProfile } from '../contexts/ProfileOpenContext';
import { useIsFriendOrSelf } from '../contexts/FriendshipContext';
import { scheduleProfilePrefetch } from '../utils/profileCache';

interface EncryptedAvatarProps {
    attachmentId?: string | null;
    token: string | null;
    className?: string;
    style?: React.CSSProperties;
    fallbackSize?: number;
    /** When provided, the fallback uses a color hashed from this ID — Discord/Slack-style.
     *  Also makes the avatar clickable: click → open that user's profile modal. */
    userId?: string | null;
    /** If true, fallback uses the <Users> group icon on a neutral surface (no user color).
     *  Groups are never click-to-profile. */
    isGroup?: boolean;
    /** Pass true to suppress the automatic click-to-open-profile behavior
     *  (e.g. in SettingsModal where clicking own avatar opens a file picker). */
    disableClickProfile?: boolean;
    /** Pass true to skip the friend / self privacy gate. Use this in contexts
     *  where the user is already exposed by other means — e.g. call tiles
     *  (you're sharing audio/video with them anyway, so hiding the avatar adds
     *  no privacy and just looks broken). The deterministic color + silhouette
     *  fallback still applies when there's truly no attachment id. */
    bypassFriendGate?: boolean;
}

export const EncryptedAvatar: React.FC<EncryptedAvatarProps> = ({
    attachmentId,
    token,
    className = '',
    style,
    fallbackSize = 24,
    userId,
    isGroup = false,
    disableClickProfile = false,
    bypassFriendGate = false,
}) => {
    const isFriendOrSelf = useIsFriendOrSelf();
    // Privacy gate: don't fetch / display a user's profile picture to strangers
    // sharing only a group chat or a call with them. Groups are a different
    // trust surface (server gates by group membership, not friendship) so they
    // always resolve. When no userId is provided (legacy callers), treat it as
    // "allow" — everything that shows strangers passes a userId. Call tiles
    // pass `bypassFriendGate` because once you're in a call together you're
    // already sharing audio/video — hiding the avatar adds nothing.
    const allowImage = bypassFriendGate || isGroup || !userId || isFriendOrSelf(userId);
    const avatarUrl = useEncryptedAvatar(allowImage ? attachmentId : null, token);
    const openProfile = useOpenProfile();

    // Fade the image in ONLY when it resolved asynchronously (download+decrypt).
    // Memory-cache hits arrive synchronously at first render — fading those
    // would make every scroll-remounted avatar flicker, so they render solid.
    const instant = useRef(avatarUrl !== null).current;
    const [loaded, setLoaded] = useState(false);
    // A blob URL that resolves but fails to decode (revoked URL after a long
    // session, corrupt cache entry) used to leave an INVISIBLE image: opacity
    // stays 0 waiting for onLoad that never comes. Evict and show the fallback.
    //
    // Keyed by ATTACHMENT ID, not by the blob URL. evictAvatar() revokes the
    // URL and drops the IndexedDB entry, so the next resolve mints a brand-new
    // URL for the same bad attachment — which never equalled the remembered
    // one, so the <img> re-rendered, failed, evicted and re-downloaded forever.
    // That loop burned two API requests per turn and kept a broken image on
    // screen the whole time. The attachment id is stable across those remints,
    // and it changes when the row is reused for a different user, which is
    // exactly when the flag should reset.
    const [broken, setBroken] = useState<string | null>(null);

    // The catalog egg: poking an avatar makes it boing. Class-based so the kit
    // keyframes drive it; the ref lets spam restart cleanly without state churn.
    const imgRef = useRef<HTMLElement | null>(null);
    const playBoing = () => {
        const el = imgRef.current;
        if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        el.classList.remove('enc-av-boing');
        void el.getBoundingClientRect();
        el.classList.add('enc-av-boing');
        window.setTimeout(() => el.classList.remove('enc-av-boing'), 500);
    };

    // Avatar is clickable iff it represents a concrete user AND a profile-open
    // handler is in context AND the caller hasn't opted out. Groups never open
    // profiles (there's no single user to show).
    const clickable = !!userId && !isGroup && !!openProfile && !disableClickProfile;
    const handleClick = clickable
        ? (e: React.MouseEvent) => {
              e.stopPropagation();
              playBoing();
              openProfile!(userId!, { x: e.clientX, y: e.clientY });
          }
        : undefined;
    const clickableClass = clickable ? 'cursor-pointer enc-av-poke' : '';

    // Profile prefetch: a pointer RESTING on a clickable avatar is intent, so
    // the profile and both its images start loading before the click (bounded
    // and rate-limited in utils/profileCache — a pointer sweeping across a
    // member list costs nothing). Pressing the button starts it immediately:
    // the click that opens the card lands ~100 ms later and joins it.
    //
    // The HOVER half is friends-and-self only. It is a guess, and for anyone
    // else it would fetch a picture the friend gate above deliberately does
    // not fetch for this row, and tell the server whose card you merely
    // pointed at. A press is different: it IS the open, one event early, so
    // it makes exactly the requests the card would have made anyway.
    const hoverPrefetchOk = clickable && !!userId && isFriendOrSelf(userId);
    const cancelPrefetch = useRef<(() => void) | null>(null);
    useEffect(() => () => { cancelPrefetch.current?.(); }, []);
    const prefetchHandlers = clickable
        ? {
              onMouseEnter: () => {
                  cancelPrefetch.current?.();
                  cancelPrefetch.current = hoverPrefetchOk ? scheduleProfilePrefetch(userId, token) : null;
              },
              onMouseLeave: () => { cancelPrefetch.current?.(); cancelPrefetch.current = null; },
              onPointerDown: (e: React.PointerEvent) => {
                  if (e.button !== 0) return;
                  cancelPrefetch.current?.();
                  cancelPrefetch.current = null;
                  scheduleProfilePrefetch(userId, token, { immediate: true });
              },
          }
        : undefined;

    if (avatarUrl && broken !== attachmentId) {
        return (
            <img
                ref={imgRef as React.RefObject<HTMLImageElement>}
                src={avatarUrl}
                // Deliberately empty. A decorative avatar sits next to the
                // name it belongs to in every caller, so the word "Avatar" adds
                // nothing a screen reader wants — and when the image fails to
                // paint the browser renders that alt text as literal body copy,
                // which is where the bare, uninterpretable "Avatar" line in the
                // UI came from. Empty alt means a broken image shows nothing
                // and the silhouette fallback below takes over instead.
                alt=""
                className={`object-cover rounded-full ${clickableClass} ${className}`}
                style={{ ...(instant || loaded ? undefined : { opacity: 0 }), ...style }}
                onLoad={instant ? undefined : (e) => {
                    // Resolve, don't pop: the fallback was on screen — cross the
                    // decrypted image in over ~180ms instead of hard-swapping.
                    const el = e.currentTarget;
                    el.style.transition = 'opacity .18s ease';
                    el.style.opacity = '1';
                    setLoaded(true);
                }}
                onError={() => {
                    if (attachmentId) evictAvatar(attachmentId);
                    setBroken(attachmentId ?? null);
                }}
                onClick={handleClick}
                {...prefetchHandlers}
            />
        );
    }

    if (isGroup) {
        return (
            <div
                className={`flex items-center justify-center rounded-full ${className}`}
                style={{ background: 'var(--cl-raise)', color: 'var(--cl-faint)', ...style }}
            >
                <Users size={fallbackSize} />
            </div>
        );
    }

    // Individual user with no avatar: deterministic color backdrop + single-person silhouette.
    // Icon is always black for the strongest, most consistent look across all palette colors.
    const bg = userId ? userColor(userId) : 'var(--cl-raise)';
    return (
        <div
            ref={imgRef as React.RefObject<HTMLDivElement>}
            className={`flex items-center justify-center rounded-full ${clickableClass} ${className}`}
            style={{ backgroundColor: bg, color: userId ? '#000000' : 'var(--cl-faint)', ...style }}
            onClick={handleClick}
            {...prefetchHandlers}
        >
            <User size={fallbackSize} strokeWidth={2.2} />
        </div>
    );
};
