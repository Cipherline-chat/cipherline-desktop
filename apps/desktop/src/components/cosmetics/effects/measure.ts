/** Where a card's avatar is, for the effect engine (EffectCanvas.tsx). */

/**
 * Where the avatar is, in the effect host's own CSS px (the host fills the
 * card's padding box). Every card marks its avatar box: `[data-fx-avatar]`,
 * or the decoration host inside `[data-hx-layer="avatar"]`.
 *
 * Measured from LAYOUT (offsetLeft / offsetTop up the offsetParent chain),
 * not getBoundingClientRect: the preview's avatar mounts mid-entrance
 * (translateY(14px) scale(.82)) and the popover itself scales in, and a rect
 * taken then put the sonar's origin 14 px low for good (owner: "the sonar
 * ping doesn't ping centered on the profile pic"). Layout ignores transforms,
 * so this is where the avatar comes to rest. Falls back to rects, corrected
 * for a uniform scale, when the chain does not reach the card.
 */
export const FX_AVATAR_SELECTOR = '[data-fx-avatar], [data-hx-layer="avatar"] .pc-deco-host, [data-hx-layer="avatar"] button';
export function measureAvatar(card: HTMLElement | null, w: number, h: number): { x: number; y: number; r: number; banner: number } {
    // No profile card around it (a picker thumbnail): centre everything on the host itself, so
    // effects that orbit or radiate from the avatar stay inside a 76x48 tile.
    const fallback = h < 200 ? { x: w / 2, y: h / 2, r: Math.min(w, h) * 0.3, banner: h * 0.4 } : { x: w / 2, y: 110, r: 46, banner: 112 };
    if (!card) return fallback;
    const av = card.querySelector(FX_AVATAR_SELECTOR) as HTMLElement | null;
    const bn = card.querySelector('[data-hx-layer="banner"], .pcd-banner, .pfp-banner') as HTMLElement | null;
    const out = { ...fallback };
    const inCard = (el: HTMLElement): { x: number; y: number } | null => {
        let x = 0, y = 0;
        let cur: HTMLElement | null = el;
        while (cur && cur !== card) {
            x += cur.offsetLeft; y += cur.offsetTop;
            const parent = cur.offsetParent as HTMLElement | null;
            if (parent && parent !== card) { x += parent.clientLeft; y += parent.clientTop; }
            cur = parent;
        }
        return cur === card ? { x, y } : null;
    };
    const scale = (): number => {
        const cr = card.getBoundingClientRect();
        return card.offsetWidth > 0 && cr.width > 0 ? cr.width / card.offsetWidth : 1;
    };
    if (av && av.offsetWidth > 0) {
        const p = inCard(av);
        if (p) {
            out.x = p.x + av.offsetWidth / 2; out.y = p.y + av.offsetHeight / 2; out.r = av.offsetWidth / 2;
        } else {
            const cr = card.getBoundingClientRect(), r = av.getBoundingClientRect(), k = scale();
            out.x = (r.left - cr.left) / k - card.clientLeft + r.width / k / 2;
            out.y = (r.top - cr.top) / k - card.clientTop + r.height / k / 2;
            out.r = r.width / k / 2;
        }
    }
    if (bn && bn.offsetHeight > 0) {
        const p = inCard(bn);
        if (p) out.banner = p.y + bn.offsetHeight;
        else {
            const cr = card.getBoundingClientRect(), r = bn.getBoundingClientRect();
            out.banner = (r.bottom - cr.top) / scale() - card.clientTop;
        }
    }
    return out;
}
