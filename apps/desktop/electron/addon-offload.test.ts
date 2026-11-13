import { describe, it, expect } from 'vitest';
import { AddonOffload, OFFLOAD_WORKER_SOURCE, SUPPORT_TTL_NO_MS, SUPPORT_TTL_YES_MS, type OffloadWorker } from './addon-offload';

type Msg = { id: number; fn: string; args: unknown[] };

class FakeWorker implements OffloadWorker {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    terminated = false;
    posted: Msg[] = [];
    constructor(private readonly behaviour: (m: Msg, w: FakeWorker) => void) {}
    on(ev: string, cb: (...a: unknown[]) => void) { (this.handlers[ev] ??= []).push(cb); return this; }
    postMessage(m: unknown) { this.posted.push(m as Msg); this.behaviour(m as Msg, this); }
    terminate() { this.terminated = true; return Promise.resolve(0); }
    emit(ev: string, ...a: unknown[]) { for (const h of this.handlers[ev] ?? []) h(...a); }
    reply(id: number, result: unknown) { this.emit('message', { id, result }); }
}

/** A worker whose behaviour the test scripts: answer, stay silent (stuck in native code), or fail to boot. */
function fakeFactory(behaviour: (m: Msg, w: FakeWorker) => void) {
    const made: FakeWorker[] = [];
    return { make: () => { const w = new FakeWorker(behaviour); made.push(w); return w; }, made };
}

const mk = (f: ReturnType<typeof fakeFactory>, over: Partial<ConstructorParameters<typeof AddonOffload>[0]> = {}, now = () => Date.now()) =>
    new AddonOffload({ addonPath: '/x/audio_capture.node', makeWorker: f.make, now, timeoutMs: 40, ...over });

describe('AddonOffload', () => {
    it('answers from the worker and never calls the addon on the calling thread', async () => {
        const f = fakeFactory((m, w) => w.reply(m.id, m.fn === 'isSupported' ? true : [{ key: 'k' }]));
        const o = mk(f);
        expect(await o.isSupported()).toBe(true);
        expect(await o.listApps(1234)).toEqual([{ key: 'k' }]);
        expect(f.made).toHaveLength(1);
        expect(f.made[0].posted.map(p => p.fn)).toEqual(['isSupported', 'listApps']);
        expect(f.made[0].posted[1].args).toEqual([1234]);
    });

    it('a call the worker never answers times out, terminates the stuck worker, and the next call gets a fresh one', async () => {
        let stuck = true;
        const f = fakeFactory((m, w) => { if (!stuck) w.reply(m.id, true); });
        const o = mk(f);
        const t0 = Date.now();
        const r = await o.call('isSupported');
        expect(r).toEqual({ ok: false, reason: 'timeout' });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(f.made[0].terminated).toBe(true);
        stuck = false;
        expect(await o.call('isSupported')).toEqual({ ok: true, value: true });
        expect(f.made).toHaveLength(2);
    });

    it('control: the same call is fast and ok while the worker answers', async () => {
        const f = fakeFactory((m, w) => w.reply(m.id, true));
        const o = mk(f);
        expect(await o.call('isSupported')).toEqual({ ok: true, value: true });
        expect(f.made[0].terminated).toBe(false);
    });

    it('opens a breaker after repeated timeouts and answers instantly, then recovers', async () => {
        let t = 1_000_000;
        const f = fakeFactory(() => { /* never answers */ });
        const o = mk(f, { breakerAfter: 3, breakerMs: 60_000 }, () => t);
        for (let i = 0; i < 3; i++) expect((await o.call('isSupported')).ok).toBe(false);
        expect(o.breakerOpen).toBe(true);
        const made = f.made.length;
        const t0 = Date.now();
        expect(await o.call('listApps', [1])).toEqual({ ok: false, reason: 'breaker' });
        expect(Date.now() - t0).toBeLessThan(20);
        expect(f.made).toHaveLength(made); // no new worker while open
        t += 61_000;
        expect(o.breakerOpen).toBe(false);
    });

    it('a failed probe does not flip a known "yes" to "no"', async () => {
        let t = 1_000_000;
        let silent = false;
        const f = fakeFactory((m, w) => { if (!silent) w.reply(m.id, true); });
        const o = mk(f, {}, () => t);
        expect(await o.isSupported()).toBe(true);
        t += SUPPORT_TTL_YES_MS + 1;
        silent = true;
        expect(await o.isSupported()).toBe(true);
    });

    it('caches a yes for 10 s and a no for 3 s (no worker call inside the TTL)', async () => {
        let t = 1_000_000;
        let answer = false;
        const f = fakeFactory((m, w) => w.reply(m.id, answer));
        const o = mk(f, {}, () => t);
        expect(await o.isSupported()).toBe(false);
        await o.isSupported();
        expect(f.made[0].posted).toHaveLength(1);
        t += SUPPORT_TTL_NO_MS + 1;
        answer = true;
        expect(await o.isSupported()).toBe(true);
        expect(f.made[0].posted).toHaveLength(2);
    });

    it('supportedNow never waits: null before the first answer, then the cached value', async () => {
        const f = fakeFactory((m, w) => { setTimeout(() => w.reply(m.id, true), 5); });
        const o = mk(f);
        expect(o.supportedNow()).toBeNull();
        await new Promise(r => setTimeout(r, 30));
        expect(o.supportedNow()).toBe(true);
    });

    it('coalesces concurrent listApps calls into one worker call and reuses a fresh list', async () => {
        const f = fakeFactory((m, w) => { setTimeout(() => w.reply(m.id, [{ key: 'a' }]), 5); });
        const o = mk(f);
        const [a, b] = await Promise.all([o.listApps(1), o.listApps(1)]);
        expect(a).toEqual(b);
        await o.listApps(1);
        expect(f.made[0].posted.filter(p => p.fn === 'listApps')).toHaveLength(1);
    });

    it('a timed-out listApps is null (not cached as an empty list)', async () => {
        const f = fakeFactory(() => { /* silent */ });
        const o = mk(f);
        expect(await o.listApps(1)).toBeNull();
    });

    it('an addon that cannot load in a worker makes the offload unusable (caller falls back to direct calls)', async () => {
        const f = fakeFactory((_m, w) => { w.emit('message', { boot: 'fail' }); });
        const o = mk(f);
        expect(o.usable).toBe(true);
        expect((await o.call('isSupported')).ok).toBe(false);
        expect(o.usable).toBe(false);
        expect(await o.call('isSupported')).toEqual({ ok: false, reason: 'no-worker' });
    });

    it('a failed boot is not cached as "unsupported"', async () => {
        const f = fakeFactory((_m, w) => { w.emit('message', { boot: 'fail' }); });
        const o = mk(f);
        await o.isSupported();
        expect(o.supportedNow()).toBeNull();
    });

    it('refuses functions outside the allowlist and ignores a late answer', async () => {
        const f = fakeFactory(() => { /* silent */ });
        const o = mk(f);
        expect(await o.call('startCapture' as never)).toEqual({ ok: false, reason: 'error' });
        const r = await o.call('isSupported');
        expect(r.ok).toBe(false);
        expect(() => f.made[0].reply(1, true)).not.toThrow();
    });

    it('the worker source only dispatches isSupported / listApps', () => {
        expect(OFFLOAD_WORKER_SOURCE).toMatch(/m\.fn === 'isSupported' \|\| m\.fn === 'listApps'/);
        expect(OFFLOAD_WORKER_SOURCE).not.toMatch(/startCapture|stopCapture/);
    });
});
