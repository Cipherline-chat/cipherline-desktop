import { describe, it, expect } from 'vitest';
import { createDesktopSourcesBroker, desktopSourcesKey, type DesktopSourcesTiming } from './desktop-sources';

type Req = { types: Array<'window' | 'screen'>; thumbnailSize: { width: number; height: number } };

/** A fake getSources whose calls stay pending until the test resolves them. */
function controllable() {
    const calls: Array<{ req: Req; resolve: (v: string[]) => void; reject: (e: unknown) => void }> = [];
    let running = 0;
    let maxRunning = 0;
    const getSources = (req: Req) => new Promise<string[]>((resolve, reject) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        calls.push({
            req,
            resolve: v => { running--; resolve(v); },
            reject: e => { running--; reject(e); },
        });
    });
    return { calls, getSources, maxRunning: () => maxRunning };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe('desktopSourcesKey', () => {
    it('ignores type order and duplicates', () => {
        expect(desktopSourcesKey({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } }))
            .toBe(desktopSourcesKey({ types: ['screen', 'window', 'screen'], thumbnailSize: { width: 0, height: 0 } }));
    });
    it('thumbnails and no thumbnails are different calls', () => {
        expect(desktopSourcesKey({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }))
            .not.toBe(desktopSourcesKey({ types: ['screen'], thumbnailSize: { width: 360, height: 360 } }));
    });
});

describe('createDesktopSourcesBroker', () => {
    it('never runs two getSources calls at once (the freeze: names + previews + diagnostics stacked)', async () => {
        const f = controllable();
        const b = createDesktopSourcesBroker({ getSources: f.getSources });
        const a = b.request({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const c = b.request({ types: ['screen'], thumbnailSize: { width: 360, height: 360 } });
        const d = b.request({ types: ['window'], thumbnailSize: { width: 360, height: 360 } });
        await tick();
        expect(f.calls).toHaveLength(1);             // only the first started
        f.calls[0].resolve(['s1']);
        await tick();
        expect(f.calls).toHaveLength(2);
        f.calls[1].resolve(['s1+thumb']);
        await tick();
        expect(f.calls).toHaveLength(3);
        f.calls[2].resolve(['w1', 'w2']);
        expect(await a).toEqual(['s1']);
        expect(await c).toEqual(['s1+thumb']);
        expect(await d).toEqual(['w1', 'w2']);
        expect(f.maxRunning()).toBe(1);
        // Order preserved: names, previews, then the window list.
        expect(f.calls.map(x => `${x.req.types.join()}:${x.req.thumbnailSize.width}`)).toEqual(['screen:0', 'screen:360', 'window:360']);
    });

    it('positive control: without the broker the same three calls overlap', async () => {
        const f = controllable();
        void f.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        void f.getSources({ types: ['screen'], thumbnailSize: { width: 360, height: 360 } });
        void f.getSources({ types: ['window'], thumbnailSize: { width: 360, height: 360 } });
        expect(f.maxRunning()).toBe(3);
    });

    it('an identical request that is waiting or running is shared, not repeated', async () => {
        const f = controllable();
        const timings: DesktopSourcesTiming[] = [];
        const b = createDesktopSourcesBroker({ getSources: f.getSources, onTiming: t => timings.push(t) });
        const p1 = b.request({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const p2 = b.request({ types: ['screen', 'screen'], thumbnailSize: { width: 0, height: 0 } });
        await tick();
        expect(f.calls).toHaveLength(1);
        f.calls[0].resolve(['s1']);
        expect(await p1).toEqual(['s1']);
        expect(await p2).toEqual(['s1']);
        expect(timings).toHaveLength(1);
        expect(timings[0]).toMatchObject({ key: 'screen thumbs=0x0', count: 1, ok: true, sharers: 2 });
    });

    it('a request after the previous one settled is a fresh call (the list is never stale)', async () => {
        const f = controllable();
        const b = createDesktopSourcesBroker({ getSources: f.getSources });
        const p1 = b.request({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        await tick();
        f.calls[0].resolve(['old']);
        await p1;
        const p2 = b.request({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        await tick();
        expect(f.calls).toHaveLength(2);
        f.calls[1].resolve(['new']);
        expect(await p2).toEqual(['new']);
    });

    it('a failed call rejects its callers but does not wedge the queue', async () => {
        const f = controllable();
        const timings: DesktopSourcesTiming[] = [];
        const b = createDesktopSourcesBroker({ getSources: f.getSources, onTiming: t => timings.push(t) });
        const bad = b.request({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const good = b.request({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        await tick();
        f.calls[0].reject(new Error('Failed to get sources.'));
        await expect(bad).rejects.toThrow('Failed to get sources.');
        await tick();
        expect(f.calls).toHaveLength(2);
        f.calls[1].resolve(['w']);
        expect(await good).toEqual(['w']);
        expect(timings.map(t => t.ok)).toEqual([false, true]);
        expect(b.pending()).toBe(0);
    });

    it('reports queue wait and run time separately', async () => {
        let t = 1000;
        const f = controllable();
        const timings: DesktopSourcesTiming[] = [];
        const b = createDesktopSourcesBroker({ getSources: f.getSources, now: () => t, onTiming: x => timings.push(x) });
        const p1 = b.request({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const p2 = b.request({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        await tick();
        t += 300;
        f.calls[0].resolve([]);
        await p1;
        await tick();
        t += 50;
        f.calls[1].resolve(['w']);
        await p2;
        expect(timings[0]).toMatchObject({ queuedMs: 0, runMs: 300 });
        expect(timings[1]).toMatchObject({ queuedMs: 300, runMs: 50 });
    });

    it('normalises the thumbnail size it passes on', async () => {
        const f = controllable();
        const b = createDesktopSourcesBroker({ getSources: f.getSources });
        void b.request({ types: ['screen'], thumbnailSize: { width: -5, height: 359.7 } });
        await tick();
        expect(f.calls[0].req.thumbnailSize).toEqual({ width: 0, height: 359 });
    });
});
