import { describe, it, expect, vi } from 'vitest';
import { registerAudioEngineIpc, audioEngineAvailability, AUDIO_ENGINE_IDLE_STOP_MS, type AudioEngineFiles } from './audio-engine-ipc';

const files: AudioEngineFiles = { host: '/app/audio-engine-host.js', addon: '/app/cl_audio_node.node', model: '/res/dfn/m.tar.gz' };

class FakeChild {
    handlers: Record<string, ((a: unknown) => void)[]> = {};
    sent: { m: unknown; t?: unknown[] }[] = [];
    killed = false;
    pid = 4242;
    postMessage(m: unknown, t?: unknown[]) { this.sent.push({ m, t }); }
    on(ev: string, cb: (a: unknown) => void) { (this.handlers[ev] ??= []).push(cb); return this; }
    kill() { this.killed = true; return true; }
    emit(ev: string, a: unknown) { for (const h of this.handlers[ev] ?? []) h(a); }
}

function rig(existing: string[] = [files.host, files.addon, files.model]) {
    const handlers = new Map<string, (e: { sender: ReturnType<typeof sender> }, a?: unknown) => unknown>();
    const children: FakeChild[] = [];
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const ports: { closed: boolean }[] = [];
    const log: string[] = [];
    const sender = () => ({ id: 7, posted: [] as { ch: string; t?: unknown[] }[], sent: [] as { ch: string; a: unknown[] }[],
        postMessage(ch: string, _m: unknown, t?: unknown[]) { this.posted.push({ ch, t }); }, send(ch: string, ...a: unknown[]) { this.sent.push({ ch, a }); },
        destroyed: [] as (() => void)[], once(ev: string, cb: () => void) { if (ev === 'destroyed') this.destroyed.push(cb); } });
    const s = sender();
    const ctl = registerAudioEngineIpc({
        ipc: { handle: (ch, fn) => { handlers.set(ch, fn as never); } },
        fork: () => { const c = new FakeChild(); children.push(c); return c as never; },
        newChannel: () => { const p = { closed: false, close() { this.closed = true; } }; ports.push(p); return { port1: p, port2: { port2: true } }; },
        files, exists: (p) => existing.includes(p), log: (l) => log.push(l),
        setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
        clearTimer: (t) => { (t as { live: boolean }).live = false; },
    });
    const call = (ch: string, a?: unknown) => handlers.get(ch)!({ sender: s }, a);
    const ready = (c: FakeChild, modelOk = true) => c.emit('message', { type: 'ready', modelOk });
    return { ctl, call, children, timers, ports, s, log, ready, handlers };
}

describe('availability: the addon, the host AND the model must all exist', () => {
    it('reports why not', () => {
        expect(audioEngineAvailability(files, () => true)).toEqual({ available: true });
        expect(audioEngineAvailability(files, (p) => p !== files.addon)).toEqual({ available: false, reason: 'addon-missing' });
        expect(audioEngineAvailability(files, (p) => p !== files.model)).toEqual({ available: false, reason: 'model-missing' });
        expect(audioEngineAvailability(files, (p) => p !== files.host)).toEqual({ available: false, reason: 'host-missing' });
    });
    it('the IPC answers with it and open refuses without starting any process', async () => {
        const r = rig([files.host]);
        expect(r.call('audio-engine:available')).toEqual({ available: false, reason: 'addon-missing' });
        expect(await r.call('audio-engine:open')).toEqual({ ok: false, error: 'addon-missing' });
        expect(r.children).toHaveLength(0);
    });
});

describe('open / close lifecycle', () => {
    it('starts the utility process on first open, inits it with PINNED paths, hands one port to it and the other to the renderer', async () => {
        const r = rig();
        const p = r.call('audio-engine:open') as Promise<{ ok: boolean }>;
        expect(r.children).toHaveLength(1);
        const c = r.children[0];
        expect(c.sent[0].m).toEqual({ type: 'init', addonPath: files.addon, modelPath: files.model });
        r.ready(c);
        expect(await p).toEqual({ ok: true });
        const open = c.sent.find(x => (x.m as { type: string }).type === 'open')!;
        expect(open.t).toHaveLength(1);
        expect(r.s.posted).toEqual([{ ch: 'audio-engine:port', t: [{ port2: true }] }]);
        expect(r.ctl.running()).toBe(true);
    });

    it('open takes no arguments from the renderer: a hostile argument cannot change a path or a command', async () => {
        const r = rig();
        const p = r.call('audio-engine:open', { addonPath: '/tmp/evil.node', modelPath: '/etc/passwd' }) as Promise<unknown>;
        r.ready(r.children[0]);
        await p;
        expect(r.children[0].sent[0].m).toEqual({ type: 'init', addonPath: files.addon, modelPath: files.model });
    });

    it('a second open re-uses the running process; close stops it only after 30 s, and an open in between cancels that', async () => {
        const r = rig();
        let p = r.call('audio-engine:open') as Promise<unknown>; r.ready(r.children[0]); await p;
        p = r.call('audio-engine:open') as Promise<unknown>; await p;
        expect(r.children).toHaveLength(1);
        r.call('audio-engine:close');
        const t = r.timers.at(-1)!;
        expect(t.ms).toBe(AUDIO_ENGINE_IDLE_STOP_MS);
        expect(r.children[0].killed).toBe(false);
        await (r.call('audio-engine:open') as Promise<unknown>);   // a new call within the 30 s
        expect(t.live).toBe(false);
        r.call('audio-engine:close');
        const t2 = r.timers.at(-1)!;
        t2.fn();
        expect(r.children[0].killed).toBe(true);
        expect(r.ctl.running()).toBe(false);
    });

    it('after the idle stop the next open starts a fresh process', async () => {
        const r = rig();
        let p = r.call('audio-engine:open') as Promise<unknown>; r.ready(r.children[0]); await p;
        r.call('audio-engine:close'); r.timers.at(-1)!.fn();
        p = r.call('audio-engine:open') as Promise<unknown>;
        expect(r.children).toHaveLength(2);
        r.ready(r.children[1]);
        expect(await p).toEqual({ ok: true });
    });

    it('the engine failing to load (or the model being rejected) is { ok: false } and nothing is left running', async () => {
        const r = rig();
        let p = r.call('audio-engine:open') as Promise<unknown>;
        r.children[0].emit('message', { type: 'failed', error: 'engine failed to build' });
        expect(await p).toEqual({ ok: false, error: 'engine-start-failed' });
        expect(r.children[0].killed).toBe(true);
        p = r.call('audio-engine:open') as Promise<unknown>;
        r.ready(r.children[1], false);   // loaded but the model bytes were refused
        expect(await p).toEqual({ ok: false, error: 'engine-start-failed' });
        expect(r.s.posted).toHaveLength(0);
    });

    it('a start that never answers times out', async () => {
        const r = rig();
        const p = r.call('audio-engine:open') as Promise<unknown>;
        r.timers[0].fn();
        expect(await p).toEqual({ ok: false, error: 'engine-start-failed' });
        expect(r.children[0].killed).toBe(true);
    });

    it('the utility process dying mid-call tells the page (audio-engine:exit) and the next open restarts it', async () => {
        const r = rig();
        let p = r.call('audio-engine:open') as Promise<unknown>; r.ready(r.children[0]); await p;
        r.children[0].emit('exit', 139);
        expect(r.s.sent).toEqual([{ ch: 'audio-engine:exit', a: [{ reason: 'engine-exit' }] }]);
        expect(r.ctl.running()).toBe(false);
        p = r.call('audio-engine:open') as Promise<unknown>;
        expect(r.children).toHaveLength(2);
        r.ready(r.children[1]);
        expect(await p).toEqual({ ok: true });
    });

    it('a window that goes away closes the session (the utility process then idles out)', async () => {
        const r = rig();
        const p = r.call('audio-engine:open') as Promise<unknown>; r.ready(r.children[0]); await p;
        r.s.destroyed[0]();
        expect(r.children[0].sent.some(x => (x.m as { type: string }).type === 'close')).toBe(true);
        expect(r.timers.at(-1)!.ms).toBe(AUDIO_ENGINE_IDLE_STOP_MS);
    });

    it('stop() (app quit) kills the process and clears timers', async () => {
        const r = rig();
        const p = r.call('audio-engine:open') as Promise<unknown>; r.ready(r.children[0]); await p;
        r.call('audio-engine:close');
        r.ctl.stop();
        expect(r.children[0].killed).toBe(true);
        expect(r.timers.at(-1)!.live).toBe(false);
    });

    it('log lines are sanitised and a throwing logger never breaks the handler', async () => {
        const r = rig();
        const p = r.call('audio-engine:open') as Promise<unknown>;
        r.children[0].emit('message', { type: 'failed', error: 'bad\u0000\u001b[31mthing' + 'x'.repeat(500) });
        await p;
        expect(r.log[0].length).toBeLessThan(200);
        expect(r.log[0]).not.toMatch(/[^\x20-\x7e]/);
        vi.fn();
    });
});
