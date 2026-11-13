import { describe, it, expect } from 'vitest';
import {
    cleanDisplayChoice, cleanShowHint, sameLayout,
    parseHelperLine, matchWaylandOutput, cleanFrameHint, frameCoversDisplay, WaylandStrokeEncoder, TokenBucket,
    MAX_STROKES, MAX_POINTS_PER_STROKE, MAX_POINTS_PER_LINE,
    type WaylandOutput, type DisplayLite,
} from './annotation-overlay-wayland-protocol';

describe('parseHelperLine', () => {
    it('reads every message the helper prints', () => {
        expect(parseHelperLine('HELLO 1')).toEqual({ kind: 'hello', version: 1 });
        expect(parseHelperLine('OUT 0 DP-1 0 0 2560 1440 1 2560 1440')).toEqual({
            kind: 'out',
            out: { index: 0, name: 'DP-1', x: 0, y: 0, width: 2560, height: 1440, scale: 1, physicalWidth: 2560, physicalHeight: 1440 },
        });
        expect(parseHelperLine('OUT 1 HDMI-A-1 -1080 -384 1080 1920 2 2160 3840')).toMatchObject({ kind: 'out', out: { x: -1080, y: -384, scale: 2 } });
        expect(parseHelperLine('READY layer_shell=1 x11=0')).toEqual({ kind: 'ready', layerShell: true, x11: false });
        expect(parseHelperLine('READY layer_shell=0 x11=1')).toEqual({ kind: 'ready', layerShell: false, x11: true });
        expect(parseHelperLine('SHOWN 0 1920 1080 1')).toEqual({ kind: 'shown', index: 0, width: 1920, height: 1080, scale: 1 });
        expect(parseHelperLine('CLOSED')).toEqual({ kind: 'closed' });
        expect(parseHelperLine('ERR no_x_monitor')).toEqual({ kind: 'err', code: 'no_x_monitor' });
    });
    it('a name the compositor did not give is "-" and still parses', () => {
        expect(parseHelperLine('OUT 0 - 0 0 1920 1080 1 1920 1080')).toMatchObject({ kind: 'out', out: { name: '-' } });
    });
    it('anything not exactly well-formed is dropped, never coerced', () => {
        for (const bad of [
            '', 'HELLO', 'HELLO x', 'HELLO 1 2', 'hello 1', 'READY layer_shell=1', 'READY layer_shell=2 x11=0', 'READY x11=0 layer_shell=1',
            'OUT 0 DP-1 0 0 2560 1440 1 2560', 'OUT 16 DP-1 0 0 2560 1440 1 2560 1440', 'OUT 0 DP-1 0 0 0 1440 1 2560 1440',
            'OUT 0 DP-1 0 0 2560 1440 0 2560 1440', 'OUT 0 D/P 0 0 2560 1440 1 2560 1440', 'OUT 0 DP-1 1e3 0 2560 1440 1 2560 1440',
            'OUT 0 DP-1 0 0 2560 1440 1 2560 1440 extra', 'SHOWN 0 0 1080 1', 'SHOWN a 1 1 1', 'CLOSED now', 'ERR', 'ERR Bad Code',
            'ERR ' + 'a'.repeat(40), 'X'.repeat(300), 'OUT 0 ' + 'A'.repeat(41) + ' 0 0 1 1 1 1 1',
        ]) expect(parseHelperLine(bad), JSON.stringify(bad)).toBeNull();
    });
});

// ── output matching ─────────────────────────────────────────────────────────

const out = (index: number, name: string, x: number, y: number, w: number, h: number, scale = 1): WaylandOutput =>
    ({ index, name, x, y, width: w, height: h, scale, physicalWidth: w * scale, physicalHeight: h * scale });
const disp = (id: number, x: number, y: number, w: number, h: number, scaleFactor = 1): DisplayLite =>
    ({ id, bounds: { x, y, width: w, height: h }, scaleFactor });

describe('matchWaylandOutput', () => {
    it('one display, one output: the whole-screen share is on it (even with no frame hint)', () => {
        const r = matchWaylandOutput({ displays: [disp(1, 0, 0, 1920, 1080)], outputs: [out(0, 'DP-1', 0, 0, 1920, 1080)], frame: null });
        expect(r).toMatchObject({ ok: true, displayId: 1, how: 'only-display', output: { index: 0 } });
        const r2 = matchWaylandOutput({ displays: [disp(1, 0, 0, 1920, 1080)], outputs: [out(0, 'DP-1', 0, 0, 1920, 1080)], frame: { width: 3840, height: 2160 } });
        expect(r2).toMatchObject({ ok: true, how: 'only-display' });   // a downscaled capture keeps the aspect
    });

    it('two different monitors: the frame size says which', () => {
        const displays = [disp(1, 0, 0, 2560, 1440), disp(2, 2560, 0, 1080, 1920)];   // landscape + portrait
        const outputs = [out(0, 'DP-1', 0, 0, 2560, 1440), out(1, 'DP-2', 2560, 0, 1080, 1920)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 2560, height: 1440 } })).toMatchObject({ ok: true, displayId: 1, how: 'stream-size', output: { name: 'DP-1' } });
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1080, height: 1920 } })).toMatchObject({ ok: true, displayId: 2, output: { name: 'DP-2' } });
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1280, height: 720 } })).toMatchObject({ ok: true, displayId: 1 });   // downscaled 16:9
    });

    it('two IDENTICAL monitors with only an aspect-ratio hint: refused, never a guess', () => {
        const displays = [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1920, 1080)];
        const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080), out(1, 'DP-2', 1920, 0, 1920, 1080)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 } })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
        expect(matchWaylandOutput({ displays, outputs, frame: null })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
    });

    it('same aspect, different resolution: the exact physical size breaks the tie', () => {
        const displays = [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1280, 720)];
        const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080), out(1, 'DP-2', 1920, 0, 1280, 720)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1280, height: 720 } })).toMatchObject({ ok: true, displayId: 2 });
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 } })).toMatchObject({ ok: true, displayId: 1 });
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 960, height: 540 } })).toMatchObject({ ok: false, why: 'ambiguous' });
    });

    it('HiDPI: the frame is physical pixels, the display bounds are logical', () => {
        const displays = [disp(1, 0, 0, 1920, 1080, 2), disp(2, 1920, 0, 1080, 1920, 1)];
        const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080, 2), out(1, 'DP-2', 1920, 0, 1080, 1920)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 3840, height: 2160 } })).toMatchObject({ ok: true, displayId: 1 });
    });

    it('a share that is not the whole of any screen (a portal window) is refused', () => {
        const displays = [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1080, 1920)];
        const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080), out(1, 'DP-2', 1920, 0, 1080, 1920)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1000, height: 700 } })).toEqual({ ok: false, why: 'not_whole_screen' });
        // ...also on a single display
        expect(matchWaylandOutput({ displays: [displays[0]], outputs: [outputs[0]], frame: { width: 1000, height: 700 } })).toEqual({ ok: false, why: 'not_whole_screen' });
    });

    it('display_id wins when Chromium filled it', () => {
        const displays = [disp(11, 0, 0, 1920, 1080), disp(22, 1920, 0, 1920, 1080)];
        const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080), out(1, 'DP-2', 1920, 0, 1920, 1080)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 }, displayId: '22' }))
            .toMatchObject({ ok: true, displayId: 22, how: 'display-id', output: { name: 'DP-2' } });
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 }, displayId: '99' })).toMatchObject({ ok: false, why: 'ambiguous' });
    });

    it('displays are paired with outputs by logical rectangle, within a pixel', () => {
        const displays = [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1080, 1920)];
        const outputs = [out(0, 'DP-2', 1921, 0, 1080, 1920), out(1, 'DP-1', 0, 0, 1920, 1080)];   // helper order differs
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1080, height: 1920 } })).toMatchObject({ ok: true, displayId: 2, output: { name: 'DP-2', index: 0 } });
    });

    it('mirrored heads (two outputs, one logical rectangle) are not addressable', () => {
        const displays = [disp(1, 0, 0, 1920, 1080)];
        const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080), out(1, 'HDMI-1', 0, 0, 1920, 1080)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 } })).toEqual({ ok: false, why: 'no_pairs' });
    });

    it('displays Electron reports that the compositor does not match yield no pair', () => {
        expect(matchWaylandOutput({ displays: [disp(1, 0, 0, 1000, 1000), disp(2, 1000, 0, 1000, 1000)], outputs: [out(0, 'DP-1', 5, 5, 99, 99)], frame: null }))
            .toEqual({ ok: false, why: 'no_pairs' });
    });

    it('a lone display whose rectangle differs from the lone output is still the same screen', () => {
        expect(matchWaylandOutput({ displays: [disp(1, 0, 0, 1536, 864, 1.25)], outputs: [out(0, 'eDP-1', 0, 0, 1920, 1080)], frame: { width: 1920, height: 1080 } }))
            .toMatchObject({ ok: true, how: 'only-display' });
    });
});

describe('cleanFrameHint / frameCoversDisplay', () => {
    it('accepts sane integer sizes only', () => {
        expect(cleanFrameHint({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
        for (const bad of [null, undefined, 3, 'x', {}, { width: 1920 }, { width: 1920.5, height: 1080 }, { width: 8, height: 1080 }, { width: 99999, height: 1080 }, { width: NaN, height: 1080 }, { width: '1920', height: 1080 }])
            expect(cleanFrameHint(bad), JSON.stringify(bad)).toBeNull();
    });
    it('aspect tolerance is 1 percent', () => {
        const d = disp(1, 0, 0, 1920, 1080);
        expect(frameCoversDisplay({ width: 1920, height: 1080 }, d)).toBe(true);
        expect(frameCoversDisplay({ width: 1920, height: 1090 }, d)).toBe(true);
        expect(frameCoversDisplay({ width: 1920, height: 1100 }, d)).toBe(false);
        expect(frameCoversDisplay({ width: 1920, height: 0 }, d)).toBe(false);
    });
});

// ── main -> helper ──────────────────────────────────────────────────────────

describe('WaylandStrokeEncoder', () => {
    const t = 1_700_000_000_000;
    const enc = () => new WaylandStrokeEncoder(() => t);
    const stroke = (over: Record<string, unknown> = {}) => ({
        id: 's1', color: '#FF3B6B', width: 4, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], updatedAt: t, closedAt: 0, ...over,
    });

    it('turns an upsert into one U line: numeric id, lowercase hex colour, width x10, 16-bit points, stamps', () => {
        const e = enc();
        expect(e.encode({ upsert: [stroke({ points: [{ x: 0.5, y: 0.25 }, { x: 1, y: 0 }] })] }))
            .toEqual([`U 1 ff3b6b 40 ${t} 0 2 32768,16384 65535,0`]);
    });

    it('append, remove and reset', () => {
        const e = enc();
        e.encode({ upsert: [stroke()] });
        expect(e.encode({ append: [{ id: 's1', points: [{ x: 0.1, y: 0.2 }], updatedAt: t + 5, closedAt: 0 }] })).toEqual([`A 1 ${t + 5} 0 1 6554,13107`]);
        expect(e.encode({ append: [{ id: 's1', points: [], updatedAt: t + 6, closedAt: t + 6 }] })).toEqual([`A 1 ${t + 6} ${t + 6} 0`]);
        expect(e.encode({ remove: ['s1'] })).toEqual(['R 1']);
        expect(e.encode({ append: [{ id: 's1', points: [{ x: 0, y: 0 }], updatedAt: t, closedAt: 0 }] })).toEqual([]);   // unknown after remove
        expect(e.encode({ reset: true, upsert: [stroke({ id: 'z' })] })[0]).toBe('Z');
    });

    it('an append for a stroke it never saw begin is ignored, not invented', () => {
        expect(enc().encode({ append: [{ id: 'ghost', points: [{ x: 0, y: 0 }], updatedAt: t, closedAt: 0 }] })).toEqual([]);
    });

    it('points are clamped to [0,1] and non-numeric points dropped', () => {
        const e = enc();
        const [line] = e.encode({ upsert: [stroke({ points: [{ x: -5, y: 9 }, { x: NaN, y: 0 }, { x: 'a', y: 0 }, null, { x: 0.5 }, { x: 1, y: 1 }] })] });
        expect(line).toMatch(/ 2 0,65535 65535,65535$/);
    });

    it('rejects a colour that is not #RRGGBB (nothing reaches the helper)', () => {
        const e = enc();
        for (const color of ['red', '#fff', '#FF3B6B80', 'rgb(1,2,3)', '#GGGGGG', '', 5, null, undefined, '#ff3b6b;rm']) {
            expect(e.encode({ upsert: [stroke({ color })] }), String(color)).toEqual([]);
        }
        expect(e.stats.rejected).toBeGreaterThanOrEqual(10);
    });

    it('clamps width to 1..24 and defaults a malformed one', () => {
        const e = enc();
        expect(e.encode({ upsert: [stroke({ id: 'a', width: 999 })] })[0]).toMatch(/^U \d+ ff3b6b 240 /);
        expect(e.encode({ upsert: [stroke({ id: 'b', width: 0.1 })] })[0]).toMatch(/^U \d+ ff3b6b 10 /);
        expect(e.encode({ upsert: [stroke({ id: 'c', width: 'wide' })] })[0]).toMatch(/^U \d+ ff3b6b 40 /);
    });

    it('rejects ids that are not short strings', () => {
        const e = enc();
        for (const id of ['', 'x'.repeat(65), 7, null, {}, undefined]) expect(e.encode({ upsert: [stroke({ id })] }), String(id)).toEqual([]);
    });

    it('stamps outside a window around now are not trusted: a future closedAt cannot pin a stroke', () => {
        const e = enc();
        const [a] = e.encode({ upsert: [stroke({ id: 'a', updatedAt: t + 3_600_000, closedAt: t + 3_600_000 })] });
        expect(a).toBe(`U 1 ff3b6b 40 ${t} ${t} 2 0,0 65535,65535`);     // updatedAt -> now, closedAt -> closed NOW (fades)
        const [b] = e.encode({ upsert: [stroke({ id: 'b', updatedAt: 'x', closedAt: Number.NaN })] });
        expect(b).toBe(`U 2 ff3b6b 40 ${t} ${t} 2 0,0 65535,65535`);
        const [c] = e.encode({ upsert: [stroke({ id: 'c', updatedAt: t - 10_000, closedAt: t - 2_000 })] });
        expect(c).toBe(`U 3 ff3b6b 40 ${t - 10_000} ${t - 2_000} 2 0,0 65535,65535`);   // honest past stamps kept
    });

    it('caps points per stroke and splits long appends into bounded lines', () => {
        const e = enc();
        const many = Array.from({ length: MAX_POINTS_PER_STROKE + 500 }, (_, i) => ({ x: (i % 100) / 100, y: 0.5 }));
        const [u] = e.encode({ upsert: [stroke({ points: many })] });
        expect(u.split(' ')[6]).toBe(String(MAX_POINTS_PER_STROKE));
        const e2 = new WaylandStrokeEncoder(() => t);
        e2.encode({ upsert: [stroke()] });
        const lines = e2.encode({ append: [{ id: 's1', points: Array.from({ length: MAX_POINTS_PER_LINE * 2 + 3 }, () => ({ x: 0.5, y: 0.5 })), updatedAt: t, closedAt: 0 }] });
        // the token bucket allows the first chunks of a burst; none exceeds the per-line cap
        expect(lines.length).toBeGreaterThan(0);
        for (const l of lines) expect(Number(l.split(' ')[4])).toBeLessThanOrEqual(MAX_POINTS_PER_LINE);
    });

    it('a flood is rate limited: lines and points per second are capped, and it recovers', () => {
        let now = 0;
        const e = new WaylandStrokeEncoder(() => now);
        const sent = (): number => {
            let n = 0;
            for (let i = 0; i < 1000; i++) {
                n += e.encode({ upsert: [{ id: 'f' + (i % 4), color: '#ffffff', width: 4, points: [{ x: 0, y: 0 }], updatedAt: now, closedAt: 0 }] }).length;
            }
            return n;
        };
        const first = sent();
        expect(first).toBeLessThan(1000);          // the burst allowance (MAX_STROKES + 44 commands)
        expect(first).toBeGreaterThan(0);
        expect(e.stats.dropped).toBeGreaterThan(0);
        expect(sent()).toBe(0);                   // still empty: no time has passed
        now += 1000;                              // a second later, ~240 tokens are back
        const later = sent();
        expect(later).toBeGreaterThan(100);
        expect(later).toBeLessThanOrEqual(241);
    });

    it('evicts the oldest stroke id past the stroke cap and tells the helper to drop it', () => {
        let now = 0;
        const e = new WaylandStrokeEncoder(() => now);
        for (let i = 0; i < MAX_STROKES; i++) { now += 100; e.encode({ upsert: [{ id: `k${i}`, color: '#ffffff', width: 4, points: [], updatedAt: now, closedAt: 0 }] }); }
        now += 100;
        const lines = e.encode({ upsert: [{ id: 'new', color: '#ffffff', width: 4, points: [], updatedAt: now, closedAt: 0 }] });
        expect(lines[0]).toBe('R 1');
        expect(lines[1]).toMatch(new RegExp(`^U ${MAX_STROKES + 1} `));
    });

    it('rejects a delta that is not an object, and arrays that are not arrays', () => {
        const e = enc();
        for (const bad of [null, undefined, 3, 'x', [], { upsert: 'x', append: 7, remove: {} }]) expect(e.encode(bad)).toEqual([]);
    });

    it('never produces a line the helper would misparse: no control characters, one line per command', () => {
        const e = enc();
        const lines = e.encode({ upsert: [stroke({ id: 'a\nQUIT', color: '#ff3b6b' })], remove: ['b\nQUIT'] });
        for (const l of lines) expect(l).not.toMatch(/[\n\r\0]/);
        expect(lines.join('\n')).not.toContain('QUIT');
    });
});

describe('TokenBucket', () => {
    it('refills with time and never exceeds the burst', () => {
        const b = new TokenBucket(10, 5, 0);
        expect(b.take(5, 0)).toBe(true);
        expect(b.take(1, 0)).toBe(false);
        expect(b.take(1, 100)).toBe(true);          // 100 ms = 1 token
        expect(b.take(10, 10_000)).toBe(false);     // refilled to the burst (5), not 100
        expect(b.take(5, 10_000)).toBe(true);
    });
});

describe('matchWaylandOutput: the owner\'s three-monitor desk (2x 3440x1440 + 1x 1080x1920 portrait)', () => {
    const displays = [disp(1, 0, 0, 3440, 1440), disp(2, 3440, 0, 3440, 1440), disp(3, 6880, 0, 1080, 1920)];
    const outputs = [out(0, 'DP-1', 0, 0, 3440, 1440), out(1, 'DP-2', 3440, 0, 3440, 1440), out(2, 'DP-3', 6880, 0, 1080, 1920)];

    it('the two identical landscapes are ambiguous: the portrait one is NOT a candidate (rotation)', () => {
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 3440, height: 1440 } })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
    });

    it('the portrait monitor is unique by its own orientation, so no question is asked', () => {
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1080, height: 1920 } })).toMatchObject({ ok: true, displayId: 3, how: 'stream-size', output: { name: 'DP-3' } });
    });

    it('the sharer\'s answer resolves it, to exactly the chosen output', () => {
        const frame = { width: 3440, height: 1440 };
        expect(matchWaylandOutput({ displays, outputs, frame, chosenDisplayId: 2 })).toMatchObject({ ok: true, displayId: 2, how: 'chosen', output: { name: 'DP-2', index: 1 } });
        expect(matchWaylandOutput({ displays, outputs, frame, chosenDisplayId: 1 })).toMatchObject({ ok: true, displayId: 1, how: 'chosen', output: { name: 'DP-1' } });
    });

    it('negative controls: an answer naming the portrait display, an unknown id, or junk is NOT honoured', () => {
        const frame = { width: 3440, height: 1440 };
        for (const chosenDisplayId of [3, 99, -1, null, undefined]) {
            expect(matchWaylandOutput({ displays, outputs, frame, chosenDisplayId })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
        }
    });

    it('an answer never overrides a unique match: the frame decides first', () => {
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1080, height: 1920 }, chosenDisplayId: 1 })).toMatchObject({ ok: true, displayId: 3, how: 'stream-size' });
    });

    it('a downscaled capture of the pair is still ambiguous (aspect only)', () => {
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1720, height: 720 } })).toMatchObject({ ok: false, why: 'ambiguous', candidates: [1, 2] });
    });
});

describe('matchWaylandOutput: scaled and mixed desks', () => {
    it('two 4K panels at 200% (logical 1920x1080) + a 1080p: the 3840x2160 frame is ambiguous between the 4Ks only', () => {
        const displays = [disp(1, 0, 0, 1920, 1080, 2), disp(2, 1920, 0, 1920, 1080, 2), disp(3, 3840, 0, 1920, 1080, 1)];
        const outputs = [out(0, 'A', 0, 0, 1920, 1080, 2), out(1, 'B', 1920, 0, 1920, 1080, 2), out(2, 'C', 3840, 0, 1920, 1080)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 3840, height: 2160 } })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
        // the 1080p alone is unique by its EXACT physical size even though all three share an aspect ratio
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 } })).toMatchObject({ ok: true, displayId: 3 });
    });

    it('a rotated pair of identical portrait panels is ambiguous too, and the landscape frame matches neither', () => {
        const displays = [disp(1, 0, 0, 1080, 1920), disp(2, 1080, 0, 1080, 1920)];
        const outputs = [out(0, 'A', 0, 0, 1080, 1920), out(1, 'B', 1080, 0, 1080, 1920)];
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1080, height: 1920 } })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
        expect(matchWaylandOutput({ displays, outputs, frame: { width: 1920, height: 1080 } })).toEqual({ ok: false, why: 'not_whole_screen' });
    });

    it('no output pairs at all: nothing to choose between', () => {
        expect(matchWaylandOutput({ displays: [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1920, 1080)], outputs: [], frame: { width: 1920, height: 1080 } })).toEqual({ ok: false, why: 'no_pairs' });
    });

    it('cleanDisplayChoice accepts only a plain non-negative integer', () => {
        expect(cleanDisplayChoice(5)).toBe(5);
        for (const bad of [-1, 1.5, NaN, Infinity, '2', null, undefined, {}, 2 ** 40]) expect(cleanDisplayChoice(bad)).toBeNull();
    });
});

describe('matchWaylandOutput: the portal says which monitor (stream position + size)', () => {
    // Two IDENTICAL monitors side by side: the case that used to need the question.
    const displays = [disp(1, 0, 0, 3440, 1440), disp(2, 3440, 0, 3440, 1440), disp(3, 6880, 0, 1080, 1920)];
    const outputs = [out(0, 'DP-1', 0, 0, 3440, 1440), out(1, 'DP-2', 3440, 0, 3440, 1440), out(2, 'DP-3', 6880, 0, 1080, 1920)];
    const frame = { width: 3440, height: 1440 };
    const at = (x: number, y: number, width = 3440, height = 1440) => ({ stream: { x, y, width, height }, remembered: null });

    it('POSITIVE CONTROL: without the hint the identical monitors are ambiguous; with it each one resolves exactly', () => {
        expect(matchWaylandOutput({ displays, outputs, frame })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
        expect(matchWaylandOutput({ displays, outputs, frame, hint: at(0, 0) })).toMatchObject({ ok: true, displayId: 1, how: 'stream-position', output: { name: 'DP-1' } });
        expect(matchWaylandOutput({ displays, outputs, frame, hint: at(3440, 0) })).toMatchObject({ ok: true, displayId: 2, how: 'stream-position', output: { name: 'DP-2' } });
    });
    it('needs no frame size at all', () => {
        expect(matchWaylandOutput({ displays, outputs, frame: null, hint: at(3440, 0) })).toMatchObject({ ok: true, displayId: 2 });
    });
    it('a position that matches no display (or the right place with the wrong size) falls back to asking, never to a guess', () => {
        for (const hint of [at(1, 500), at(3440, 0, 1920, 1080), at(10000, 0), at(0, 0, 3440, 1000)]) {
            expect(matchWaylandOutput({ displays, outputs, frame, hint })).toEqual({ ok: false, why: 'ambiguous', candidates: [1, 2] });
        }
    });
    it('NEGATIVE: two displays claiming the same rectangle are never resolved to one of them', () => {
        const dup = [disp(1, 0, 0, 1920, 1080), disp(2, 0, 0, 1920, 1080)];
        const dupOut = [out(0, 'A', 0, 0, 1920, 1080), out(1, 'B', 1920, 0, 1920, 1080)];
        const r = matchWaylandOutput({ displays: dup, outputs: dupOut, frame: { width: 1920, height: 1080 }, hint: at(0, 0, 1920, 1080) });
        expect(r.ok).toBe(false);
    });
    it('absent / garbage hints are dropped by the validator, leaving the old behaviour', () => {
        for (const raw of [undefined, null, 5, 'x', {}, { stream: 'a' }, { stream: { x: 1.5, y: 0, width: 10, height: 10 } }, { stream: { x: 0, y: 0, width: 0, height: 10 } },
            { stream: { x: 1e9, y: 0, width: 10, height: 10 } }, { stream: { x: '0', y: 0, width: 10, height: 10 } }]) {
            expect(cleanShowHint(raw)).toEqual({ stream: null, remembered: null });
        }
        expect(cleanShowHint({ stream: { x: -1920, y: 0, width: 1920, height: 1080, extra: 1 } }).stream).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 });
    });
});

describe('matchWaylandOutput: the sharer\'s remembered answer', () => {
    const displays = [disp(1, 0, 0, 1920, 1080), disp(2, 1920, 0, 1920, 1080)];
    const outputs = [out(0, 'DP-1', 0, 0, 1920, 1080), out(1, 'DP-2', 1920, 0, 1920, 1080)];
    const frame = { width: 1920, height: 1080 };
    const layout = [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 1920, y: 0, width: 1920, height: 1080 }];
    const remembered = (chosen: { x: number; y: number; width: number; height: number }, l = layout) => ({ stream: null, remembered: { layout: l, chosen } });

    it('POSITIVE CONTROL: unchanged layout resolves to the remembered display; no hint asks', () => {
        expect(matchWaylandOutput({ displays, outputs, frame })).toMatchObject({ ok: false, why: 'ambiguous' });
        expect(matchWaylandOutput({ displays, outputs, frame, hint: remembered(layout[1]) })).toMatchObject({ ok: true, displayId: 2, how: 'remembered', output: { name: 'DP-2' } });
        expect(matchWaylandOutput({ displays, outputs, frame, hint: remembered(layout[0]) })).toMatchObject({ ok: true, displayId: 1, how: 'remembered' });
    });
    it('layout changed (moved, resized, a monitor added or removed) invalidates it', () => {
        const moved = [layout[0], { x: 1920, y: 100, width: 1920, height: 1080 }];
        expect(matchWaylandOutput({ displays, outputs, frame, hint: remembered(layout[1], moved) })).toMatchObject({ ok: false, why: 'ambiguous' });
        const three = [...layout, { x: 3840, y: 0, width: 1080, height: 1920 }];
        expect(matchWaylandOutput({ displays, outputs, frame, hint: remembered(layout[1], three) })).toMatchObject({ ok: false, why: 'ambiguous' });
        expect(matchWaylandOutput({ displays, outputs, frame, hint: remembered(layout[1], [layout[0]]) })).toMatchObject({ ok: false, why: 'ambiguous' });
    });
    it('a remembered rectangle that is no display now, or an explicit answer, behaves correctly', () => {
        expect(matchWaylandOutput({ displays, outputs, frame, hint: remembered({ x: 7, y: 7, width: 1920, height: 1080 }) })).toMatchObject({ ok: false, why: 'ambiguous' });
        expect(matchWaylandOutput({ displays, outputs, frame, chosenDisplayId: 1, hint: remembered(layout[1]) })).toMatchObject({ ok: true, displayId: 1, how: 'chosen' });
    });
    it('sameLayout ignores order but not membership', () => {
        expect(sameLayout([layout[1], layout[0]], layout)).toBe(true);
        expect(sameLayout([layout[0], layout[0]], layout)).toBe(false);
    });
});
