import React, { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, MessageSquare } from 'lucide-react';
import { ClButton } from '../ClButton';
import { EncryptedAvatar } from '../EncryptedAvatar';
import {
    PROFILE_CARD_FRAME_CLASS, PROFILE_CARD_IDENTITY_CLASS, PROFILE_CARD_INFO_CLASS,
    ProfileCardAbout, ProfileCardAvatar, ProfileCardBanner, ProfileCardFooter, ProfileCardHairline,
    ProfileCardNameRow, ProfileCardStatusDot, ProfileCardStatusLabel, ProfileCardStatusLine,
} from '../ProfileCardParts';
import { STATUS_CONFIG } from '../../utils/userStatusModel';

/**
 * "How friends see you": the real profile popover (ProfileModal), built from
 * the SAME parts (ProfileCardParts), in CSS 3D. What a friend sees on a new
 * account: no ⋮ menu (that is on other people's cards only), no admin badges
 * (nobody new has any), the Pro pill ONLY when the trial actually started (the
 * API now gives an active trial `is_pro`, exactly like a paying user; when the
 * per-network quota withheld the trial the account is free and shows none, see
 * `isPro` and endingTrial.hasLiveTrial), the green Online status and a
 * full-width Message button (inert).
 *
 * Motion (steps/profile.css):
 *   - the entrance (~1.05 s): the card rises out of depth with a settling
 *     swing, its layers assembling in order, one sheen pass. The class is then
 *     removed so the tilt starts from the true resting state;
 *   - the tilt: toward the pointer (up to 9° / 7°) under 1100 px perspective,
 *     every layer at its own depth, a specular sheen following the light.
 *     rAF runs ONLY while the pointer moves or the card eases back.
 *   - reduced motion: a flat card, no entrance, no tilt.
 *
 * Clicking the banner or the avatar opens the same pickers as the form.
 */

export interface ProfileCardPreviewProps {
    userId: string;
    token: string;
    /** Valid name (or null → the muted "Your name" placeholder). */
    name: string | null;
    /** The #tag the SERVER allocated for `name` (null while not confirmed). */
    discriminator: number | null;
    bio: string;
    /** Local preview (blob:) of a picked photo / banner. */
    avatarSrc: string | null;
    bannerSrc: string | null;
    /** Saved attachment ids (resume), used when there is no local preview. */
    avatarId: string | null;
    bannerId: string | null;
    reducedMotion: boolean;
    /** True while a cropper is open: the tilt ignores the pointer. */
    paused: boolean;
    /** Show the Pro pill: the new account's trial started (false when withheld). */
    isPro?: boolean;
    onPickAvatar: () => void;
    onPickBanner: () => void;
}

const ENTRANCE_MS = 1250;
const MAX_TILT_Y = 9;   // degrees, left/right
const MAX_TILT_X = 7;   // degrees, up/down
const EASE = 0.14;

/** Pointer tilt. Writes the card's inline transform and the (childless) sheen's
 *  own variables directly: no React renders, no subtree restyle, rAF only while
 *  easing, nothing at all while idle. */
function useCardTilt(
    zoneRef: React.RefObject<HTMLElement | null>,
    cardRef: React.RefObject<HTMLElement | null>,
    sheenRef: React.RefObject<HTMLElement | null>,
    enabled: boolean,
    ignoreRef: React.RefObject<boolean>,
) {
    useEffect(() => {
        const zone = zoneRef.current, card = cardRef.current, sheen = sheenRef.current;
        if (!enabled || !zone || !card || !sheen) return;
        const cur = { x: 0, y: 0, s: 0 }, tg = { x: 0, y: 0, s: 0 };
        let raf = 0;
        let last = 0;
        const tick = (now: number) => {
            // Frame-rate independent easing (EASE per 60 Hz frame), so a slow
            // machine settles in the same wall time instead of easing for longer.
            const frames = last ? Math.min(60, (now - last) / (1000 / 60)) : 1;
            last = now;
            const k = 1 - Math.pow(1 - EASE, frames);
            cur.x += (tg.x - cur.x) * k; cur.y += (tg.y - cur.y) * k; cur.s += (tg.s - cur.s) * k;
            const settled = Math.abs(tg.x - cur.x) + Math.abs(tg.y - cur.y) + Math.abs(tg.s - cur.s) < 0.004;
            if (settled) { cur.x = tg.x; cur.y = tg.y; cur.s = tg.s; }
            card.style.transform = `rotateX(${cur.x.toFixed(3)}deg) rotateY(${cur.y.toFixed(3)}deg)`;
            sheen.style.setProperty('--sx', `${(50 + cur.y * 5).toFixed(1)}%`);
            sheen.style.setProperty('--sy', `${(30 - cur.x * 6).toFixed(1)}%`);
            sheen.style.setProperty('--sh', cur.s.toFixed(3));
            raf = settled ? 0 : requestAnimationFrame(tick);
            if (settled) last = 0;
        };
        const kick = () => { if (!raf) { last = 0; raf = requestAnimationFrame(tick); } };
        const rest = () => { tg.x = 0; tg.y = 0; tg.s = 0; kick(); };
        // Geometry is re-read at most every 300 ms, not per pointer event (the
        // card only moves when the layout does: a bio line, a resize, a scroll).
        let rects: { z: DOMRect; r: DOMRect } | null = null;
        let rectsAt = 0;
        const geometry = () => {
            const now = performance.now();
            if (!rects || now - rectsAt > 300) { rects = { z: zone.getBoundingClientRect(), r: card.getBoundingClientRect() }; rectsAt = now; }
            return rects;
        };
        const onMove = (e: PointerEvent) => {
            if (ignoreRef.current) return;
            const { z, r } = geometry();
            const inside = e.clientX > z.left - 40 && e.clientX < z.right + 40 && e.clientY > z.top - 40 && e.clientY < z.bottom + 40;
            if (!inside) { if (tg.s !== 0) rest(); return; }
            const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width / 2 + 60)));
            const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height / 2 + 60)));
            tg.y = dx * MAX_TILT_Y; tg.x = -dy * MAX_TILT_X; tg.s = 1;
            kick();
        };
        window.addEventListener('pointermove', onMove, { passive: true });
        zone.addEventListener('pointerleave', rest);
        return () => {
            window.removeEventListener('pointermove', onMove);
            zone.removeEventListener('pointerleave', rest);
            if (raf) cancelAnimationFrame(raf);
            card.style.removeProperty('transform');
            ['--sx', '--sy', '--sh'].forEach(p => sheen.style.removeProperty(p));
        };
    }, [zoneRef, cardRef, sheenRef, enabled, ignoreRef]);
}

export const ProfileCardPreview: React.FC<ProfileCardPreviewProps> = ({
    userId, token, name, discriminator, bio, avatarSrc, bannerSrc, avatarId, bannerId,
    reducedMotion, paused, isPro = false, onPickAvatar, onPickBanner,
}) => {
    const zoneRef = useRef<HTMLDivElement>(null);
    const cardRef = useRef<HTMLDivElement>(null);
    const sheenRef = useRef<HTMLSpanElement>(null);
    const [entering, setEntering] = useState(!reducedMotion);
    useEffect(() => {
        if (!entering) return;
        const t = window.setTimeout(() => setEntering(false), ENTRANCE_MS);
        return () => window.clearTimeout(t);
    }, [entering]);
    // The tilt ignores the pointer until the entrance has finished, and while
    // a cropper is open over the step.
    const ignoreRef = useRef(true);
    useEffect(() => { ignoreRef.current = entering || paused; }, [entering, paused]);
    useCardTilt(zoneRef, cardRef, sheenRef, !reducedMotion, ignoreRef);

    // The inert Message button: no focus, no pointer, hidden from AT (the
    // "How friends see you" caption describes the preview instead).
    const actRef = useRef<HTMLDivElement>(null);
    useEffect(() => { actRef.current?.setAttribute('inert', ''); }, []);

    const hasAvatar = !!(avatarSrc || avatarId);
    const hasBanner = !!(bannerSrc || bannerId);
    const online = STATUS_CONFIG.online;
    const trimmedBio = bio.trim();

    return (
        <div className="pv-zone" ref={zoneRef}>
            <div className="obpc-persp">
                <div
                    ref={cardRef}
                    className={`obpc ${PROFILE_CARD_FRAME_CLASS}${entering ? ' obpc-enter' : ''}${reducedMotion ? ' obpc-flat' : ''}`}
                    data-ob-card
                >
                    <button
                        type="button"
                        className="obpc-banner obpc-l"
                        onClick={onPickBanner}
                        aria-label={hasBanner ? 'Change banner' : 'Add a banner'}
                    >
                        <ProfileCardBanner attachmentId={bannerSrc ? null : bannerId} userId={userId} token={token} src={bannerSrc} />
                        <span className="obpc-hint"><ImageIcon size={14} aria-hidden /> {hasBanner ? 'Change banner' : 'Add a banner'}</span>
                    </button>

                    <ProfileCardAvatar
                        className="obpc-l obpc-l-av"
                        ariaLabel={hasAvatar ? 'Change profile photo' : 'Add a profile photo'}
                        onClick={onPickAvatar}
                        interactionClassName="cursor-pointer hover:scale-[1.04] obpc-av"
                        badge={<ProfileCardStatusDot color={online.color} title={online.label} />}
                    >
                        {avatarSrc ? (
                            <img src={avatarSrc} alt="" className="object-cover rounded-full w-full h-full" />
                        ) : (
                            <EncryptedAvatar
                                attachmentId={avatarId}
                                userId={userId}
                                token={token}
                                className="w-full h-full"
                                fallbackSize={40}
                                disableClickProfile
                                bypassFriendGate
                            />
                        )}
                        <span className="obpc-avhint" aria-hidden><Camera size={20} /></span>
                    </ProfileCardAvatar>

                    <div className={`${PROFILE_CARD_INFO_CLASS} obpc-3d`}>
                        <div className={`${PROFILE_CARD_IDENTITY_CLASS} obpc-3d`}>
                            <ProfileCardNameRow
                                className="obpc-l obpc-l-id"
                                name={name ?? <span className="obpc-ph">Your name</span>}
                                discriminator={name ? discriminator : null}
                                isPro={isPro}
                            />
                            <ProfileCardStatusLine className="obpc-l obpc-l-st">
                                <ProfileCardStatusLabel color={online.color} label={online.label} />
                            </ProfileCardStatusLine>
                        </div>
                        {trimmedBio && (
                            <div className="obpc-l obpc-l-ab">
                                <ProfileCardHairline />
                                <ProfileCardAbout bio={trimmedBio} />
                            </div>
                        )}
                    </div>

                    <div ref={actRef} className="obpc-l obpc-l-act" aria-hidden>
                        <ProfileCardFooter>
                            <ClButton variant="primary" fullWidth>
                                <MessageSquare size={14} />
                                Message
                            </ClButton>
                        </ProfileCardFooter>
                    </div>

                    {!reducedMotion && <span ref={sheenRef} className="obpc-sheen" aria-hidden />}
                </div>
            </div>
            <p className="pv-cap">How friends see you</p>
        </div>
    );
};
