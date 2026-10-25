import React, { useEffect, useId, useRef, useState } from 'react';
import { hueTint, type ItemOptions } from '../utils/profileCosmetics';
import { isPersonalEmojiId } from '../utils/personalEmoji/token';
import { usePersonalEmojiUrl } from '../hooks/usePersonalEmojis';
import { DECORATION_ART, resolveDecoration } from './cosmetics/decorations';
import { SAFE_ZONE } from './cosmetics/geometry';
import { itemTint } from './cosmetics/colour';
import { EffectCanvas } from './cosmetics/effects/EffectCanvas';
import { EFFECT_PROGRAMS } from './cosmetics/effects/programs';
import '../styles/profile-cosmetics.css';

/**
 * Avatar decorations and profile effects. Which ids exist and how they
 * unlock: utils/profileCosmetics.ts (the server is the authority). The art:
 * cosmetics/decorations.tsx (SVG) and cosmetics/effects/ (canvas). An unknown
 * id renders nothing, so an old client simply shows no decoration for an id it
 * has never heard of.
 *
 * A decoration is drawn in a 100x100 box that IS the avatar; art may overflow
 * it (`overflow: visible`). The `back` layer sits behind the avatar, `front`
 * over it. Both are masked so nothing ever draws over the status dot
 * (cosmetics/geometry.ts SAFE_ZONE).
 */

const SPEED: Readonly<Record<number, number>> = { 1: 1.6, 2: 1, 3: 0.6 };

/** Does this client know how to draw `id`? */
const hasDecorationArt = (id: string | null | undefined): boolean => !!resolveDecoration(id);

const SafeMask: React.FC<{ id: string }> = ({ id }) => (
    <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="-80" y="-80" width="260" height="260">
            <rect x="-80" y="-80" width="260" height="260" fill="#fff" />
            <circle cx={SAFE_ZONE.cx} cy={SAFE_ZONE.cy} r={SAFE_ZONE.r} fill="#000" />
        </mask>
    </defs>
);

/**
 * Wrap an avatar to draw `decoration` around it. Without a (known) decoration
 * it renders the children untouched in a plain wrapper - callers can use it
 * unconditionally. The wrapper is the avatar's box: size it via `className`.
 */
export const AvatarDecoration: React.FC<{
    decoration: string | null | undefined;
    children: React.ReactNode;
    className?: string;
    block?: boolean;
    /** "Match theme": the colour hue-able decorations take when no hue option is set (utils/profileTheme.matchTint). */
    tint?: string | null;
    /** The owner's knobs for this decoration (utils/profileCosmetics DECORATION_OPTIONS): a hue beats `tint`. */
    options?: ItemOptions | null;
}> = ({ decoration, children, className, block, tint, options }) => {
    const rawId = useId();
    const u = `pcd${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const resolved = hasDecorationArt(decoration) ? resolveDecoration(decoration) : null;
    const art = resolved ? DECORATION_ART[resolved.base] : null;
    const o: ItemOptions = { ...(options ?? {}) };
    if (resolved?.legacyHue != null) o.h = resolved.legacyHue;
    const ctx = { u, o, tint: tint ?? null };
    const style: Record<string, string> = {};
    if (o.s) style['--pc-speed'] = String(SPEED[o.s] ?? 1);
    // Surrounding CSS may still read `--pc-tint`; the art itself takes its colours from `o` / `tint`.
    const legacyTint = hueTint(o.h);
    if (legacyTint) style['--pc-tint'] = legacyTint;
    return (
        <span
            className={['pc-deco-host', block ? 'pc-deco-host--block' : '', className ?? ''].filter(Boolean).join(' ')}
            data-decoration={art ? decoration : undefined}
            style={Object.keys(style).length ? (style as React.CSSProperties) : undefined}
        >
            {children}
            {art?.back && (
                <svg className="pc-deco-art pc-deco-back" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
                    <SafeMask id={`${u}-safe-b`} />
                    <g mask={`url(#${u}-safe-b)`} data-safe-zone="masked">{art.back({ ...ctx, u: `${u}b` })}</g>
                </svg>
            )}
            {art?.front && (
                <svg className="pc-deco-art pc-deco-front" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
                    <SafeMask id={`${u}-safe-f`} />
                    <g mask={`url(#${u}-safe-f)`} data-safe-zone="masked">{art.front({ ...ctx, u: `${u}f` })}</g>
                </svg>
            )}
        </span>
    );
};

// ── effects ──────────────────────────────────────────────────────────────────

const hasEffectArt = (id: string | null | undefined): boolean => !!id && Object.prototype.hasOwnProperty.call(EFFECT_PROGRAMS, id);

/** A stable seed per effect id (so a card's layout is the same every time it opens). */
const seedOf = (id: string): number => {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    return h >>> 0;
};

/**
 * keepsake-rain's picture. `m` = 'avatar' (default): the avatar image the card
 * already shows (`avatarSrc`, or the card's own avatar <img> - so a viewer who
 * is not shown the avatar is not shown it here either). `m` = 'p_<id>': one of
 * the owner's My Emojis, resolved ON THIS DEVICE ONLY (own library, or the
 * received cache a friend's client delivered it into - hooks/useStatusEmojiShare.ts).
 * Not held = null, and the effect falls back to plain droplets. Never a fetch.
 */
function useRainImage(enabled: boolean, m: string | undefined, avatarSrc: string | null | undefined, hostRef: React.RefObject<HTMLDivElement | null>): { image: HTMLImageElement | null; round: boolean } {
    const emojiId = enabled && m && isPersonalEmojiId(m) ? m : null;
    const emoji = usePersonalEmojiUrl(emojiId);
    const [domAvatar, setDomAvatar] = useState<string | null>(null);
    const wantAvatar = enabled && !emojiId;
    useEffect(() => {
        if (!wantAvatar || avatarSrc) return;
        const card = hostRef.current?.parentElement;
        if (!card) return;
        const read = () => {
            const img = card.querySelector('[data-hx-layer="avatar"] img, [data-fx-avatar] img') as HTMLImageElement | null;
            setDomAvatar(img?.currentSrc || img?.src || null);
        };
        read();
        const layer = card.querySelector('[data-hx-layer="avatar"], [data-fx-avatar]');
        if (!layer || typeof MutationObserver === 'undefined') return;
        const mo = new MutationObserver(read);
        mo.observe(layer, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
        return () => mo.disconnect();
    }, [wantAvatar, avatarSrc, hostRef]);
    const src = emojiId ? (emoji.status === 'ready' ? emoji.url : null) : wantAvatar ? (avatarSrc ?? domAvatar) : null;
    const [image, setImage] = useState<{ src: string; el: HTMLImageElement } | null>(null);
    useEffect(() => {
        if (!src) return;
        let live = true;
        const el = new Image();
        el.decoding = 'async';
        el.onload = () => { if (live) setImage({ src, el }); };
        el.src = src;
        return () => { live = false; };
    }, [src]);
    return { image: src && image?.src === src ? image.el : null, round: !emojiId };
}

/** Without `loop`: how long an effect plays when it mounts, then the fade before it rests (a still). */
export const EFFECT_PLAY_MS = 2600;
export const EFFECT_FADE_MS = 360;
type EffectPhase = 'play' | 'rest';

const reducedMotion = (): boolean =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The animated overlay for the profile CARD (not lists). Fills its positioned
 * parent, ignores the pointer, sits under the avatar.
 *
 * Motion policy (owner, 2026-10-24; styles/profile-motion.css):
 *   - `loop` (the open popover, full profile, Settings preview, a hovered
 *     picker tile): plays CONTINUOUSLY while Cipherline is in front, pausing
 *     only when the window is not (`data-cl-window="inactive"`) or the card is
 *     off screen - never because you stopped moving the mouse;
 *   - no `loop` (a picker thumbnail at rest, the anniversary confetti): plays
 *     for EFFECT_PLAY_MS, then rests as a still;
 *   - reduced motion: one still frame, always.
 * Every program is seamless (cosmetics/effects/), so a loop never shows a seam.
 * `tint` (Match theme) is the colour hue-able effects take when no hue option is set.
 */
export const ProfileEffect: React.FC<{
    effect: string | null | undefined;
    tint?: string | null;
    options?: ItemOptions | null;
    loop?: boolean;
    /** keepsake-rain: the owner's avatar as this card shows it (else the card's avatar <img> is used). */
    avatarSrc?: string | null;
}> = ({ effect, tint, options, loop = false, avatarSrc }) => {
    const ref = useRef<HTMLDivElement>(null);
    const id = hasEffectArt(effect) ? (effect as string) : null;
    const program = id ? EFFECT_PROGRAMS[id] : null;
    const o: ItemOptions = options ?? {};
    const rain = useRainImage(id === 'keepsake-rain', o.m ?? 'avatar', avatarSrc, ref);

    const [phase, setPhase] = useState<EffectPhase>(() => (reducedMotion() ? 'rest' : 'play'));
    // A new pick plays again, and turning `loop` on wakes a resting one (set while rendering, not in an effect).
    const [seen, setSeen] = useState({ effect, loop });
    if (seen.effect !== effect || seen.loop !== loop) {
        setSeen({ effect, loop });
        setPhase(reducedMotion() ? 'rest' : 'play');
    }
    useEffect(() => {
        if (reducedMotion() || loop) return;
        const t = window.setTimeout(() => setPhase('rest'), EFFECT_PLAY_MS);
        return () => window.clearTimeout(t);
    }, [effect, loop]);

    // The host card becomes its own stacking context so the overlay stays inside it.
    useEffect(() => {
        const host = ref.current?.parentElement;
        if (!host || !id) return;
        host.setAttribute('data-has-fx', 'true');
        return () => host.removeAttribute('data-has-fx');
    }, [id]);

    if (!id || !program) return null;
    const t = itemTint(o.h, tint, program.stock);
    return (
        <div
            ref={ref} key={id} className={`pc-fx pc-fx--${id}`} aria-hidden="true" data-effect={id} data-blend={program.blend ?? 'screen'}
            data-phase={phase} data-loop={loop && phase === 'play' ? 'true' : undefined}
        >
            <EffectCanvas program={program} seed={seedOf(id)} tint={t} opts={o} image={rain.image} imageRound={rain.round} running={phase === 'play'} />
        </div>
    );
};
