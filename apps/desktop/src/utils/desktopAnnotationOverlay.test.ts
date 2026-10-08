import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const setup = async (opts: { messageChannel?: unknown } = {}) => {
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
        // Animation frames NEVER fire here — that is what a minimized or
        // fullscreen-occluded main window gets (its compositor is not
        // visible), and the overlay must not depend on them. The spy proves
        // nothing even asks for one.
        const raf = vi.fn<(cb: () => void) => number>(() => 0);
        vi.stubGlobal('requestAnimationFrame', raf);
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        // Default: no MessageChannel, so the module's setTimeout(0) fallback
        // runs under the fake clock. Tests of the real default path pass one.
        vi.stubGlobal('MessageChannel', opts.messageChannel);
        const mod = await import('./desktopAnnotationOverlay');
        const { annotationStore, trackKey } = await import('./annotationStore');
        const key = trackKey('me', 'screen_share');
        const settle = async () => { await vi.advanceTimersByTimeAsync(20); };
        return { mod, annotationStore, key, api, calls, settle, raf, show: (ok: boolean) => resolveShow?.(ok) };
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

    it('streams at the packet rate with NO animation frames at all (minimized / occluded main window)', async () => {
        // The owner's bug: with Cipherline minimized the desktop overlay
        // updated at ~1 fps, because every store->overlay hop waited for an
        // animation frame. Here frames never come at all; 60 packets must
        // still produce ~60 deltas.
        const t = await setup();
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        const id = t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 })!;
        await t.settle();
        t.show(true);
        await t.settle();
        expect(t.calls).toEqual(['show', 'reset']);
        for (let i = 0; i < 60; i++) {
            t.annotationStore.appendPoints(t.key, id, [{ x: 0.1 + i / 100, y: 0.2 }]);
            await vi.advanceTimersByTimeAsync(16);
        }
        expect(t.calls.filter(c => c === 'delta')).toHaveLength(60);
        expect(t.raf).not.toHaveBeenCalled();
        release();
    });

    it('the default path is a MessageChannel task (no timers, no frames) and coalesces a burst into one delta', async () => {
        const posted: Array<() => void> = [];
        class FakeMessageChannel {
            port1: { onmessage: null | (() => void) } = { onmessage: null };
            port2 = { postMessage: () => { posted.push(() => this.port1.onmessage?.()); } };
        }
        const t = await setup({ messageChannel: FakeMessageChannel });
        const deliver = () => { const q = posted.splice(0); for (const f of q) f(); };
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        const id = t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 })!;
        expect(posted.length).toBeGreaterThan(0);
        deliver();
        await Promise.resolve();
        t.show(true);
        await vi.advanceTimersByTimeAsync(0);
        deliver();
        expect(t.calls).toEqual(['show', 'reset']);
        // Three packets inside one task -> one queued flush -> one delta.
        t.annotationStore.appendPoints(t.key, id, [{ x: 0.2, y: 0.2 }]);
        t.annotationStore.appendPoints(t.key, id, [{ x: 0.3, y: 0.3 }]);
        t.annotationStore.appendPoints(t.key, id, [{ x: 0.4, y: 0.4 }]);
        expect(posted).toHaveLength(1);
        deliver();
        expect(t.calls).toEqual(['show', 'reset', 'delta']);
        const last = t.api.annotationOverlayPush.mock.calls.at(-1)?.[0] as { append?: Array<{ points: unknown[] }> };
        expect(last.append?.[0].points).toHaveLength(3);
        expect(t.raf).not.toHaveBeenCalled();
        release();
    });

    it('window shares are attached too; anything else is not', async () => {
        const t = await setup();
        expect(t.mod.isOverlayableSourceId('window:1234:0')).toBe(true);
        expect(t.mod.isOverlayableSourceId('screen:0:0')).toBe(true);
        expect(t.mod.isOverlayableSourceId('web-contents-media-stream:1')).toBe(false);
        expect(t.mod.isOverlayableSourceId('')).toBe(false);
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'window:1234:0');
        t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 });
        await t.settle();
        expect(t.api.annotationOverlayShow).toHaveBeenCalledWith('window:1234:0');
        release();
    });

    it('a refusal is logged once with its reason, and main is NOT re-asked on every store change', async () => {
        const t = await setup();
        const { getCallEvents, clearCallEvents } = await import('./callEventLog');
        clearCallEvents();
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        const id = t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 })!;
        await t.settle();
        (t.show as unknown as (r: unknown) => void)({ ok: false, reason: 'no_display_match', displays: 3, addon: true });
        await t.settle();
        // 50 more packets inside the back-off window: still one ask.
        for (let i = 0; i < 50; i++) { t.annotationStore.appendPoints(t.key, id, [{ x: 0.2 + i / 1000, y: 0.2 }]); await vi.advanceTimersByTimeAsync(16); }
        expect(t.api.annotationOverlayShow).toHaveBeenCalledTimes(1);
        const ev = getCallEvents().filter(e => e.kind === 'annot_overlay');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toEqual({ result: 'refused', reason: 'no_display_match', share: 'screen', displays: 3, addon: true });
        // After the back-off it asks once more (a display may have been plugged in).
        await vi.advanceTimersByTimeAsync(t.mod.REFUSED_RETRY_MS);
        expect(t.api.annotationOverlayShow).toHaveBeenCalledTimes(2);
        // Same refusal again: not logged twice.
        (t.show as unknown as (r: unknown) => void)({ ok: false, reason: 'no_display_match', displays: 3, addon: true });
        await t.settle();
        expect(getCallEvents().filter(e => e.kind === 'annot_overlay')).toHaveLength(1);
        release();
    });

    it('a shown overlay is logged; `captured` (Linux) is announced and withdrawn with the share', async () => {
        const t = await setup();
        const { getCallEvents, clearCallEvents } = await import('./callEventLog');
        clearCallEvents();
        const seen: boolean[] = [];
        const off = t.mod.onDesktopOverlayCapturedChange(v => seen.push(v));
        const release = t.mod.attachDesktopAnnotationOverlay('me', 'screen:1:0');
        t.annotationStore.beginStroke(t.key, 'peer', { x: 0.1, y: 0.1 });
        await t.settle();
        (t.show as unknown as (r: unknown) => void)({ ok: true, how: 'display-id', captured: true });
        await t.settle();
        expect(t.calls).toEqual(['show', 'reset']);
        expect(t.mod.isDesktopOverlayCaptured()).toBe(true);
        expect(getCallEvents().find(e => e.kind === 'annot_overlay')?.detail).toEqual({ result: 'shown', how: 'display-id', share: 'screen', captured: true });
        release();
        expect(t.mod.isDesktopOverlayCaptured()).toBe(false);
        expect(seen).toEqual([true, false]);
        off();
    });

    it('normalizeShowResult: legacy booleans and junk', async () => {
        const t = await setup();
        expect(t.mod.normalizeShowResult(true)).toEqual({ ok: true, how: 'unknown', captured: false });
        expect(t.mod.normalizeShowResult(false)).toEqual({ ok: false, reason: 'create_failed' });
        expect(t.mod.normalizeShowResult({ ok: false, reason: 'wayland' })).toEqual({ ok: false, reason: 'wayland' });
        expect(t.mod.normalizeShowResult({ ok: true, how: 'window', captured: 'yes' })).toEqual({ ok: true, how: 'window', captured: false });
        expect(t.mod.normalizeShowResult(null)).toEqual({ ok: false, reason: 'create_failed' });
    });
});

/**
 * The 2026-10-08 regression guard: the desktop overlay must be held for the
 * whole local share, not by the self-view tile. That tile is not rendered
 * while you focus your own share (the focused stage draws its own tile) or
 * while its portal target is missing — the overlay died with it, so the
 * streamer saw strokes "on Cipherline but not on screen".
 */
describe('who holds the desktop overlay (SidebarConference source guard)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'SidebarConference.tsx'), 'utf8');
    const tileBody = (s: string) => {
        const start = s.indexOf('const LocalScreenShareTile');
        const end = s.indexOf('\n};', start);
        return s.slice(start, end);
    };
    it('the self-view tile does not attach it', () => {
        expect(tileBody(src)).not.toMatch(/useDesktopAnnotationOverlay|attachDesktopAnnotationOverlay/);
    });
    it('the conference body attaches it for the local share, keyed on the share — never on focus', () => {
        const calls = [...src.matchAll(/useDesktopAnnotationOverlay\(([\s\S]*?)\);/g)].map(m => m[1]);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(/localScreenShare/);
        expect(calls[0]).toMatch(/currentShare\?\.sourceId/);
        expect(calls[0]).not.toMatch(/focus/i);
    });
    it('positive control: the pre-fix shape (hook inside the tile) is caught', () => {
        const old = "const LocalScreenShareTile = ({ shareSourceId, ...props }) => {\n    useDesktopAnnotationOverlay(props.p.identity, shareSourceId ?? null);\n    return null;\n};";
        expect(tileBody(old)).toMatch(/useDesktopAnnotationOverlay/);
    });
});
