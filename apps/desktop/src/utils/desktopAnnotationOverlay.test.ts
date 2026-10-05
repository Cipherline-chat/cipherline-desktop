import { describe, it, expect, vi, afterEach } from 'vitest';
import { diffForOverlay } from './desktopAnnotationOverlay';
import type { Stroke } from './annotationStore';

/**
 * `n` points. A live stroke's `points` array only ever grows — nothing is
 * trimmed off the head any more — so the overlay cursor is a plain index into
 * it, and these fixtures no longer have to simulate a shrinking array.
 */
const stroke = (id: string, n: number, extra: Partial<Stroke> = {}): Stroke => ({
    id, by: 'me', color: '#25E0C8', width: 4,
    points: Array.from({ length: n }, (_, i) => ({ x: i / 10, y: i / 10 })),
    updatedAt: 1000 + n * 10,
    closedAt: 0,
    ...extra,
});

describe('diffForOverlay', () => {
    it('sends a new stroke whole, then only its appended points', () => {
        const state = new Map();
        const d1 = diffForOverlay([stroke('a', 2)], state);
        expect(d1?.upsert?.map(s => s.id)).toEqual(['a']);
        expect(d1?.upsert?.[0].points).toHaveLength(2);
        expect(d1?.append).toBeUndefined();

        const d2 = diffForOverlay([stroke('a', 5)], state);
        expect(d2?.upsert).toBeUndefined();
        expect(d2?.append).toHaveLength(1);
        expect(d2?.append?.[0].points).toHaveLength(3);
        expect(d2?.append?.[0].points[0]).toEqual({ x: 0.2, y: 0.2 });
    });

    it('carries the two clocks the overlay ages on', () => {
        // The overlay runs its OWN watchdog and its own fade rather than being
        // told what to remove, so both stamps have to ride on every delta or it
        // freezes on whatever frame it was last sent.
        const state = new Map();
        const up = diffForOverlay([stroke('a', 2, { updatedAt: 4242 })], state);
        expect(up?.upsert?.[0]).toMatchObject({ updatedAt: 4242, closedAt: 0 });
        const ap = diffForOverlay([stroke('a', 4, { updatedAt: 5555 })], state);
        expect(ap?.append?.[0]).toMatchObject({ updatedAt: 5555, closedAt: 0 });
    });

    it('reports a closure with no new points, and is silent when nothing changed', () => {
        const state = new Map();
        diffForOverlay([stroke('a', 3)], state);
        const d = diffForOverlay([stroke('a', 3, { closedAt: 9000 })], state);
        expect(d?.append?.[0]).toMatchObject({ id: 'a', closedAt: 9000 });
        expect(d?.append?.[0].points).toHaveLength(0);
        expect(diffForOverlay([stroke('a', 3, { closedAt: 9000 })], state)).toBeNull();
    });

    it('a stroke growing for a long gesture is never re-sent, only extended', () => {
        // The cursor is an index into a monotonically growing array; if it ever
        // read the stroke as having rewound it would re-upload the whole thing
        // on every animation frame for the length of the gesture.
        const state = new Map();
        let sent = 0;
        for (let n = 1; n <= 200; n++) {
            const d = diffForOverlay([stroke('a', n)], state);
            if (n === 1) { expect(d?.upsert).toHaveLength(1); continue; }
            expect(d?.upsert, `re-sent the whole stroke at n=${n}`).toBeUndefined();
            sent += d?.append?.[0].points.length ?? 0;
        }
        expect(sent).toBe(199); // each point sent exactly once
    });

    it('removes strokes that left the store (faded out, or the track went)', () => {
        const state = new Map();
        diffForOverlay([stroke('a', 3), stroke('b', 1)], state);
        const d = diffForOverlay([stroke('b', 1)], state);
        expect(d?.remove).toEqual(['a']);
        expect(state.has('a')).toBe(false);
    });

    it('still resends whole on a genuine rewind (fewer points than were sent)', () => {
        const state = new Map();
        diffForOverlay([stroke('a', 5)], state);
        const d = diffForOverlay([stroke('a', 2)], state);
        expect(d?.upsert?.[0].points).toHaveLength(2);
    });
});

describe('desktop overlay window lifecycle (lazy)', () => {
    // The overlay window is created on the first stroke, not when the share
    // starts, and torn down after the share has been stroke-free for a while.
    const setup = async () => {
        vi.resetModules();
        vi.useFakeTimers();
        const calls: string[] = [];
        let resolveShow: ((ok: boolean) => void) | null = null;
        const api = {
            annotationOverlayShow: vi.fn(() => { calls.push('show'); return new Promise<boolean>(r => { resolveShow = r; }); }),
            annotationOverlayHide: vi.fn(async () => { calls.push('hide'); }),
            annotationOverlayPush: vi.fn((d: { reset?: boolean }) => { calls.push(d.reset ? 'reset' : 'delta'); }),
        };
        vi.stubGlobal('window', { electronAPI: api });
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16) as unknown as number);
        vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
        const mod = await import('./desktopAnnotationOverlay');
        const { annotationStore, trackKey } = await import('./annotationStore');
        const key = trackKey('me', 'screen_share');
        const settle = async () => { await vi.advanceTimersByTimeAsync(20); };
        return { mod, annotationStore, key, api, calls, settle, show: (ok: boolean) => resolveShow?.(ok) };
    };
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('a share nobody draws on never creates the window', async () => {
        const t = await setup();
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        await vi.advanceTimersByTimeAsync(60_000);
        release();
        expect(t.api.annotationOverlayShow).not.toHaveBeenCalled();
        expect(t.api.annotationOverlayHide).not.toHaveBeenCalled();
    });

    it('first stroke shows it (full state once the window exists), idle hides it, a new stroke re-shows it', async () => {
        const t = await setup();
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        const id = t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 })!;
        await t.settle();
        expect(t.calls).toEqual(['show']);
        // Points keep arriving while the window is being created: nothing is
        // pushed until it exists, then one reset carries everything.
        t.annotationStore.appendPoints(t.key, id, [{ x: 0.2, y: 0.2 }]);
        await t.settle();
        t.show(true);
        await t.settle();
        expect(t.calls).toEqual(['show', 'reset']);
        t.annotationStore.appendPoints(t.key, id, [{ x: 0.3, y: 0.3 }]);
        await t.settle();
        expect(t.calls).toEqual(['show', 'reset', 'delta']);
        // Strokes gone (faded / cleared): stays up through the idle window, then hides.
        t.annotationStore.clearTrack(t.key);
        await t.settle();
        await vi.advanceTimersByTimeAsync(t.mod.HIDE_AFTER_IDLE_MS - 100);
        expect(t.calls.filter(c => c === 'hide')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(t.calls.filter(c => c === 'hide')).toHaveLength(1);
        // Drawing again brings it back.
        t.annotationStore.beginStroke(t.key, 'peer', { x: 0.5, y: 0.5 });
        await t.settle();
        expect(t.calls.filter(c => c === 'show')).toHaveLength(2);
        t.show(true);
        await t.settle();
        release();
        expect(t.calls.at(-1)).toBe('hide');
    });

    it('a release while the window is still being created closes it again', async () => {
        const t = await setup();
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 });
        await t.settle();
        release();
        t.show(true);
        await t.settle();
        expect(t.calls).toEqual(['show', 'hide']);
        expect(t.api.annotationOverlayPush).not.toHaveBeenCalled();
    });
});
