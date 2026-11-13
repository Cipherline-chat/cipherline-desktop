import { describe, it, expect, vi } from 'vitest';
import { installNativeInjector } from './nativeShareWorker';

function scope() {
    const seen: unknown[] = [];
    const s = { onmessage: ((ev: MessageEvent) => { seen.push(ev.data); }) as ((ev: MessageEvent) => unknown) | null, postMessage() {} };
    return { s, seen };
}

describe('installNativeInjector', () => {
    it('is inert without a bound session: encode streams reach the inner handler UNCHANGED (flag-off behaviour)', () => {
        const { s, seen } = scope();
        expect(installNativeInjector(s)).toBe(true);
        const rs = new ReadableStream();
        const msg = { kind: 'encode', data: { trackId: 't1', readableStream: rs } };
        s.onmessage!({ data: msg } as MessageEvent);
        expect(seen[0]).toBe(msg);                                      // same object, not even re-wrapped
        expect((seen[0] as typeof msg).data.readableStream).toBe(rs);
    });
    it('NEGATIVE: returns false and installs nothing when there is no inner handler', () => {
        const s = { onmessage: null, postMessage() {} };
        expect(installNativeInjector(s)).toBe(false);
        expect(s.onmessage).toBeNull();
    });
    it('once bound, ONLY the bound track is wrapped; other tracks (camera) pass through untouched', () => {
        const { s, seen } = scope();
        installNativeInjector(s);
        const { port1 } = new MessageChannel();
        s.onmessage!({ data: { kind: 'cl:native-share', data: { trackId: 'dummy', port: port1 } } } as MessageEvent);
        expect(seen.length).toBe(0);                                    // the bind message is consumed, never forwarded to LiveKit
        const cam = { kind: 'encode', data: { trackId: 'camera', readableStream: new ReadableStream() } };
        s.onmessage!({ data: cam } as MessageEvent);
        expect(seen[0]).toBe(cam);
        const share = { kind: 'encode', data: { trackId: 'dummy', readableStream: new ReadableStream() } };
        s.onmessage!({ data: share } as MessageEvent);
        expect((seen[1] as typeof share).data.readableStream).not.toBe(share.data.readableStream);
        port1.close();
    });
    it('tick mode: exactly one cl:native-au per received AU (1:1 pacing); non-tick sessions post none', async () => {
        for (const tick of [true, false]) {
            const posted: unknown[] = [];
            const s = { onmessage: ((_ev: MessageEvent) => {}) as ((ev: MessageEvent) => unknown) | null, postMessage: (m: unknown) => { posted.push(m); } };
            installNativeInjector(s);
            const { port1, port2 } = new MessageChannel();
            s.onmessage!({ data: { kind: 'cl:native-share', data: { trackId: 'd', port: port1, tick } } } as MessageEvent);
            const au = (key: boolean) => {
                const payload = key ? new Uint8Array([0, 0, 0, 1, 0x65, 9]) : new Uint8Array([0, 0, 0, 1, 0x41, 7]);
                const out = new Uint8Array(24 + payload.length); const dv = new DataView(out.buffer);
                dv.setUint32(0, payload.length, true); out[4] = key ? 1 : 0; out.set(payload, 24); return out;
            };
            const a = au(true), b = au(false);
            port2.postMessage(a.buffer.slice(0)); port2.postMessage(b.buffer.slice(0));
            await new Promise((r) => setTimeout(r, 50));
            const ticks = posted.filter((m) => (m as { kind?: string }).kind === 'cl:native-au');
            expect(ticks.length).toBe(tick ? 2 : 0);
            port1.close(); port2.close();
        }
    });
});

describe('installNativeInjector: the lighter copy (layers: 2)', () => {
    const wireAu = (flags: number, payload: Uint8Array) => {
        const out = new Uint8Array(24 + payload.length); new DataView(out.buffer).setUint32(0, payload.length, true); out[4] = flags; out.set(payload, 24); return out;
    };
    const IDR = new Uint8Array([0, 0, 0, 1, 0x65, 9]);
    async function bound(layers: 1 | 2, tick = true) {
        const posted: { kind?: string; data?: Record<string, unknown> }[] = [];
        const s = { onmessage: ((_ev: MessageEvent) => {}) as ((ev: MessageEvent) => unknown) | null, postMessage: (m: unknown) => { posted.push(m as never); } };
        installNativeInjector(s);
        const { port1, port2 } = new MessageChannel();
        const cmds: unknown[] = [];
        port2.onmessage = (e) => { cmds.push(e.data); };
        s.onmessage!({ data: { kind: 'cl:native-share', data: { trackId: 'd', port: port1, tick, ...(layers === 2 ? { layers } : {}) } } } as MessageEvent);
        return { s, posted, cmds, port1, port2, close: () => { port1.close(); port2.close(); } };
    }
    const wait = () => new Promise((r) => setTimeout(r, 40));

    it('a low AU ticks the dummy generator too (slack for the low layer\'s frames), flagged low', async () => {
        const b = await bound(2);
        b.port2.postMessage(wireAu(3, IDR).buffer.slice(0));
        await wait();
        expect(b.posted.filter((m) => m.kind === 'cl:native-au').map((m) => m.data?.low)).toEqual([true]);
        b.close();
    });
    it('cl:native-low opens/closes the helper session through the port, and asks the low layer for its IDR', async () => {
        const b = await bound(2);
        b.s.onmessage!({ data: { kind: 'cl:native-low', data: { trackId: 'd', on: true, w: 1280, h: 720, fps: 30, bps: 3_000_000 } } } as MessageEvent);
        b.s.onmessage!({ data: { kind: 'cl:native-low', data: { trackId: 'd', on: false } } } as MessageEvent);
        await wait();
        expect(b.cmds).toContainEqual({ cmd: 'low', on: true, w: 1280, h: 720, fps: 30, bps: 3_000_000 });
        expect(b.cmds).toContainEqual({ cmd: 'low', on: false });
        expect(b.cmds).toContainEqual({ cmd: 'idr', layer: 'low' });
        b.close();
    });
    it('NEGATIVE: on a single-layer session cl:native-low is ignored and low AUs are discarded (never injected into the full layer)', async () => {
        const b = await bound(1);
        b.s.onmessage!({ data: { kind: 'cl:native-low', data: { trackId: 'd', on: true, w: 1280, h: 720, fps: 30, bps: 3_000_000 } } } as MessageEvent);
        b.port2.postMessage(wireAu(3, IDR).buffer.slice(0));
        await wait();
        expect(b.cmds.some((c) => (c as { cmd?: string }).cmd === 'low')).toBe(false);
        expect(b.posted.filter((m) => m.kind === 'cl:native-au').length).toBe(0);
        b.close();
    });
    it('NEGATIVE: cl:native-low for an unbound track does nothing', async () => {
        const b = await bound(2);
        b.s.onmessage!({ data: { kind: 'cl:native-low', data: { trackId: 'other', on: true, w: 1280, h: 720, fps: 30, bps: 3_000_000 } } } as MessageEvent);
        await wait();
        expect(b.cmds.some((c) => (c as { cmd?: string }).cmd === 'low')).toBe(false);
        b.close();
    });
    it('a layered session wraps the encode stream (the same E2EE position as the single-layer one: the stream is replaced, not passed through)', async () => {
        const seen: unknown[] = [];
        const s = { onmessage: ((ev: MessageEvent) => { seen.push(ev.data); }) as ((ev: MessageEvent) => unknown) | null, postMessage() {} };
        installNativeInjector(s);
        const { port1 } = new MessageChannel();
        s.onmessage!({ data: { kind: 'cl:native-share', data: { trackId: 'd', port: port1, layers: 2 } } } as MessageEvent);
        const rs = new ReadableStream();
        s.onmessage!({ data: { kind: 'encode', data: { trackId: 'd', readableStream: rs } } } as MessageEvent);
        expect((seen[0] as { data: { readableStream: ReadableStream } }).data.readableStream).not.toBe(rs);
        port1.close();
    });
    describe('stall watchdog vs the portal chooser', () => {
        const bind = () => {
            vi.useFakeTimers();
            const posted: { kind?: string; data?: { state?: string } }[] = [];
            const s = { onmessage: ((_ev: MessageEvent) => {}) as ((ev: MessageEvent) => unknown) | null, postMessage: (m: unknown) => { posted.push(m as never); } };
            installNativeInjector(s);
            const { port1, port2 } = new MessageChannel();
            s.onmessage!({ data: { kind: 'cl:native-share', data: { trackId: 'd', port: port1 } } } as MessageEvent);
            const dead = () => posted.some((m) => m.kind === 'cl:native-share-status' && m.data?.state === 'dead');
            return { s, dead, close: () => { port1.close(); port2.close(); vi.useRealTimers(); } };
        };
        it('a chooser that takes 10 s does NOT trip the watchdog (no AU yet, not armed)', async () => {
            const h = bind();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(h.dead()).toBe(false);
            h.close();
        });
        it('once armed (first format seen) a stream that never produces an AU is declared dead', async () => {
            const h = bind();
            await vi.advanceTimersByTimeAsync(10_000);
            h.s.onmessage!({ data: { kind: 'cl:native-arm', data: { trackId: 'd' } } } as MessageEvent);
            await vi.advanceTimersByTimeAsync(1000); expect(h.dead()).toBe(false);
            await vi.advanceTimersByTimeAsync(1000); expect(h.dead()).toBe(true);
            h.close();
        });
        it('armed then silent (frames stop after the stream was up) still trips it', async () => {
            const h = bind();
            await vi.advanceTimersByTimeAsync(10_000);
            h.s.onmessage!({ data: { kind: 'cl:native-arm', data: { trackId: 'd' } } } as MessageEvent);
            await vi.advanceTimersByTimeAsync(3000);
            expect(h.dead()).toBe(true);
            h.close();
        });
    });
});

describe('installNativeInjector: the sharer\'s own preview', () => {
    const rec = (flags: number, payload: Uint8Array) => { const out = new Uint8Array(24 + payload.length); new DataView(out.buffer).setUint32(0, payload.length, true); out[4] = flags; out.set(payload, 24); return out; };
    const pic = (w: number, h: number) => { const p = new Uint8Array(4 + w * h * 4); p[0] = w; p[2] = h; p.fill(7, 4); return p; };
    async function bound() {
        const posted: { kind?: string; data?: Record<string, unknown> }[] = [];
        const s = { onmessage: ((_ev: MessageEvent) => {}) as ((ev: MessageEvent) => unknown) | null, postMessage: (m: unknown) => { posted.push(m as never); } };
        installNativeInjector(s);
        const { port1, port2 } = new MessageChannel();
        const cmds: unknown[] = [];
        port2.onmessage = (e) => { cmds.push(e.data); };
        s.onmessage!({ data: { kind: 'cl:native-share', data: { trackId: 'd', port: port1, tick: true } } } as MessageEvent);
        return { s, posted, cmds, port2, close: () => { port1.close(); port2.close(); } };
    }
    const wait = () => new Promise((r) => setTimeout(r, 40));
    it('a preview record goes to the page as cl:native-preview-frame, and is NOT an access unit (no tick, no injector, no watchdog feed)', async () => {
        const b = await bound();
        b.port2.postMessage(rec(4, pic(3, 2)).buffer.slice(0));
        await wait();
        const frame = b.posted.find((m) => m.kind === 'cl:native-preview-frame');
        expect(frame?.data).toMatchObject({ trackId: 'd', w: 3, h: 2 });
        expect((frame!.data!.rgba as ArrayBuffer).byteLength).toBe(3 * 2 * 4);
        expect(b.posted.filter((m) => m.kind === 'cl:native-au').length).toBe(0);
        b.close();
    });
    it('NEGATIVE: a malformed preview record (length disagrees with its own size) is dropped, never forwarded', async () => {
        const b = await bound();
        const bad = pic(3, 2).slice(0, 10);
        b.port2.postMessage(rec(4, bad).buffer.slice(0));
        await wait();
        expect(b.posted.filter((m) => m.kind === 'cl:native-preview-frame').length).toBe(0);
        b.close();
    });
    it('cl:native-preview asks the helper (through the port) to start and stop thumbnails', async () => {
        const b = await bound();
        b.s.onmessage!({ data: { kind: 'cl:native-preview', data: { trackId: 'd', on: true, w: 512, fps: 6 } } } as MessageEvent);
        b.s.onmessage!({ data: { kind: 'cl:native-preview', data: { trackId: 'd', on: false } } } as MessageEvent);
        await wait();
        expect(b.cmds.filter((c) => (c as { cmd?: string }).cmd === 'preview')).toEqual([{ cmd: 'preview', on: true, w: 512, fps: 6 }, { cmd: 'preview', on: false }]);
        b.close();
    });
});
