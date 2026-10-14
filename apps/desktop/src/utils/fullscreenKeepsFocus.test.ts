import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Track } from 'livekit-client';
import {
    chooseFullscreenLayout,
    focusAfterFullscreenToggle,
    sameFocus,
    type FocusRef,
    type FullscreenLayoutInput,
    type StageTileRef,
} from './fullscreenCallLayout';
import { pickNextFocus, type FocusCandidate } from './pickNextFocus';

/**
 * Owner: "When you have a non-fullscreen focused video and go to full screen,
 * I want it to have the focused full screen window."
 *
 * The layout is a function of (stage, audioOnly, focused); what changed is the
 * `focused` that fullscreen opens with. These tests drive the same two-step the
 * overlay does — apply `focusAfterFullscreenToggle`, then `chooseFullscreenLayout`
 * — so a regression to "clear focus on entry" shows up as a grid where a
 * focused stage was expected.
 */

const CAM = Track.Source.Camera;
const SS = Track.Source.ScreenShare;

const cam = (identity: string): StageTileRef => ({ identity, source: CAM, gated: false });
const share = (identity: string): StageTileRef => ({ identity, source: SS, gated: false });
const gate = (identity: string): StageTileRef => ({ identity, source: SS, gated: true });
const ref = (t: StageTileRef): FocusRef => ({ identity: t.identity, source: t.source });

const input = (over: Partial<FullscreenLayoutInput> = {}): FullscreenLayoutInput => ({
    stage: [],
    audioOnly: [],
    focused: null,
    ...over,
});

/** Enter fullscreen from a docked view whose focus is `docked`. */
function enter(docked: FocusRef | null, stage: StageTileRef[], audioOnly: string[] = []) {
    const focused = focusAfterFullscreenToggle(true, docked);
    return { focused, layout: chooseFullscreenLayout(input({ stage, audioOnly, focused })) };
}

const ROOM = [share('amy'), cam('bob'), cam('carol'), cam('me')];

describe('entering fullscreen while a stream is focused', () => {
    it('opens in FOCUSED layout on the same stream, everything else in the strip', () => {
        const { focused, layout } = enter(ref(cam('bob')), ROOM, ['dave']);
        expect(focused).toEqual({ identity: 'bob', source: CAM });
        expect(layout.mode).toBe('focus');
        if (layout.mode !== 'focus') return;
        expect(layout.stage).toEqual(cam('bob'));
        expect(layout.strip).toEqual([
            { kind: 'tile', tile: share('amy') },
            { kind: 'tile', tile: cam('carol') },
            { kind: 'tile', tile: cam('me') },
            { kind: 'audio', identity: 'dave' },
        ]);
    });

    it('keeps the SOURCE too — a focused share opens on the share, not the sharer\'s camera', () => {
        const stage = [share('bob'), cam('bob'), cam('me')];
        const { layout } = enter({ identity: 'bob', source: SS }, stage);
        expect(layout.mode === 'focus' && layout.stage).toEqual(share('bob'));
    });

    it('works for your own focused self-view', () => {
        const { layout } = enter(ref(cam('me')), ROOM);
        expect(layout.mode === 'focus' && layout.stage).toEqual(cam('me'));
    });

    it('is solo (not grid) when the focused stream is the only video', () => {
        const { focused, layout } = enter(ref(cam('bob')), [cam('bob')], ['carol']);
        expect(focused).toEqual(ref(cam('bob')));
        expect(layout).toEqual({ mode: 'solo', stage: cam('bob'), strip: [{ kind: 'audio', identity: 'carol' }] });
    });

    // NEGATIVE CONTROL — the pre-fix overlay ran `if (isFullscreen)
    // setFocusedStream(null)` on entry, i.e. `focusAfterFullscreenToggle(true, x)
    // === null`. Under that rule this lands on the grid and fails.
    it('does NOT drop the focus on entry (the old behaviour opened the grid)', () => {
        const { focused, layout } = enter(ref(cam('bob')), ROOM);
        expect(focused).not.toBeNull();
        expect(layout.mode).not.toBe('grid');
    });
});

describe('entering fullscreen with nothing focused — unchanged default', () => {
    it('several videos → grid', () => {
        const { focused, layout } = enter(null, ROOM, ['dave']);
        expect(focused).toBeNull();
        expect(layout).toEqual({ mode: 'grid', tiles: ROOM, people: ['dave'] });
    });

    it('one video → solo', () => {
        expect(enter(null, [cam('bob')]).layout.mode).toBe('solo');
    });

    it('no video → people', () => {
        expect(enter(null, [], ['bob', 'carol']).layout).toEqual({ mode: 'people', people: ['bob', 'carol'] });
    });

    it('a docked focus that cannot be a fullscreen stage (an unwatched gate) falls back to the grid', () => {
        const stage = [gate('amy'), cam('bob')];
        expect(enter({ identity: 'amy', source: SS }, stage).layout.mode).toBe('grid');
    });
});

describe('leaving fullscreen — the docked view keeps what is focused at that moment', () => {
    const exit = (inFullscreen: FocusRef | null) => focusAfterFullscreenToggle(false, inFullscreen);

    it('untouched: the stream you entered with is still focused', () => {
        const entered = enter(ref(cam('bob')), ROOM).focused;
        expect(exit(entered)).toEqual(ref(cam('bob')));
    });

    it('switched inside fullscreen: the NEW pick is kept, not the pre-fullscreen one', () => {
        enter(ref(cam('bob')), ROOM);
        const picked = ref(share('amy')); // user clicked Amy's share in the strip
        expect(exit(picked)).toEqual(ref(share('amy')));
    });

    it('went back to the grid inside fullscreen: nothing is focused afterwards', () => {
        enter(ref(cam('bob')), ROOM);
        expect(exit(null)).toBeNull();
    });

    it('nothing focused in, nothing focused out', () => {
        expect(exit(enter(null, ROOM).focused)).toBeNull();
    });
});

describe('the focused participant leaves mid-fullscreen', () => {
    // FocusedStreamBanner owns the auto-advance (it stays mounted under the
    // overlay); it feeds pickNextFocus the live candidates. Reproduce that hop.
    const cand = (t: StageTileRef, publishedAt: number, isLocal = false): FocusCandidate =>
        ({ identity: t.identity, source: t.source as FocusCandidate['source'], publishedAt, isLocal });

    const losing = ref(cam('bob'));
    const after = [share('amy'), cam('carol'), cam('me')];
    const liveCandidates = [cand(share('amy'), 1), cand(cam('carol'), 2), cand(cam('me'), 3, true)];

    it('before the advance lands, the dead focus resolves to the grid — never an empty stage', () => {
        const layout = chooseFullscreenLayout(input({ stage: after, focused: losing }));
        expect(layout.mode).toBe('grid');
    });

    it('the advance moves the focused stage to the next live stream (a share first)', () => {
        const next = pickNextFocus(liveCandidates, losing);
        expect(next && { identity: next.identity, source: next.source }).toEqual(ref(share('amy')));
        const layout = chooseFullscreenLayout(input({ stage: after, focused: next }));
        expect(layout.mode === 'focus' && layout.stage).toEqual(share('amy'));
    });

    it('a just-picked focus that dies closes instead (null) → grid', () => {
        // FocusedStreamBanner: isRecentManualFocus() ? null : pickNextFocus(...)
        const layout = chooseFullscreenLayout(input({ stage: after, focused: null }));
        expect(layout.mode).toBe('grid');
    });

    it('with one video left, the survivor is solo whatever the focus says', () => {
        const next = pickNextFocus([cand(cam('carol'), 2)], losing);
        const layout = chooseFullscreenLayout(input({ stage: [cam('carol')], focused: next }));
        expect(layout.mode).toBe('solo');
    });

    it('only your own camera left: nothing remote to advance to, so solo on the self-view', () => {
        const next = pickNextFocus([cand(cam('me'), 3, true)], losing);
        expect(next).toBeNull();
        expect(chooseFullscreenLayout(input({ stage: [cam('me')], focused: next })).mode).toBe('solo');
    });
});

describe('sameFocus', () => {
    it('compares identity AND source, and treats two nulls as equal', () => {
        expect(sameFocus(null, null)).toBe(true);
        expect(sameFocus(ref(cam('bob')), null)).toBe(false);
        expect(sameFocus(null, ref(cam('bob')))).toBe(false);
        expect(sameFocus(ref(cam('bob')), { identity: 'bob', source: CAM })).toBe(true);
        expect(sameFocus(ref(cam('bob')), ref(share('bob')))).toBe(false);
    });
});

describe('FullscreenOverlay wiring (source-level: the overlay needs a live room to render)', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'call', 'FullscreenOverlay.tsx'), 'utf8');

    it('no longer clears focus when fullscreen opens', () => {
        // The exact pre-fix line, and any reformatting of it.
        expect(src).not.toMatch(/if\s*\(\s*isFullscreen\s*\)\s*callCtx\.setFocusedStream\(\s*null\s*\)/);
    });

    it('routes the toggle through focusAfterFullscreenToggle, only on a real toggle', () => {
        const at = src.indexOf('focusAfterFullscreenToggle(isFullscreen, focusedStream)');
        expect(at).toBeGreaterThan(-1);
        const eff = src.slice(src.lastIndexOf('useEffect(', at), at + 200);
        expect(eff).toContain('if (prevFullscreenRef.current === isFullscreen) return;');
        expect(eff).toMatch(/if \(!sameFocus\(next, focusedStream\)\) callCtx\.setFocusedStream\(next\);/);
        // Above the early return, like every other hook in the component.
        expect(at).toBeLessThan(src.indexOf('if (!isFullscreen) return null;'));
    });

    it('still renders the stage as a focused view (zoom / annotation / high layer)', () => {
        expect(src).toMatch(/<VideoTile[\s\S]{0,200}isFocusedView=\{true\}/);
    });
});
