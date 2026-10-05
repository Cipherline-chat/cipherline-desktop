// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// matchMedia must exist BEFORE ChatPane's import graph is evaluated:
// utils/clPhysics.ts calls window.matchMedia at module load and throws under
// jsdom otherwise. Hence the dynamic import below rather than a static one.
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ReactionPill: any;

/**
 * Does the pill ACTUALLY call el.animate()?
 *
 * The add/remove/bump decision is already unit-tested as pure logic
 * (reactionAnim.test.ts), and it passes — yet no animation was visible in the
 * real app. That gap is the point of this file: it mounts the real component
 * and asserts on the DOM call, so "the logic is right" and "the animation
 * runs" stop being the same claim.
 *
 * jsdom has no Web Animations API, so Element.animate is stubbed; we only care
 * that it was invoked, with which keyframes.
 */

let root: Root | null = null;
let host: HTMLDivElement;
let animate: ReturnType<typeof vi.fn>;

const BASE = {
    emoji: '👍',
    animKey: 'msg-1:👍',
    msgId: 'msg-1',
    canReact: true,
    resolveEmoji: undefined,
    token: null,
    emojisLoading: false,
    noServerContext: false,
    onClick: () => {},
    onHoverStart: () => {},
    onHoverEnd: () => {},
    onContextMenuShow: () => {},
};

const render = (count: number, hasMine: boolean) => {
    act(() => {
        root!.render(React.createElement(ReactionPill, { ...BASE, count, hasMine }));
    });
};

beforeAll(async () => {
    ({ ReactionPill } = await import('./ChatPane'));
// 60s, not the default 10s: this pulls in ChatPane's entire import graph, which
// under a full parallel suite on a loaded box blows a 10s budget — the same
// heavy-import timeout the rnnoise specs hit. A timeout here is a load
// artifact, never a real failure.
}, 60000);

beforeEach(() => {
    animate = vi.fn(() => ({ finished: Promise.resolve(), cancel: () => {} }));
    // jsdom implements neither animate() nor matchMedia().
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.restoreAllMocks();
});


describe('a remote reaction arriving animates for a bystander', () => {
    // Mount must not animate in general (it would replay on every scroll), but
    // a reaction landing on a message already on screen IS a mount — and it is
    // the case no local-click marker can cover, because no click happened here.
    const mountFresh = (animKey: string, msgId: string) => {
        act(() => {
            root!.render(React.createElement(ReactionPill, {
                ...BASE, animKey, msgId, count: 1, hasMine: false,
            }));
        });
    };

    it('does not animate the reactions a message arrives WITH', () => {
        mountFresh('m-new:🎉', 'm-new');
        expect(animate).not.toHaveBeenCalled();
    });

    it('animates a NEW reaction on a message that was already on screen', async () => {
        // First sighting of the message: its existing reactions, no animation.
        mountFresh('m-old:👍', 'm-old');
        animate.mockClear();
        // Let the message age past the same-render-batch threshold.
        await new Promise(r => setTimeout(r, 320));
        act(() => { root!.unmount(); });
        host.remove();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        // A different emoji lands on that same, already-seen message.
        mountFresh('m-old:🔥', 'm-old');
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('does NOT re-animate the same reaction on a later re-mount (scroll)', async () => {
        mountFresh('m-scroll:👍', 'm-scroll');
        await new Promise(r => setTimeout(r, 320));
        animate.mockClear();
        act(() => { root!.unmount(); });
        host.remove();
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        mountFresh('m-scroll:👍', 'm-scroll');   // same key returning into view
        expect(animate).not.toHaveBeenCalled();
    });
});

describe('native and custom emoji occupy the SAME box', () => {
    // The bug: a native emoji rendered as an auto-height span nudged by a
    // constant, while a custom emoji got an exact square. Whether a reaction
    // looked centred therefore depended on which KIND of emoji it was.
    // Both must now produce an identical, explicitly-sized, centred box.
    const glyphOf = () => host.querySelector('button')!.children[0].children[0] as HTMLElement;

    it('gives a native emoji an explicit square, not an auto-height span', () => {
        render(1, false);   // BASE.emoji is a native emoji
        const g = glyphOf();
        expect(g.style.width).not.toBe('');
        expect(g.style.height).toBe(g.style.width);
    });

    it('centres it with flex rather than a magic translate', () => {
        render(1, false);
        const g = glyphOf();
        expect(g.style.display).toContain('flex');
        expect(g.style.alignItems).toBe('center');
        expect(g.style.justifyContent).toBe('center');
        // A hand-tuned nudge is exactly what made this kind-dependent.
        expect(g.style.transform || '').not.toContain('translateY');
    });
});

describe('pill layout is two equal centred halves', () => {
    // jsdom does no layout, so this asserts the STRUCTURE that produces the
    // centring rather than measured pixels: an exact 2-column grid with both
    // cells centred, and exactly two children so neither half can absorb the
    // other. Guards against reverting to `inline-flex ... gap-*`, which sized
    // each child to its own content and left the emoji off-centre.
    it('uses a 2-column grid with centred cells', () => {
        render(1, false);
        const btn = host.querySelector('button')!;
        expect(btn.className).toContain('grid-cols-2');
        expect(btn.className).toContain('place-items-center');
        expect(btn.className).not.toContain('gap-1');
    });

    it('has exactly two halves: glyph and count', () => {
        render(7, false);
        const btn = host.querySelector('button')!;
        expect(btn.children.length).toBe(2);
        expect(btn.children[1].textContent).toBe('7');
    });
});

describe('clicking animates immediately, without waiting for the server', () => {
    // The bug this pins: handleReact does no optimistic update, so nothing
    // about the pill changes until the echo returns. If the animation only
    // ran off that change it was hostage to latency — and for a removal that
    // empties the reaction it could never run at all, because the pill
    // unmounts. These assert the click itself animates.
    const clickPill = () => {
        const btn = host.querySelector('button');
        expect(btn, 'pill button should be rendered').not.toBeNull();
        act(() => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    };

    it('animates on click when ADDING (not yet mine)', () => {
        render(1, false);
        animate.mockClear();
        clickPill();
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('animates on click when REMOVING — the pill is about to unmount', () => {
        render(1, true);
        animate.mockClear();
        clickPill();
        expect(animate).toHaveBeenCalledTimes(1);
        // The keyframes must be the 'remove' settle (scales DOWN first), not
        // the add pop — this is the case that previously could not animate.
        const frames = animate.mock.calls[0][0] as Array<{ transform?: string }>;
        expect(frames[1].transform).toContain('scale(0.88)');
    });

    it('does not double-animate when the server echo confirms the click', () => {
        render(1, false);
        animate.mockClear();
        clickPill();
        expect(animate).toHaveBeenCalledTimes(1);
        // Echo arrives: count up AND now mine — the diff path would normally
        // fire 'add' again.
        render(2, true);
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('still animates a REMOTE bump even right after a local click', () => {
        render(1, true);
        animate.mockClear();
        clickPill();            // local, plays 'remove'
        animate.mockClear();
        render(2, true);        // someone else piles on: genuine remote bump
        expect(animate).toHaveBeenCalledTimes(1);
    });
});

describe('ReactionPill animation actually fires', () => {
    it('does NOT animate on first mount', () => {
        render(1, false);
        expect(animate).not.toHaveBeenCalled();
    });

    it('animates when YOU add to an existing reaction (hasMine false -> true)', () => {
        render(1, false);
        animate.mockClear();
        render(2, true);
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('animates when someone else piles on (count up, hasMine stays true)', () => {
        render(1, true);
        animate.mockClear();
        render(2, true);
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('animates when YOU remove (hasMine true -> false)', () => {
        render(2, true);
        animate.mockClear();
        render(1, false);
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('DOES animate when an unrelated person reacts (bystander bump)', () => {
        // Also previously asserted the bug. A viewer who has not reacted must
        // still see the pill move when someone else does — that is the whole
        // purpose of the bump.
        render(1, false);
        animate.mockClear();
        render(2, false);
        expect(animate).toHaveBeenCalledTimes(1);
    });

    it('does not animate when someone else REMOVES their reaction', () => {
        render(2, false);
        animate.mockClear();
        render(1, false);
        expect(animate).not.toHaveBeenCalled();
    });
});
