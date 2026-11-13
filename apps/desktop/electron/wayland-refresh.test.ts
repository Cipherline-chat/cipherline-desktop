import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    mhzToHz, parseOutputsDump, pairRefreshWithDisplays, createWaylandRefreshProbe, effectiveDisplayHz,
    REFRESH_CACHE_MS, REFRESH_FAIL_CACHE_MS,
} from './wayland-refresh';
import { parseHelperLine, type DisplayLite } from './annotation-overlay-wayland-protocol';

const disp = (id: number, x: number, y: number, w: number, h: number): DisplayLite => ({ id, bounds: { x, y, width: w, height: h }, scaleFactor: 1 });
const OUT0 = 'OUT 0 DP-1 0 0 3440 1440 1 3440 1440';
const OUT1 = 'OUT 1 HDMI-A-1 3440 0 1920 1080 1 1920 1080';

describe('mhzToHz', () => {
    it('rounds the compositor mHz to whole Hz', () => {
        expect(mhzToHz(59940)).toBe(60);
        expect(mhzToHz(143981)).toBe(144);
        expect(mhzToHz(90000)).toBe(90);
    });
    it('garbage is unknown, never a limit', () => {
        for (const bad of [0, -60000, NaN, Infinity, 5, 9000, 2_000_000, '60000', null, undefined]) expect(mhzToHz(bad)).toBeNull();
    });
});

describe('HZ line', () => {
    it('parses exactly-formed lines', () => {
        expect(parseHelperLine('HZ 0 143981')).toEqual({ kind: 'hz', index: 0, mhz: 143981 });
    });
    it('rejects malformed ones', () => {
        for (const l of ['HZ', 'HZ 0', 'HZ 0 60000 1', 'HZ x 60000', 'HZ 0 abc', 'HZ 0 0', 'HZ 0 -5', 'HZ 16 60000', 'HZ 0 99999999999', 'HZ 0 6e4']) {
            expect(parseHelperLine(l)).toBeNull();
        }
    });
    it('the OUT line keeps its old shape (an 11th field is still refused)', () => {
        expect(parseHelperLine(OUT0)?.kind).toBe('out');
        expect(parseHelperLine(OUT0 + ' 143981')).toBeNull();
    });
});

describe('pairing with Electron displays', () => {
    const dump = ['HELLO 1', OUT0, 'HZ 0 143981', OUT1, 'HZ 1 59940', 'garbage', 'HZ 1 oops'].join('\n');
    it('maps each display to its own output by identical logical rectangle', () => {
        const m = pairRefreshWithDisplays([disp(7, 0, 0, 3440, 1440), disp(9, 3440, 0, 1920, 1080)], parseOutputsDump(dump));
        expect(m.get(7)).toBe(144);
        expect(m.get(9)).toBe(60);
    });
    it('NEGATIVE: swapping the rectangles swaps the answer (the pairing is what decides, not the order)', () => {
        const m = pairRefreshWithDisplays([disp(7, 3440, 0, 1920, 1080), disp(9, 0, 0, 3440, 1440)], parseOutputsDump(dump));
        expect(m.get(7)).toBe(60);
        expect(m.get(9)).toBe(144);
    });
    it('a display with no matching output, or with mirrored outputs, is left out rather than guessed', () => {
        const mirrored = ['HELLO 1', OUT0, 'HZ 0 60000', 'OUT 1 DP-2 0 0 3440 1440 1 3440 1440', 'HZ 1 144000'].join('\n');
        expect(pairRefreshWithDisplays([disp(1, 0, 0, 3440, 1440)], parseOutputsDump(mirrored)).size).toBe(0);
        expect(pairRefreshWithDisplays([disp(1, 100, 100, 800, 600), disp(2, 5, 5, 5, 5)], parseOutputsDump(dump)).size).toBe(0);
    });
    it('one display + one output pair without a rectangle check', () => {
        const one = ['OUT 0 DP-1 0 0 1720 720 2 3440 1440', 'HZ 0 120000'].join('\n');
        expect(pairRefreshWithDisplays([disp(3, 0, 0, 999, 999)], parseOutputsDump(one)).get(3)).toBe(120);
    });
    it('an output that reported no HZ, or an absurd one, stays unknown', () => {
        const d = ['OUT 0 DP-1 0 0 3440 1440 1 3440 1440', 'HZ 0 7'].join('\n');
        expect(pairRefreshWithDisplays([disp(1, 0, 0, 3440, 1440)], parseOutputsDump(d)).size).toBe(0);
        expect(pairRefreshWithDisplays([disp(1, 0, 0, 3440, 1440)], parseOutputsDump(OUT0)).size).toBe(0);
    });
    it('bounds the work on a hostile dump', () => {
        const big = Array.from({ length: 5000 }, (_, i) => `OUT ${i % 16} N${i} 0 0 10 10 1 10 10`).join('\n');
        expect(parseOutputsDump(big).outputs.length).toBeLessThanOrEqual(16);
    });
});

describe('probe', () => {
    const mk = (run: () => Promise<string | null>) => {
        let t = 0; let runs = 0;
        const probe = createWaylandRefreshProbe({
            run: () => { runs++; return run(); },
            getDisplays: () => [disp(7, 0, 0, 3440, 1440)],
            now: () => t,
        });
        return { probe, advance: (ms: number) => { t += ms; }, runs: () => runs };
    };
    const good = [OUT0, 'HZ 0 143981'].join('\n');
    it('runs once for concurrent callers and caches', async () => {
        const h = mk(async () => good);
        const [a, b] = await Promise.all([h.probe.get(), h.probe.get()]);
        expect(a.get(7)).toBe(144); expect(b).toBe(a);
        await h.probe.get();
        expect(h.runs()).toBe(1);
        h.advance(REFRESH_CACHE_MS + 1);
        await h.probe.get();
        expect(h.runs()).toBe(2);
    });
    it('failure (null, throw) is "unknown" and retried sooner', async () => {
        for (const run of [async () => null, async () => { throw new Error('spawn'); }]) {
            const h = mk(run);
            expect((await h.probe.get()).size).toBe(0);
            h.advance(REFRESH_FAIL_CACHE_MS + 1);
            await h.probe.get();
            expect(h.runs()).toBe(2);
        }
    });
});

describe('effectiveDisplayHz', () => {
    it("Electron's own value wins when real; the compositor fills 0 / missing", () => {
        const wl = new Map([[7, 144]]);
        expect(effectiveDisplayHz(165, 7, wl)).toBe(165);
        expect(effectiveDisplayHz(0, 7, wl)).toBe(144);
        expect(effectiveDisplayHz(undefined, 7, wl)).toBe(144);
        expect(effectiveDisplayHz(0, 8, wl)).toBe(0);
        expect(effectiveDisplayHz(NaN, 8, wl)).toBe(0);
    });
});

describe('wiring', () => {
    const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
    it('main feeds the real refresh to the picker, the share diagnostics and the report', () => {
        const main = read('main.ts');
        expect((main.match(/displaysWithRealRefresh\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4); // definition + 3 uses
        expect(main).toMatch(/display:get-refresh-rates', async/);
    });
    it('the helper has a one-shot --outputs mode that prints HZ from wl_output.mode', () => {
        const c = readFileSync(join(__dirname, '..', 'src-native', 'wayland_overlay', 'cl_wayland_overlay.c'), 'utf8');
        expect(c).toMatch(/"--outputs"/);
        expect(c).toMatch(/say\("HZ %d %d"/);
        expect(c).toMatch(/out->refresh_mhz = r/);
    });
    it('the one-shot is spawned with the minimal helper environment and a deadline, never a resident process', () => {
        const o = read('annotation-overlay.ts');
        expect(o).toMatch(/execFile\(bin, \['--outputs'\], \{ env: waylandHelperEnv\(\), timeout: 1500/);
    });
});
