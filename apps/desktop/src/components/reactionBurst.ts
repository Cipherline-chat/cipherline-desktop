/**
 * The little burst a reaction chip does when it piles up to ten
 * (ChatPane.tsx's ReactionPill). The decision lives in reactionAnim.ts
 * (`crossedPileUp`, `createPileUpGate`); this is only the drawing.
 *
 * A soft ring that opens from the chip and eight specks that fly outward and
 * fade, plus a firmer pop of the chip itself. Web Animations on transform and
 * opacity only (compositor-only, no layout), on throwaway elements that remove
 * themselves when their animation ends. Once per crossing, so at most one
 * burst is ever alive per chip. A no-op under reduced motion and where
 * `Element.animate` does not exist (jsdom).
 */

export const BURST_SPECKS = 8;
export const BURST_MS = 620;

export interface BurstOptions {
    /** The chip's wrapper: positioned (`position: relative`), the burst's coordinate space. */
    host: HTMLElement | null;
    /** The chip button itself, for the pop. */
    chip: HTMLElement | null;
    reduced: boolean;
}

/** Plays the burst. Returns how many animations it started (0 = skipped). */
export function burstReactionPill({ host, chip, reduced }: BurstOptions): number {
    if (reduced || !host || typeof host.animate !== 'function') return 0;
    const doc = host.ownerDocument;
    const w = host.offsetWidth || 48;
    const h = host.offsetHeight || 28;
    let started = 0;

    const own = (el: HTMLElement) => {
        el.setAttribute('aria-hidden', 'true');
        el.style.position = 'absolute';
        el.style.pointerEvents = 'none';
        host.appendChild(el);
        return el;
    };
    const run = (el: HTMLElement, frames: Keyframe[], opts: KeyframeAnimationOptions) => {
        const a = el.animate(frames, { fill: 'forwards', ...opts });
        started++;
        const done = () => el.remove();
        a.addEventListener?.('finish', done);
        a.addEventListener?.('cancel', done);
        // Belt and braces: never leave debris if a finish event is dropped.
        setTimeout(done, (opts.duration as number) + (opts.delay as number ?? 0) + 200);
    };

    const ring = own(doc.createElement('span'));
    Object.assign(ring.style, {
        left: '0', top: '0', width: `${w}px`, height: `${h}px`, borderRadius: '999px',
        border: '2px solid var(--cl-lume, #25E0C8)', boxSizing: 'border-box',
    });
    run(ring, [
        { transform: 'scale(0.9)', opacity: 0.75 },
        { transform: 'scale(1.7, 2.1)', opacity: 0 },
    ], { duration: BURST_MS - 120, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });

    for (let i = 0; i < BURST_SPECKS; i++) {
        const angle = (Math.PI * 2 * i) / BURST_SPECKS + (i % 2 ? 0.2 : -0.1);
        const reach = (i % 2 ? 26 : 38);
        const dx = Math.cos(angle) * reach * 1.25;
        const dy = Math.sin(angle) * reach;
        const speck = own(doc.createElement('span'));
        Object.assign(speck.style, {
            left: `${w / 2 - 2.5}px`, top: `${h / 2 - 2.5}px`, width: '5px', height: '5px', borderRadius: '50%',
            background: i % 3 === 0 ? 'var(--cl-glow, #FFC94D)' : 'var(--cl-lume, #25E0C8)',
        });
        run(speck, [
            { transform: 'translate(0, 0) scale(0.6)', opacity: 1 },
            { transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(1)`, opacity: 1, offset: 0.6 },
            { transform: `translate(${(dx * 1.15).toFixed(1)}px, ${(dy * 1.15).toFixed(1)}px) scale(0.2)`, opacity: 0 },
        ], { duration: BURST_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    }

    if (chip && typeof chip.animate === 'function') {
        chip.animate([
            { transform: 'scale(1)' },
            { transform: 'scale(1.32)', offset: 0.35 },
            { transform: 'scale(0.96)', offset: 0.65 },
            { transform: 'scale(1)' },
        ], { duration: 420, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
        started++;
    }
    return started;
}
