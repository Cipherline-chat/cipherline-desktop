import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Track } from 'livekit-client';
import {
    CALL_TITLE_STRIP_HEIGHT_PX,
    CONSOLE_GAP_ABOVE_STRIP_PX,
    FS_CONSOLE_COLS,
    FS_CONSOLE_CONTROL_PX,
    FS_CONSOLE_GAP_PX,
    FS_CONSOLE_MIN_CONTROL_PX,
    FS_CONSOLE_MIN_SCALE,
    FS_CONSOLE_PAD_PX,
    FS_CONSOLE_ROWS,
    STRIP_DENSE_CONTENT_PX,
    STRIP_JUSTIFY_CONTENT,
    STRIP_MAX_VIEWPORT_FRACTION,
    STRIP_MIN_HEIGHT_PX,
    STRIP_PADDING_PX,
    STRIP_ROOMY_CONTENT_PX,
    STRIP_ROOMY_HEIGHT_PX,
    STRIP_ROOMY_MAX_ITEMS,
    bestGrid,
    chooseFullscreenLayout,
    clampStripHeight,
    focusToggleMeaningful,
    fullscreenConsoleBottom,
    fullscreenConsoleBox,
    fullscreenConsoleMetrics,
    fullscreenConsoleScale,
    fullscreenTitleStripHeight,
    resolveFocus,
    stripCardSize,
    stripConsoleLaneWidthPx,
    stripDensityForHeight,
    stripHeightBounds,
    stripMetrics,
    stripMetricsAt,
    stripScrollLaneReservationPx,
    FS_CONSOLE_LANE_GAP_PX,
    FS_CONSOLE_RIGHT_INSET_PX,
    type FullscreenLayoutInput,
    type StageTileRef,
} from './fullscreenCallLayout';

const CAM = Track.Source.Camera;
const SS = Track.Source.ScreenShare;

const cam = (identity: string): StageTileRef => ({ identity, source: CAM, gated: false });
const share = (identity: string): StageTileRef => ({ identity, source: SS, gated: false });
const gate = (identity: string): StageTileRef => ({ identity, source: SS, gated: true });

const input = (over: Partial<FullscreenLayoutInput> = {}): FullscreenLayoutInput => ({
    stage: [],
    audioOnly: [],
    focused: null,
    ...over,
});

describe('chooseFullscreenLayout — the single-video rule', () => {
    it('is solo for a lone remote camera', () => {
        const layout = chooseFullscreenLayout(input({ stage: [cam('bob')] }));
        expect(layout.mode).toBe('solo');
        expect(layout.mode === 'solo' && layout.stage.identity).toBe('bob');
    });

    it('is solo for the local self-view alone — a one-cell grid and a focused\n'
        + '       view of the same stream are the same picture either way', () => {
        expect(chooseFullscreenLayout(input({ stage: [cam('me')] })).mode).toBe('solo');
    });

    it('is solo for a lone screen share', () => {
        expect(chooseFullscreenLayout(input({ stage: [share('bob')] })).mode).toBe('solo');
    });

    it('stays solo even when that one tile is the focused stream', () => {
        const layout = chooseFullscreenLayout(input({
            stage: [cam('bob')],
            focused: { identity: 'bob', source: CAM },
        }));
        expect(layout.mode).toBe('solo');
    });

    it('puts audio-only participants in the strip, not on the stage', () => {
        const layout = chooseFullscreenLayout(input({
            stage: [cam('bob')],
            audioOnly: ['carol', 'dave'],
        }));
        expect(layout.mode === 'solo' && layout.strip).toEqual([
            { kind: 'audio', identity: 'carol' },
            { kind: 'audio', identity: 'dave' },
        ]);
    });

    it('gives solo no strip at all when nobody else is in the call', () => {
        const layout = chooseFullscreenLayout(input({ stage: [cam('bob')] }));
        expect(layout.mode === 'solo' && layout.strip).toEqual([]);
    });

    it('never offers a focus toggle in solo', () => {
        expect(focusToggleMeaningful(chooseFullscreenLayout(input({ stage: [cam('bob')] })))).toBe(false);
    });
});

describe('chooseFullscreenLayout — counting what a "video" is', () => {
    it('counts the local camera alongside a remote one, so two cameras are NOT solo', () => {
        const layout = chooseFullscreenLayout(input({ stage: [cam('me'), cam('bob')] }));
        expect(layout.mode).toBe('grid');
        expect(focusToggleMeaningful(layout)).toBe(true);
    });

    it('counts an unsubscribed screen-share gate as a stage tile', () => {
        // One camera + one click-to-watch gate is two boxes on screen, so the
        // grid/focus distinction is real even though only one is moving.
        const layout = chooseFullscreenLayout(input({ stage: [gate('bob'), cam('me')] }));
        expect(layout.mode).toBe('grid');
    });

    it('is people-mode when there is no video at all', () => {
        const layout = chooseFullscreenLayout(input({ audioOnly: ['me', 'bob'] }));
        expect(layout).toEqual({ mode: 'people', people: ['me', 'bob'] });
        expect(focusToggleMeaningful(layout)).toBe(false);
    });

    it('does not treat audio-only participants as stage tiles', () => {
        // Ten silent people plus one camera is still one video.
        const audioOnly = Array.from({ length: 10 }, (_, i) => `p${i}`);
        expect(chooseFullscreenLayout(input({ stage: [cam('bob')], audioOnly })).mode).toBe('solo');
    });
});

describe('chooseFullscreenLayout — focus', () => {
    const stage = [share('bob'), cam('bob'), cam('me')];

    it('focuses the matching tile and strips the rest', () => {
        const layout = chooseFullscreenLayout(input({
            stage,
            audioOnly: ['carol'],
            focused: { identity: 'bob', source: CAM },
        }));
        expect(layout.mode).toBe('focus');
        if (layout.mode !== 'focus') return;
        expect(layout.stage).toEqual(cam('bob'));
        expect(layout.strip).toEqual([
            { kind: 'tile', tile: stage[0] },
            { kind: 'tile', tile: stage[2] },
            { kind: 'audio', identity: 'carol' },
        ]);
    });

    it('distinguishes a participant\'s camera from their own share', () => {
        const layout = chooseFullscreenLayout(input({
            stage,
            focused: { identity: 'bob', source: SS },
        }));
        expect(layout.mode === 'focus' && layout.stage.source).toBe(SS);
    });

    it('falls back to grid when the focused stream has ended', () => {
        const layout = chooseFullscreenLayout(input({
            stage,
            focused: { identity: 'ghost', source: CAM },
        }));
        expect(layout.mode).toBe('grid');
    });

    it('refuses to focus an unsubscribed gate — there is no picture to enlarge', () => {
        const layout = chooseFullscreenLayout(input({
            stage: [gate('bob'), cam('me')],
            focused: { identity: 'bob', source: SS },
        }));
        expect(layout.mode).toBe('grid');
    });

    it('collapses to solo when every other stream dies under a live focus', () => {
        // The stream that was focused is the survivor: solo, not focus.
        const layout = chooseFullscreenLayout(input({
            stage: [cam('bob')],
            focused: { identity: 'bob', source: CAM },
        }));
        expect(layout.mode).toBe('solo');
    });

    it('resolveFocus is null for a gate and for a missing stream', () => {
        expect(resolveFocus([gate('bob')], { identity: 'bob', source: SS })).toBeNull();
        expect(resolveFocus([cam('bob')], { identity: 'bob', source: SS })).toBeNull();
        expect(resolveFocus([cam('bob')], null)).toBeNull();
        expect(resolveFocus([cam('bob')], { identity: 'bob', source: CAM })).toEqual(cam('bob'));
    });

    it('grid keeps audio-only participants as their own cells, not a strip', () => {
        const layout = chooseFullscreenLayout(input({ stage: [cam('a'), cam('b')], audioOnly: ['c'] }));
        expect(layout).toEqual({ mode: 'grid', tiles: [cam('a'), cam('b')], people: ['c'] });
    });
});

describe('stripMetrics', () => {
    const TALL = 1080;

    it('reserves nothing when the strip is empty', () => {
        expect(stripMetrics(0, TALL)).toEqual({ height: 0, contentHeight: 0, density: 'dense' });
    });

    it('uses the roomy band up to the item threshold', () => {
        const m = stripMetrics(STRIP_ROOMY_MAX_ITEMS, TALL);
        expect(m.density).toBe('roomy');
        expect(m.contentHeight).toBe(STRIP_ROOMY_CONTENT_PX);
        expect(m.height).toBe(STRIP_ROOMY_CONTENT_PX + STRIP_PADDING_PX);
    });

    it('drops to the dense band one item past the threshold — contentHeight is\n'
        + '       exactly the dense card\'s own preferred size again, now that the\n'
        + '       floor is card-driven rather than console-driven (the console\n'
        + '       scales to fit instead of setting the floor — see\n'
        + '       STRIP_MIN_HEIGHT_PX / fullscreenConsoleScale)', () => {
        const m = stripMetrics(STRIP_ROOMY_MAX_ITEMS + 1, TALL);
        expect(m.density).toBe('dense');
        expect(m.contentHeight).toBe(STRIP_MIN_HEIGHT_PX - STRIP_PADDING_PX);
        expect(m.contentHeight).toBe(84); // pinned: not just self-consistent with the constant
        expect(m.contentHeight).toBe(STRIP_DENSE_CONTENT_PX);
    });

    it('does not keep shrinking as the roster grows — 8 and 40 are the same height', () => {
        // Overflow is the scrollbar's job, never the tile's. This is the whole
        // point of replacing the drag-resizable bar.
        expect(stripMetrics(8, TALL)).toEqual(stripMetrics(40, TALL));
    });

    it('never eats more than a quarter or so of the window', () => {
        const m = stripMetrics(3, TALL);
        expect(m.height).toBeLessThanOrEqual(Math.round(TALL * 0.26));
    });

    it('downgrades roomy → dense rather than clipping a large card on a short window', () => {
        // 0.26 * 520 = 135, which is under the roomy band's 140.
        const m = stripMetrics(2, 520);
        expect(m.density).toBe('dense');
        // Falls all the way to the floor (100 — the dense card's own preferred
        // size, now that the console no longer drives the floor), because 135
        // sits between that and the roomy band's 140.
        expect(m.height).toBe(STRIP_MIN_HEIGHT_PX);
        expect(m.height).toBe(100); // pinned: not just self-consistent with the constant
        expect(m.contentHeight).toBeGreaterThanOrEqual(STRIP_DENSE_CONTENT_PX);
    });

    it('holds the floor on an absurdly short window instead of clipping', () => {
        const m = stripMetrics(2, 120);
        expect(m.height).toBe(STRIP_MIN_HEIGHT_PX);
        expect(m.height).toBe(100); // pinned: not just self-consistent with the constant
        expect(m.contentHeight).toBeGreaterThanOrEqual(STRIP_DENSE_CONTENT_PX);
    });

    it('keeps contentHeight and height consistent for every roster size', () => {
        for (const n of [1, 2, 6, 7, 12, 50]) {
            const m = stripMetrics(n, TALL);
            expect(m.contentHeight).toBe(m.height - STRIP_PADDING_PX);
            expect(m.contentHeight).toBeGreaterThanOrEqual(STRIP_DENSE_CONTENT_PX);
        }
    });

    it('maps density onto a ParticipantCard size that actually fits it', () => {
        expect(stripCardSize('roomy')).toBe('large');
        expect(stripCardSize('dense')).toBe('tiny');
    });
});

// The strip is drag-resizable again (owner: "I want to be able to resize the
// bottom view ... by dragging it up and down") after having been made fixed
// for the opposite complaint ("it's resizable and the people under it often
// their icons get cut off"). Both hold only because the clamp below can never
// hand back a height a card does not fit in — which is precisely what the old
// 80px floor did, against a `large` card's ~110px need. So this clamp is the
// rule under test, not an implementation detail.
describe('clampStripHeight — the drag floor that stops avatars being clipped', () => {
    const TALL = 1080;   // cap = round(1080 * 0.26) = 281

    it('the floor is derived from whichever of the dense card and the SCALED-DOWN\n'
        + '       console needs more room — today, the card (84px + 16px strip padding\n'
        + '       = 100px, which beats the console\'s 64px + 16px = 80px)', () => {
        // 80 was the old pre-console floor and is below every CARD's real need
        // — it now coincides with the console's minimum-scale floor, which is a
        // coincidence of two unrelated derivations and not why either is right.
        //
        // The console half used to be its FULL 116 + 16 = 132 and governed, so
        // this assertion is inverted from what it used to say. That is the
        // owner's call, verbatim: "if there's not enough room then size it down
        // to make room" — the console shrinks, and the 32px it stops demanding
        // goes back to the video.
        const consoleFloor =
            Math.ceil(fullscreenConsoleBox().height * FS_CONSOLE_MIN_SCALE) + STRIP_PADDING_PX;
        const cardFloor = STRIP_DENSE_CONTENT_PX + STRIP_PADDING_PX;
        expect(consoleFloor).toBe(80);
        expect(cardFloor).toBeGreaterThan(consoleFloor);
        expect(STRIP_MIN_HEIGHT_PX).toBe(cardFloor);
        expect(STRIP_MIN_HEIGHT_PX).toBe(100);
        expect(stripMetrics(2, 120).height).toBe(STRIP_MIN_HEIGHT_PX);
    });

    it('the floor really did DROP, giving the stage back 32px of video — the\n'
        + '       point of the change, stated as a number so it cannot be undone\n'
        + '       by accident', () => {
        const oldConsoleDrivenFloor = fullscreenConsoleBox().height + STRIP_PADDING_PX; // 132
        expect(STRIP_MIN_HEIGHT_PX).toBeLessThan(oldConsoleDrivenFloor);
        expect(oldConsoleDrivenFloor - STRIP_MIN_HEIGHT_PX).toBe(32);
        // ...and the console is still not clipped down there: at the floor it
        // scales to fit the 84px of content the strip has, which is above its
        // own minimum. This is the invariant the 132 floor used to buy by
        // brute force.
        expect(fullscreenConsoleMetrics(STRIP_MIN_HEIGHT_PX).height)
            .toBeLessThanOrEqual(STRIP_MIN_HEIGHT_PX - STRIP_PADDING_PX);
        expect(fullscreenConsoleMetrics(STRIP_MIN_HEIGHT_PX).scale)
            .toBeGreaterThan(FS_CONSOLE_MIN_SCALE);
    });

    it('BELOW the floor: clamps up, never through', () => {
        expect(clampStripHeight(0, TALL)).toBe(STRIP_MIN_HEIGHT_PX);
        expect(clampStripHeight(80, TALL)).toBe(STRIP_MIN_HEIGHT_PX);
        expect(clampStripHeight(STRIP_MIN_HEIGHT_PX - 1, TALL)).toBe(STRIP_MIN_HEIGHT_PX);
        expect(clampStripHeight(-9999, TALL)).toBe(STRIP_MIN_HEIGHT_PX);
    });

    it('ABOVE the max: clamps down to the same ~26% cap the automatic height uses', () => {
        const cap = Math.round(TALL * STRIP_MAX_VIEWPORT_FRACTION);
        expect(stripHeightBounds(TALL).max).toBe(cap);
        expect(clampStripHeight(cap + 1, TALL)).toBe(cap);
        expect(clampStripHeight(99999, TALL)).toBe(cap);
    });

    it('IN RANGE: passes the dragged height straight through', () => {
        for (const h of [STRIP_MIN_HEIGHT_PX, 140, 200, Math.round(TALL * STRIP_MAX_VIEWPORT_FRACTION)]) {
            expect(clampStripHeight(h, TALL)).toBe(h);
        }
    });

    it('rounds to whole pixels — a pointer delta is not an integer', () => {
        expect(clampStripHeight(160.4, TALL)).toBe(160);
        expect(clampStripHeight(160.6, TALL)).toBe(161);
    });

    it('survives a NaN delta instead of writing NaN into a style', () => {
        expect(clampStripHeight(NaN, TALL)).toBe(STRIP_MIN_HEIGHT_PX);
        expect(clampStripHeight(Infinity, TALL)).toBe(stripHeightBounds(TALL).max);
    });

    it('on a window too short for even the floor, the floor still wins', () => {
        // 0.26 * 200 = 52, well under the floor. Overflowing by a few pixels
        // beats clipping a card — the same call stripMetrics already makes.
        const b = stripHeightBounds(200);
        expect(b.min).toBe(STRIP_MIN_HEIGHT_PX);
        expect(b.max).toBe(STRIP_MIN_HEIGHT_PX);
        expect(clampStripHeight(500, 200)).toBe(STRIP_MIN_HEIGHT_PX);
    });

    it('every clamped height can hold the card its density asks for', () => {
        // The actual no-clipping invariant, swept across the whole range.
        for (const raw of [-50, 0, 60, 99, 100, 123, 139, 140, 141, 220, 281, 282, 1000]) {
            const h = clampStripHeight(raw, TALL);
            const density = stripDensityForHeight(h);
            const needed = density === 'roomy' ? STRIP_ROOMY_HEIGHT_PX : STRIP_MIN_HEIGHT_PX;
            expect(h).toBeGreaterThanOrEqual(needed);
        }
    });

    it('density follows the HEIGHT, so dragging down shrinks the card instead of clipping it', () => {
        expect(stripDensityForHeight(STRIP_ROOMY_HEIGHT_PX)).toBe('roomy');
        expect(stripDensityForHeight(STRIP_ROOMY_HEIGHT_PX - 1)).toBe('dense');
        expect(stripCardSize(stripDensityForHeight(STRIP_MIN_HEIGHT_PX))).toBe('tiny');
    });
});

describe('stripMetricsAt — automatic until the user drags', () => {
    const TALL = 1080;

    it('with no dragged height it is exactly the automatic metrics', () => {
        for (const n of [1, 3, 6, 7, 20]) {
            expect(stripMetricsAt(n, TALL, null)).toEqual(stripMetrics(n, TALL));
        }
    });

    it('an empty strip reserves nothing, dragged height or not', () => {
        expect(stripMetricsAt(0, TALL, 240)).toEqual({ height: 0, contentHeight: 0, density: 'dense' });
    });

    it('a dragged height overrides the roster — 20 people can be roomy if you drag for it', () => {
        const m = stripMetricsAt(20, TALL, 220);
        expect(m.height).toBe(220);
        expect(m.density).toBe('roomy');
        expect(m.contentHeight).toBe(220 - STRIP_PADDING_PX);
    });

    it('a dragged height is still clamped, so no drag can clip a card', () => {
        expect(stripMetricsAt(3, TALL, 10).height).toBe(STRIP_MIN_HEIGHT_PX);
        expect(stripMetricsAt(3, TALL, 10).density).toBe('dense');
        expect(stripMetricsAt(3, TALL, 9999).height).toBe(Math.round(TALL * STRIP_MAX_VIEWPORT_FRACTION));
    });

    it('keeps contentHeight = height - padding on the dragged path too', () => {
        for (const h of [100, 140, 200, 281]) {
            const m = stripMetricsAt(4, TALL, h);
            expect(m.contentHeight).toBe(m.height - STRIP_PADDING_PX);
        }
    });
});

describe('fullscreenConsoleBox', () => {
    it('is the 3x2 block the CSS grid actually paints', () => {
        const span = (n: number) =>
            n * FS_CONSOLE_CONTROL_PX + (n - 1) * FS_CONSOLE_GAP_PX + 2 * FS_CONSOLE_PAD_PX;
        expect(fullscreenConsoleBox()).toEqual({ width: span(FS_CONSOLE_COLS), height: span(FS_CONSOLE_ROWS) });
    });

    it('is wider than tall and roughly tile-shaped — "so they fit like another video would"', () => {
        const { width, height } = fullscreenConsoleBox();
        const ratio = width / height;
        expect(ratio).toBeGreaterThan(1);
        expect(ratio).toBeLessThan(2);
    });

    it('holds every control: six of them, two rows of three', () => {
        // The console has exactly six controls (mic, deafen, camera, share,
        // fullscreen, leave) — a block that could not seat all six would drop
        // one off the bottom of the grid with no visual warning.
        expect(FS_CONSOLE_COLS * FS_CONSOLE_ROWS).toBeGreaterThanOrEqual(6);
    });
});

/**
 * ── The console ALWAYS lives in the strip ───────────────────────────────────
 *
 * Owner, with his own emphasis: "When in full screen you have it so the call
 * controls will move up into the video view instead of staying in the bottom
 * area where the other video members are. IT SHOULD ALWAYS BE DOWN THERE, and
 * if there's not enough room then size it down to make room."
 *
 * The predicate this suite used to test — `consoleDocksInStrip` — is GONE, not
 * renamed. There is no longer a height at which the console declines to dock,
 * so a predicate every caller passes would be one nobody reads. What replaces
 * it is `fullscreenConsoleScale`, and the property under test changes shape
 * accordingly: not "does it fit" but "it is made to fit, and here is what it
 * costs".
 */
describe('fullscreenConsoleScale — the console shrinks rather than floating over the video', () => {
    const NOMINAL_H = fullscreenConsoleBox().height; // 116 today
    const TALL = 1080;

    it('does not shrink at all when the strip can already hold it', () => {
        expect(fullscreenConsoleScale(STRIP_ROOMY_HEIGHT_PX, NOMINAL_H)).toBe(1);
        expect(fullscreenConsoleScale(NOMINAL_H + STRIP_PADDING_PX, NOMINAL_H)).toBe(1);
        expect(fullscreenConsoleScale(400, NOMINAL_H)).toBe(1);
    });

    it('shrinks EXACTLY to the strip\'s content height one pixel below that boundary —\n'
        + '       the whole "size it down to make room" instruction, as arithmetic', () => {
        const h = NOMINAL_H + STRIP_PADDING_PX - 1; // 131
        const scale = fullscreenConsoleScale(h, NOMINAL_H);
        expect(scale).toBeLessThan(1);
        expect(NOMINAL_H * scale).toBeCloseTo(h - STRIP_PADDING_PX);
    });

    it('FITS at every strip height the app can produce — the floor, the cap, the\n'
        + '       automatic heights and everything between, swept, not spot-checked', () => {
        const { min, max } = stripHeightBounds(TALL);
        for (let h = min; h <= max; h++) {
            const scaled = NOMINAL_H * fullscreenConsoleScale(h, NOMINAL_H);
            // The console's whole block sits inside the strip's content box.
            expect(scaled).toBeLessThanOrEqual(h - STRIP_PADDING_PX + 1e-9);
            // ...and never shrinks below what a finger or cursor can hit.
            expect(fullscreenConsoleScale(h, NOMINAL_H)).toBeGreaterThanOrEqual(FS_CONSOLE_MIN_SCALE);
        }
    });

    it('the heights that used to trigger the FLOAT fallback now dock at a reduced\n'
        + '       scale instead — this is the regression the owner reported, pinned', () => {
        // Every one of these failed the old `consoleDocksInStrip` test
        // (h - 16 < 116), so every one of them used to park a 116px block over
        // the focused video's bottom-right corner.
        for (const h of [100, 110, 120, 131]) {
            const scale = fullscreenConsoleScale(h, NOMINAL_H);
            expect(scale).toBeLessThan(1);                       // it really did have to shrink
            expect(NOMINAL_H * scale).toBeLessThanOrEqual(h - STRIP_PADDING_PX + 1e-9);
            // And it is DOCKED: its bottom offset centres it in the band
            // rather than clearing the band's top edge.
            const bottom = fullscreenConsoleBottom(h, NOMINAL_H * scale);
            expect(bottom).toBeLessThan(h);
            expect(bottom + NOMINAL_H * scale).toBeLessThanOrEqual(h + 1e-9);
        }
    });

    it('never goes below FS_CONSOLE_MIN_SCALE, and that floor is the WCAG 2.2 AA\n'
        + '       24px target size rather than a number someone liked', () => {
        expect(FS_CONSOLE_MIN_SCALE).toBe(FS_CONSOLE_MIN_CONTROL_PX / FS_CONSOLE_CONTROL_PX);
        expect(FS_CONSOLE_MIN_CONTROL_PX).toBe(24);
        // Absurdly short strips clamp AT the floor, not through it.
        for (const h of [70, 40, 17, 16, 1]) {
            expect(fullscreenConsoleScale(h, NOMINAL_H)).toBe(FS_CONSOLE_MIN_SCALE);
        }
        // Below the floor the console deliberately OVERFLOWS the band's top
        // edge instead of shrinking further. Stated explicitly so the trade is
        // a decision on record, not an accident: "ALWAYS down there" outranks
        // "always entirely inside the band", and an unpressable leave button
        // outranks both.
        const tooShort = 40;
        expect(NOMINAL_H * fullscreenConsoleScale(tooShort, NOMINAL_H))
            .toBeGreaterThan(tooShort - STRIP_PADDING_PX);
        // ...but it is still anchored at the viewport's bottom edge, never
        // pushed below it, so every control stays on screen.
        expect(fullscreenConsoleBottom(tooShort, NOMINAL_H * fullscreenConsoleScale(tooShort, NOMINAL_H)))
            .toBe(0);
    });

    it('a strip that does not exist (grid/people mode) is full size, NOT minimum —\n'
        + '       there is no band to fit into, and shrinking there would be a\n'
        + '       gratuitous regression in a mode nobody complained about', () => {
        expect(fullscreenConsoleScale(0, NOMINAL_H)).toBe(1);
        expect(fullscreenConsoleScale(-5, NOMINAL_H)).toBe(1);
        // Positive control that this branch is real: the same call WITHOUT the
        // no-strip guard would hit the floor, since 0 - 16 is negative.
        expect(FS_CONSOLE_MIN_SCALE).toBeLessThan(1);
    });

    it('a degenerate console height cannot produce Infinity or NaN', () => {
        expect(fullscreenConsoleScale(200, 0)).toBe(1);
        expect(fullscreenConsoleScale(200, -10)).toBe(1);
    });
});

describe('fullscreenConsoleMetrics — the scaled geometry published to CSS', () => {
    const NOMINAL = fullscreenConsoleBox();

    it('is the untouched nominal block whenever the strip can hold it', () => {
        const m = fullscreenConsoleMetrics(STRIP_ROOMY_HEIGHT_PX);
        expect(m.scale).toBe(1);
        expect(m.control).toBe(FS_CONSOLE_CONTROL_PX);
        expect(m.gap).toBe(FS_CONSOLE_GAP_PX);
        expect(m.pad).toBe(FS_CONSOLE_PAD_PX);
        expect(m.width).toBe(NOMINAL.width);
        expect(m.height).toBe(NOMINAL.height);
    });

    it('scales every source length by the SAME factor, so the block stays the same\n'
        + '       shape — "so they fit like another video would" has to survive shrinking', () => {
        for (const h of [100, 115, 125, 131]) {
            const m = fullscreenConsoleMetrics(h);
            expect(m.control).toBeCloseTo(FS_CONSOLE_CONTROL_PX * m.scale);
            expect(m.gap).toBeCloseTo(FS_CONSOLE_GAP_PX * m.scale);
            expect(m.pad).toBeCloseTo(FS_CONSOLE_PAD_PX * m.scale);
            expect(m.width / m.height).toBeCloseTo(NOMINAL.width / NOMINAL.height);
        }
    });

    it('the re-derived width/height really are the nominal box times the scale —\n'
        + '       this is what lets the fit guarantee be stated in terms of the scale', () => {
        for (const h of [100, 110, 120, 131, 140, 260]) {
            const m = fullscreenConsoleMetrics(h);
            const span = (n: number) => n * m.control + (n - 1) * m.gap + 2 * m.pad;
            expect(m.width).toBeCloseTo(span(FS_CONSOLE_COLS));
            expect(m.height).toBeCloseTo(span(FS_CONSOLE_ROWS));
            expect(m.width).toBeCloseTo(NOMINAL.width * m.scale);
            expect(m.height).toBeCloseTo(NOMINAL.height * m.scale);
        }
    });

    it('its controls never drop below the 24px accessibility floor, at ANY strip\n'
        + '       height the drag handle can reach', () => {
        const { min, max } = stripHeightBounds(1080);
        for (let h = min; h <= max; h++) {
            expect(fullscreenConsoleMetrics(h).control).toBeGreaterThanOrEqual(FS_CONSOLE_MIN_CONTROL_PX);
        }
    });

    it('a NARROWER console gives its unused width back to the cards — the lane\n'
        + '       reservation is fed the scaled width, not the nominal one', () => {
        const atFloor = fullscreenConsoleMetrics(STRIP_MIN_HEIGHT_PX);
        const roomy = fullscreenConsoleMetrics(STRIP_ROOMY_HEIGHT_PX);
        expect(atFloor.width).toBeLessThan(roomy.width);
        expect(stripScrollLaneReservationPx(true, atFloor.width)!)
            .toBeLessThan(stripScrollLaneReservationPx(true, roomy.width)!);
    });
});

describe('fullscreenConsoleBottom — always docked, always centred, never off-screen', () => {
    const CONSOLE_H = fullscreenConsoleBox().height; // 116 today

    it('centres the console vertically inside the strip', () => {
        const bottom = fullscreenConsoleBottom(STRIP_ROOMY_HEIGHT_PX, CONSOLE_H);
        expect(bottom).toBe(Math.round((STRIP_ROOMY_HEIGHT_PX - CONSOLE_H) / 2));
        // The docked console stays fully inside the strip band: its bottom
        // offset is non-negative and its top edge does not exceed the strip's
        // own height.
        expect(bottom).toBeGreaterThanOrEqual(0);
        expect(bottom + CONSOLE_H).toBeLessThanOrEqual(STRIP_ROOMY_HEIGHT_PX);
    });

    it('DOCKS at heights that used to float — including the old 100px card floor,\n'
        + '       which is now the real floor. The float-above-the-strip branch is gone\n'
        + '       for every strip that exists.', () => {
        for (const h of [100, 110, 120, 131, STRIP_MIN_HEIGHT_PX]) {
            const scaled = CONSOLE_H * fullscreenConsoleScale(h, CONSOLE_H);
            const bottom = fullscreenConsoleBottom(h, scaled);
            // Positive control by mutation: the OLD behaviour at these heights
            // was `h + CONSOLE_GAP_ABOVE_STRIP_PX`, i.e. the console's bottom
            // edge ABOVE the strip's top edge — over the video. Assert we are
            // nowhere near that, rather than merely asserting a number.
            expect(bottom).not.toBe(h + CONSOLE_GAP_ABOVE_STRIP_PX);
            expect(bottom).toBeLessThan(h);
            expect(bottom + scaled).toBeLessThanOrEqual(h + 1e-9);
        }
    });

    it('with no strip, keeps the pre-dock fixed offset above the viewport bottom', () => {
        // This is the grid/people-mode case, and must equal exactly what the
        // console used before docking existed — no regression there.
        expect(fullscreenConsoleBottom(0, CONSOLE_H)).toBe(CONSOLE_GAP_ABOVE_STRIP_PX);
        expect(fullscreenConsoleBottom(-1, CONSOLE_H)).toBe(CONSOLE_GAP_ABOVE_STRIP_PX);
    });

    it('never returns a NEGATIVE offset, which would push the leave button off the\n'
        + '       bottom of the screen — a console somehow taller than its band\n'
        + '       overflows the band\'s TOP edge instead', () => {
        const stripH = 120;
        const tooTall = 400; // far taller than any scale could produce
        expect(fullscreenConsoleBottom(stripH, tooTall)).toBe(0);
        // Positive control: the un-clamped centring really would go negative
        // here, so the clamp is load-bearing rather than decorative.
        expect(Math.round((stripH - tooTall) / 2)).toBeLessThan(0);
    });

    it('the docked console never lands on top of the strip\'s own top edge (the\n'
        + '       tile-overlap bug this is NOT re-introducing) — bottom offset plus\n'
        + '       console height stays within the strip at every producible height', () => {
        const { min, max } = stripHeightBounds(1080);
        for (let h = min; h <= max; h += 7) {
            const scaled = CONSOLE_H * fullscreenConsoleScale(h, CONSOLE_H);
            const bottom = fullscreenConsoleBottom(h, scaled);
            expect(bottom).toBeGreaterThanOrEqual(0);
            expect(bottom + scaled).toBeLessThanOrEqual(h + 1e-9);
        }
    });
});

/**
 * ── The strip's alignment ───────────────────────────────────────────────────
 *
 * Owner: "the video members in that lower area of the focused full screen
 * window aren't centered, they're just placed randomly it looks like off to the
 * side, have it either left align or centered in the window."
 *
 * The reasoning for choosing LEFT is in `STRIP_JUSTIFY_CONTENT`'s section
 * comment. What can be tested here is that the decision is actually WIRED —
 * a constant nobody reads is how the old `safe center` survived a rename.
 */
describe('STRIP_JUSTIFY_CONTENT — one alignment, at every width and item count', () => {
    const OVERLAY = readFileSync(
        join(__dirname, '..', 'components', 'call', 'FullscreenOverlay.tsx'), 'utf8',
    );

    it('is left-aligned', () => {
        expect(STRIP_JUSTIFY_CONTENT).toBe('flex-start');
    });

    it('is what the strip row actually renders — read from the constant, not retyped', () => {
        expect(OVERLAY).toContain('justifyContent: STRIP_JUSTIFY_CONTENT');
        expect(OVERLAY).toContain('STRIP_JUSTIFY_CONTENT,');   // imported, not shadowed
    });

    it('the old `safe center` is GONE as a DECLARATION, not merely overridden\n'
        + '       further down (it survives in prose, which is why this matches the\n'
        + '       property syntax rather than the bare words)', () => {
        // The exact bug: `safe center` is centre until the row overflows and
        // `start` after it, so the same call rendered two different layouts
        // depending on the roster.
        // Scoped to the STRIP ROW's own block — there is an unrelated
        // `justifyContent: 'stretch'` on the grid container elsewhere in this
        // file, and a whole-file match would either miss the point or fail on
        // that.
        const at = OVERLAY.indexOf('className="cl-fs-strip-row');
        expect(at).toBeGreaterThan(-1);      // never passes vacuously
        const rowStyle = OVERLAY.slice(at, OVERLAY.indexOf('}}', at));
        expect(rowStyle).toMatch(/justifyContent:\s*STRIP_JUSTIFY_CONTENT/);  // positive control
        expect(rowStyle).not.toMatch(/justifyContent:\s*['"`]/);              // no string literal
        expect(rowStyle).not.toMatch(/justify-(content-)?safe/);
    });

    it('carries NO item-count- or width-dependent branch — the property the owner\n'
        + '       actually asked for is that the rule does not change', () => {
        // `flex-start` is a constant, so this holds by construction; the
        // assertion is that it is still a constant and not, say, a ternary on
        // stripItems.length that a later change slipped in.
        expect(typeof STRIP_JUSTIFY_CONTENT).toBe('string');
        expect(OVERLAY).not.toMatch(/justifyContent:\s*[^,\n]*\?/);
    });
});

/**
 * ── Scrolling the strip ─────────────────────────────────────────────────────
 *
 * Owner: "Also if there's too many have a scroll bar."
 *
 * The row has always been `overflow-x-auto`; what it lacked was keyboard and
 * (portably) wheel reachability, and what it could not afford was a native
 * horizontal scrollbar eating ~11px off cards in a band that now also holds
 * the console. These pin the three access paths and the hidden-bar trade.
 */
describe('the strip scrolls by wheel, trackpad and keyboard, with no layout-eating bar', () => {
    const OVERLAY = readFileSync(
        join(__dirname, '..', 'components', 'call', 'FullscreenOverlay.tsx'), 'utf8',
    );
    const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');

    it('the row is still a real horizontal scroll container', () => {
        expect(OVERLAY).toContain('overflow-x-auto');
    });

    it('is a keyboard tab stop with an accessible name, and handles arrows/Home/End', () => {
        expect(OVERLAY).toContain('onKeyDown={onStripKey}');
        expect(OVERLAY).toMatch(/aria-label="Call participants"/);
        expect(OVERLAY).toMatch(/tabIndex=\{0\}[\s\S]{0,400}aria-label="Call participants"/);
        for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
            expect(OVERLAY).toContain(`e.key === '${key}'`);
        }
    });

    it('does not steal arrow keys from controls INSIDE the cards', () => {
        // Without this guard, focusing a control in a participant card and
        // pressing Left would scroll the strip instead of working the control.
        expect(OVERLAY).toContain('if (e.target !== e.currentTarget) return;');
    });

    it('maps the wheel onto horizontal scroll explicitly rather than relying on\n'
        + '       Chromium\'s implicit vertical-to-horizontal mapping', () => {
        expect(OVERLAY).toContain('onWheel={onStripWheel}');
        expect(OVERLAY).toContain('el.scrollLeft += delta');
        // Takes whichever axis the device actually moved, so a trackpad's
        // deltaX and a mouse wheel's deltaY both land.
        expect(OVERLAY).toContain('Math.abs(e.deltaX) > Math.abs(e.deltaY)');
    });

    it('does not swallow the wheel when there is nothing to scroll', () => {
        expect(OVERLAY).toContain('if (el.scrollWidth <= el.clientWidth) return;');
    });

    it('hides the native bar — it is laid out INSIDE the container and would eat\n'
        + '       card height in a band whose floor is now 100px', () => {
        const row = CSS.slice(CSS.indexOf('.cl-fs-strip-row {'));
        expect(row).toMatch(/scrollbar-width:\s*none/);
        expect(CSS).toMatch(/\.cl-fs-strip-row::-webkit-scrollbar\s*\{[^}]*display:\s*none/);
        // It must NOT be wearing the app's standard visible-bar class any more.
        const stripBlock = OVERLAY.slice(OVERLAY.indexOf('cl-fs-strip-row'));
        expect(stripBlock.slice(0, 200)).not.toContain('custom-scrollbar');
    });

    it('replaces the bar with a scroll cue that cannot disagree with scrollLeft', () => {
        // The `local`/`scroll` background-attachment pair IS the state: there
        // is no class to toggle, so the cue cannot drift out of sync the way a
        // JS-managed one would.
        const row = CSS.slice(CSS.indexOf('.cl-fs-strip-row {'), CSS.indexOf('.cl-fs-strip-row::-webkit-scrollbar'));
        expect(row).toContain('no-repeat local');
        expect(row).toContain('no-repeat scroll');
    });

    it('a focusable row has a VISIBLE focus ring — an invisible tab stop is a trap', () => {
        expect(CSS).toMatch(/\.cl-fs-strip-row:focus-visible\s*\{[^}]*box-shadow:/);
    });

    it('honours prefers-reduced-motion for the smooth scroll', () => {
        const rm = CSS.slice(CSS.indexOf('prefers-reduced-motion: reduce'));
        expect(rm).toMatch(/\.cl-fs-strip-row\s*\{[^}]*scroll-behavior:\s*auto/);
    });
});

describe('stripConsoleLaneWidthPx / stripScrollLaneReservationPx — narrowing the strip\'s\n'
    + '    scroll CONTAINER (not just its trailing padding) so a docked console can never\n'
    + '    have a card painted underneath it', () => {
    const CONSOLE_W = fullscreenConsoleBox().width; // 168 today

    it('sums the console\'s width, its viewport right-inset, AND the sub-pixel safety gap\n'
        + '       — not just width + inset, which a DOM harness measurement showed can leave a\n'
        + '       tile\'s clipped edge a fraction of a pixel INTO the console\'s rect (16:9\n'
        + '       aspect-ratio flex sizing rarely lands on an integer)', () => {
        expect(stripConsoleLaneWidthPx(CONSOLE_W))
            .toBe(CONSOLE_W + FS_CONSOLE_RIGHT_INSET_PX + FS_CONSOLE_LANE_GAP_PX);
    });

    it('is NOT computed from CONSOLE_GAP_ABOVE_STRIP_PX — that is a vertical gap for the\n'
        + '       unrelated float-above-the-strip case, and the two constants only happen to\n'
        + '       both be 20 today; this pins FS_CONSOLE_RIGHT_INSET_PX specifically so the two\n'
        + '       cannot silently be conflated if either changes', () => {
        // A mutation that swapped in CONSOLE_GAP_ABOVE_STRIP_PX would still pass a
        // same-value check today (both are 20) — so pin the INSET constant's own
        // value instead, which fails the moment the wrong constant is used AND its
        // value happens to differ, and documents the intended source explicitly.
        expect(FS_CONSOLE_RIGHT_INSET_PX).toBe(20);
        expect(stripConsoleLaneWidthPx(0)).toBe(FS_CONSOLE_RIGHT_INSET_PX + FS_CONSOLE_LANE_GAP_PX);
    });

    it('scales linearly with console width — a wider console reserves a wider lane,\n'
        + '       one-for-one', () => {
        const base = stripConsoleLaneWidthPx(CONSOLE_W);
        expect(stripConsoleLaneWidthPx(CONSOLE_W + 50)).toBe(base + 50);
    });

    it('reservation is APPLIED (a defined px number) when docked', () => {
        const reservation = stripScrollLaneReservationPx(true, CONSOLE_W);
        expect(reservation).toBe(stripConsoleLaneWidthPx(CONSOLE_W));
        expect(reservation).not.toBeUndefined();
    });

    it('reservation is ABSENT (undefined — the container keeps its default full width)\n'
        + '       when NOT docked, e.g. grid/people mode or a strip too short to hold the\n'
        + '       console', () => {
        expect(stripScrollLaneReservationPx(false, CONSOLE_W)).toBeUndefined();
    });

    it('the real console box reserves 200px today (168 + 20 + 12) — a concrete regression\n'
        + '       pin, not just the formula shape above', () => {
        expect(stripConsoleLaneWidthPx(CONSOLE_W)).toBe(200);
    });
});

describe('bestGrid', () => {
    it('is 1x1 for a single tile', () => {
        expect(bestGrid(1, 1920, 1080)).toEqual({ cols: 1, rows: 1 });
    });

    it('prefers a single row on an ultrawide box', () => {
        expect(bestGrid(3, 5120, 1440)).toEqual({ cols: 3, rows: 1 });
    });

    it('prefers 2x2 for four tiles on a 16:9 box', () => {
        expect(bestGrid(4, 1920, 1080)).toEqual({ cols: 2, rows: 2 });
    });

    it('stacks vertically on a tall narrow box', () => {
        expect(bestGrid(2, 600, 1600)).toEqual({ cols: 1, rows: 2 });
    });

    it('always produces enough cells for every tile', () => {
        for (let n = 1; n <= 16; n++) {
            const { cols, rows } = bestGrid(n, 1600, 900);
            expect(cols * rows).toBeGreaterThanOrEqual(n);
        }
    });

    it('falls back to the column ladder before the box is measured', () => {
        expect(bestGrid(1, 0, 0)).toEqual({ cols: 1, rows: 1 });
        expect(bestGrid(4, 0, 0)).toEqual({ cols: 2, rows: 2 });
        expect(bestGrid(9, 0, 0)).toEqual({ cols: 3, rows: 3 });
        expect(bestGrid(10, 0, 0)).toEqual({ cols: 4, rows: 3 });
    });

    it('treats a zero/negative count as one tile rather than dividing by nothing', () => {
        expect(bestGrid(0, 1920, 1080)).toEqual({ cols: 1, rows: 1 });
        expect(bestGrid(-3, 1920, 1080)).toEqual({ cols: 1, rows: 1 });
    });
});

describe('fullscreenTitleStripHeight', () => {
    it('is the app titlebar height (34px) when the OS window still has chrome', () => {
        expect(fullscreenTitleStripHeight(false)).toBe(CALL_TITLE_STRIP_HEIGHT_PX);
        expect(CALL_TITLE_STRIP_HEIGHT_PX).toBe(34);
    });

    it('collapses to 0 once the OS has taken the window itself fullscreen', () => {
        // No titlebar, no window buttons left to relocate — a rendered strip
        // there would just be a dead band eating into the video.
        expect(fullscreenTitleStripHeight(true)).toBe(0);
    });
});

describe('fullscreenConsoleBottom — centring is a property of the height it is GIVEN', () => {
    // FullscreenOverlay now hands this the console's MEASURED height rather
    // than the nominal `fullscreenConsoleBox().height`, because the nominal
    // figure is a claim about what CSS will paint and not an observation of it:
    // if the rendered block is ever a different height, centring off the
    // constant is wrong by exactly half the difference, silently, and no test
    // on the constant can catch it. These lock the property that makes that
    // call site correct — the function centres WHATEVER height it is given,
    // not just 116 — so the measurement becomes the only thing that has to be
    // right.
    const centreOf = (stripH: number, consoleH: number) =>
        fullscreenConsoleBottom(stripH, consoleH) + consoleH / 2;

    it('centres the console on the strip band for every (strip, console) pair that fits', () => {
        for (const consoleH of [80, 100, 116, 130, 168]) {
            for (const stripH of [consoleH + STRIP_PADDING_PX, 140, 160, 200, 251, 300, 421]) {
                // Skip the pairs where the console is taller than its band —
                // those are the clamped-at-0 overflow case, covered separately
                // above; centring is not claimed there.
                if (stripH < consoleH) continue;
                // The strip band runs [0, stripH] above the viewport's bottom
                // edge, and the console is `position: fixed` in that same
                // reference frame — so "centred in the strip" is exactly
                // "console centre === stripH / 2". Half a pixel of slack for
                // the function's own Math.round; odd strip heights are in the
                // sweep on purpose.
                expect(Math.abs(centreOf(stripH, consoleH) - stripH / 2)).toBeLessThanOrEqual(0.5);
            }
        }
    });

    it('a console TALLER than its nominal box is still centred, not parked half a block high', () => {
        // The concrete failure this guards, reproduced in a DOM harness while
        // investigating the owner's report: a 130px-tall block centred off the
        // nominal 116 sits 7px above centre at EVERY strip height — a constant
        // offset that reads as "not quite centred" and never self-corrects on
        // resize, because resizing re-runs the same wrong arithmetic.
        const stripH = 250;
        const nominal = FS_CONSOLE_ROWS * FS_CONSOLE_CONTROL_PX
            + (FS_CONSOLE_ROWS - 1) * FS_CONSOLE_GAP_PX + 2 * FS_CONSOLE_PAD_PX;
        const real = nominal + 14;
        const wrong = fullscreenConsoleBottom(stripH, nominal) + real / 2; // centred off the constant
        const right = centreOf(stripH, real);                             // centred off the measurement
        expect(Math.abs(right - stripH / 2)).toBeLessThanOrEqual(0.5);
        // Positive control: the mis-centring being fixed is real and this
        // sweep would not pass by accident.
        expect(Math.abs(wrong - stripH / 2)).toBeCloseTo(7, 5);
    });

    /**
     * ── The whole chain, at the strips the focused view REALLY produces ─────
     *
     * The sweep above proves `fullscreenConsoleBottom` centres whatever it is
     * given; these prove that what FullscreenOverlay actually gives it is
     * always a height that centres. The overlay's chain is:
     *
     *   stripItems.length, windowHeight - titleStripHeight, dragHeight
     *     -> stripMetricsAt(...)          -> strip.height
     *     -> fullscreenConsoleMetrics(strip.height).height  (the SCALED block)
     *     -> fullscreenConsoleBottom(strip.height, measuredConsoleH)
     *     -> --cl-fs-console-bottom
     *
     * and the console is `position: fixed`, so the viewport's bottom edge IS
     * the strip's bottom edge and "bottom offset + half the console" is
     * literally the console's centre in the strip band. Nothing here is
     * hypothetical: every strip height below is one this chain can emit.
     *
     * The height fed in is now the SCALED one, which is what makes the
     * "always fits" claim true by construction rather than by the strip floor
     * happening to exceed 132.
     */
    it('every strip a solo/focus view can produce docks, fits AND centres the console', () => {
        // Real window heights: a laptop, 1080p, 1440p, 4K, and a deliberately
        // squat window where STRIP_MAX_VIEWPORT_FRACTION binds instead of the
        // preferred band.
        for (const windowH of [500, 720, 900, 1080, 1440, 2160]) {
            for (const titleH of [0, CALL_TITLE_STRIP_HEIGHT_PX]) {
                const viewport = windowH - titleH;
                const { min, max } = stripHeightBounds(viewport);
                // itemCount 1..12 covers both density bands (STRIP_ROOMY_MAX_ITEMS
                // is 6); drag positions cover "never dragged" plus both clamped
                // extremes and the midpoint.
                for (let itemCount = 1; itemCount <= 12; itemCount++) {
                    for (const drag of [null, min, max, Math.round((min + max) / 2), min - 999, max + 999]) {
                        const { height } = stripMetricsAt(itemCount, viewport, drag);
                        const scaled = fullscreenConsoleMetrics(height).height;
                        // 1. The strip always has room for the console, because
                        //    the console is always made to fit it.
                        expect(scaled).toBeLessThanOrEqual(height - STRIP_PADDING_PX + 1e-9);
                        // 2. ...and the console lands centred in it.
                        const centre = centreOf(height, scaled);
                        expect(Math.abs(centre - height / 2)).toBeLessThanOrEqual(0.5);
                        // 3. ...fully inside the band, never poking out of either edge.
                        const bottom = fullscreenConsoleBottom(height, scaled);
                        expect(bottom).toBeGreaterThanOrEqual(0);
                        expect(bottom + scaled).toBeLessThanOrEqual(height + 1e-9);
                        // 4. ...and it never scaled past the accessibility floor
                        //    to achieve any of that.
                        expect(fullscreenConsoleMetrics(height).control)
                            .toBeGreaterThanOrEqual(FS_CONSOLE_MIN_CONTROL_PX);
                    }
                }
            }
        }
    });

    it('re-centres on EVERY frame of a resize drag, not just at the ends', () => {
        // "It needs to stay centred too when it is resized." The drag handler
        // calls clampStripHeight on each pointermove and re-publishes the
        // offset, so centring holds at every intermediate height rather than
        // being a property of the two resting positions.
        const viewport = 1080;
        const { min, max } = stripHeightBounds(viewport);
        for (let raw = min - 40; raw <= max + 40; raw += 7) {
            const height = clampStripHeight(raw, viewport);
            const scaled = fullscreenConsoleMetrics(height).height;
            const centre = centreOf(height, scaled);
            expect(Math.abs(centre - height / 2)).toBeLessThanOrEqual(0.5);
        }
    });

    it('POSITIVE CONTROL — centring off the NOMINAL height instead of the scaled\n'
        + '       one is detectably wrong at the strip floor, so the sweep above is\n'
        + '       not passing vacuously', () => {
        // The mutation a careless refactor would make: keep handing
        // `fullscreenConsoleBox().height` to fullscreenConsoleBottom after the
        // block started scaling. At the floor the block is 84 tall, not 116, so
        // this parks it 16px below centre — and, worse, clamps to 0 and pins it
        // to the viewport's bottom edge rather than centring at all.
        const height = STRIP_MIN_HEIGHT_PX;             // 100
        const nominal = fullscreenConsoleBox().height;  // 116
        const scaled = fullscreenConsoleMetrics(height).height; // 84
        expect(scaled).toBeLessThan(nominal);
        const right = fullscreenConsoleBottom(height, scaled) + scaled / 2;
        const wrong = fullscreenConsoleBottom(height, nominal) + scaled / 2;
        expect(Math.abs(right - height / 2)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(wrong - height / 2)).toBeGreaterThan(0.5);
    });
});
