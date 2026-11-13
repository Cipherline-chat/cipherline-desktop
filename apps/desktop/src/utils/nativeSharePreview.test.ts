import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreviewPayload, createNativePreviewHub, PREVIEW_W, PREVIEW_FPS } from './nativeSharePreview';

const here = dirname(fileURLToPath(import.meta.url));
const pic = (w: number, h: number) => { const p = new Uint8Array(4 + w * h * 4); p[0] = w & 255; p[1] = w >> 8; p[2] = h & 255; p[3] = h >> 8; return p; };
const P = (w = 2, h = 1) => ({ w, h, rgba: new Uint8ClampedArray(w * h * 4) });

describe('readPreviewPayload', () => {
    it('reads a well-formed picture into an exactly-sized fresh buffer', () => {
        const r = readPreviewPayload(pic(4, 3))!;
        expect(r.w).toBe(4); expect(r.h).toBe(3); expect(r.rgba.buffer.byteLength).toBe(4 * 3 * 4);
    });
    it('NEGATIVE: a length that disagrees with the size, zero or oversized dimensions, or a stub, give null', () => {
        expect(readPreviewPayload(pic(4, 3).slice(0, 20))).toBeNull();
        expect(readPreviewPayload(new Uint8Array(pic(4, 3).length + 1))).toBeNull();
        expect(readPreviewPayload(pic(0, 3))).toBeNull();
        expect(readPreviewPayload(pic(2000, 1))).toBeNull();
        expect(readPreviewPayload(new Uint8Array([1, 0, 1, 0]))).toBeNull();
    });
});

describe('the preview hub (the helper is asked only while a tile is showing)', () => {
    it('asks for pictures when the FIRST tile subscribes and stops when the LAST one leaves', () => {
        const hub = createNativePreviewHub(); const request = vi.fn();
        hub.setSource({ request });
        expect(request).not.toHaveBeenCalled();                  // a share with no tile on screen costs nothing
        const a = hub.subscribe(() => {}), b = hub.subscribe(() => {});
        expect(request).toHaveBeenCalledTimes(1); expect(request).toHaveBeenLastCalledWith(true);
        a(); expect(request).toHaveBeenCalledTimes(1);           // the focused stage still watching
        b(); expect(request).toHaveBeenCalledTimes(2); expect(request).toHaveBeenLastCalledWith(false);
    });
    it('a tile mounted BEFORE the helper is up is served as soon as the source registers', () => {
        const hub = createNativePreviewHub(); const request = vi.fn();
        hub.subscribe(() => {});
        hub.setSource({ request });
        expect(request).toHaveBeenCalledWith(true);
    });
    it('delivers pictures to every tile, replays the latest to a new tile, and forgets it when nobody watches', () => {
        const hub = createNativePreviewHub(); hub.setSource({ request() {} });
        const got: unknown[] = []; const off = hub.subscribe((p) => got.push(p));
        hub.push(P(3, 1)); expect(got).toHaveLength(1);
        const late: unknown[] = []; const off2 = hub.subscribe((p) => late.push(p));
        expect(late).toHaveLength(1);
        off(); off2();
        const again: unknown[] = []; hub.subscribe((p) => again.push(p));
        expect(again).toHaveLength(0);                           // stale screen contents are not kept around
    });
    it('NEGATIVE: with no tile subscribed a picture is dropped, and a double unsubscribe does not stop it twice', () => {
        const hub = createNativePreviewHub(); const request = vi.fn(); hub.setSource({ request });
        hub.push(P());
        const got: unknown[] = []; const off = hub.subscribe((p) => got.push(p));
        expect(got).toHaveLength(0);
        off(); off();
        expect(request.mock.calls.filter((c) => c[0] === false)).toHaveLength(1);
    });
    it('the share ending clears the picture and tells every tile (they fall back to the short label)', () => {
        const hub = createNativePreviewHub(); hub.setSource({ request() {} });
        const got: unknown[] = []; hub.subscribe((p) => got.push(p));
        hub.push(P()); hub.setSource(null);
        expect(got.at(-1)).toBeNull(); expect(hub.hasSource()).toBe(false);
    });
    it('a helper that throws on request never breaks the tile', () => {
        const hub = createNativePreviewHub(); hub.setSource({ request() { throw new Error('gone'); } });
        expect(() => hub.subscribe(() => {})()).not.toThrow();
    });
    it('asks for a cheap size and rate', () => { expect(PREVIEW_W).toBeLessThanOrEqual(640); expect(PREVIEW_FPS).toBeLessThanOrEqual(10); });
});

describe('wiring: the Linux sharer\'s tile shows the picture, not the old explanation', () => {
    const tile = readFileSync(join(here, '..', 'components', 'call', 'LocalScreenShareTile.tsx'), 'utf8');
    it('LocalScreenShareTile draws NativeSharePreview for a native share and no longer prints the long text', () => {
        expect(tile).toContain('<NativeSharePreview');
        expect(tile).not.toContain('costs nothing');
        expect(tile).not.toContain('nativePreviewPlaceholder');
    });
    it('the unfocused rule is unchanged: paused wins over the picture (no capture shown, no thumbnails asked)', () => {
        expect(tile.indexOf('if (!appFocused)')).toBeLessThan(tile.indexOf('<NativeSharePreview'));
    });
    it('the pipeline registers the hub source once streaming and clears it on teardown; thumbnails route into the hub', () => {
        const src = readFileSync(join(here, 'nativeSharePipeline.ts'), 'utf8');
        expect(src).toContain('nativePreviewHub.setSource({ request');
        expect(src).toContain('nativePreviewHub.setSource(null)');
        expect(src).toContain('nativePreviewHub.push(');
    });
});
