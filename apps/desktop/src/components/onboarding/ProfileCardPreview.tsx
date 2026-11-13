import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { ClButton } from '../ClButton';
import { ProfilePopoutCard } from '../profile/ProfilePopoutCard';
import type { ProfileCardData } from '../profile/profileCardData';
import { STATUS_CONFIG } from '../../utils/userStatusModel';

/**
 * "How friends see you": the NEW profile preview (the popover that opens when
 * someone clicks your name: components/profile/ProfilePopoutCard), fed by the
 * onboarding draft. What a friend sees on a new account: no ⋮ menu, no
 * admin badges, the Pro pill ONLY when the trial actually started (see
 * `isPro` and endingTrial.hasLiveTrial), the green Online status and an
 * inert Message button. No theme / decoration / effect / showcase yet: those
 * are set later in Settings.
 *
 * Motion (steps/profile.css): the card rises into place once (~1.05 s) and
 * then tilts a few degrees toward the pointer under 1100 px perspective, a
 * specular sheen following the light. rAF runs ONLY while the pointer moves or
 * the card eases back. Reduced motion: a flat card, no entrance, no tilt.
 *
 * Pressing the banner or the avatar opens the same pickers as the form.
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

    const hasAvatar = !!(avatarSrc || avatarId);
    const hasBanner = !!(bannerSrc || bannerId);
    const online = STATUS_CONFIG.online;

    const data = useMemo((): ProfileCardData => ({
        name: name ?? 'Your name',
        discriminator: name ? discriminator : null,
        theme: null, decoration: null, effect: null,
        isPro,
        bio: bio.trim() || null,
        blocks: [], topAchievements: [], games: [], links: [], interests: [],
        achievementCount: null, mostPlayed: [],
    }), [name, discriminator, bio, isPro]);

    return (
        <div className="pv-zone" ref={zoneRef}>
            <div className="obpc-persp">
                <div
                    ref={cardRef}
                    className={`obpc${entering ? ' obpc-enter' : ''}${reducedMotion ? ' obpc-flat' : ''}`}
                    data-ob-card
                    data-name-empty={name ? undefined : 'true'}
                >
                    <ProfilePopoutCard
                        userId={userId}
                        token={token}
                        isSelf={false}
                        testId="ob-profile-card"
                        data={data}
                        avatarId={avatarId}
                        bannerId={bannerId}
                        bannerSrc={bannerSrc}
                        avatarSrc={avatarSrc}
                        avatarLabel={hasAvatar ? 'Change profile photo' : 'Add a profile photo'}
                        bannerPickLabel={hasBanner ? 'Change banner' : 'Add a banner'}
                        onAvatarPick={onPickAvatar}
                        onBannerPick={onPickBanner}
                        avatarBadge={<span className="pcd-dot" style={{ backgroundColor: online.color }} title={online.label} />}
                        presence={(
                            <span className="pcd-status-line">
                                <span className="pcd-status-dot" style={{ backgroundColor: online.color }} aria-hidden="true" />
                                <b style={{ color: online.color }}>{online.label}</b>
                            </span>
                        )}
                        // A picture of what friends get: not focusable, hidden from assistive tech (the caption describes it).
                        actionsInert
                        actions={(
                            <ClButton variant="primary" fullWidth>
                                <MessageSquare size={14} />
                                Message
                            </ClButton>
                        )}
                    />
                    {!reducedMotion && <span ref={sheenRef} className="obpc-sheen" aria-hidden />}
                </div>
            </div>
            <p className="pv-cap">How friends see you</p>
        </div>
    );
};
