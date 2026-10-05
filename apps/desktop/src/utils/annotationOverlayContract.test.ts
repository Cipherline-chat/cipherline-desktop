/**
 * The desktop annotation overlay's preload is the one piece of this feature
 * that no other test can reach: it `import`s `electron`, so it cannot be
 * imported into vitest, and it renders into a window that only exists during a
 * real screen share, so the packaged smoke test never sees it either.
 *
 * That blind spot has already cost a shipped regression. When the pen was
 * removed and `tool` was dropped from `Stroke`, the renderer's `toWire` (in
 * desktopAnnotationOverlay.ts) stopped sending the field — but the preload's
 * `cleanStroke` still had `if (s.tool !== 'pen' && s.tool !== 'laser') return
 * null;`. Every upsert was therefore rejected as malformed and the overlay
 * silently drew NOTHING, with no error anywhere: the two halves of one wire
 * format drifted apart and nothing was watching.
 *
 * So this file watches, by reading both sources as text. It is deliberately a
 * small number of load-bearing assertions rather than a parser — enough to
 * fail loudly the next time one side of the format moves without the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LASER_TTL_MS, STROKE_IDLE_MS } from './annotationStore';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(here, rel), 'utf8');
/** Comments explain why a field is GONE, which would otherwise trip the
 *  "nobody mentions it any more" assertions below. Match on code only. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const preload = read('../../electron/annotation-overlay-preload.ts');
const sender = read('./desktopAnnotationOverlay.ts');
const inApp = read('../components/call/AnnotationOverlay.tsx');
const preloadCode = code(preload);
const senderCode = code(sender);
const inAppCode = code(inApp);

describe('desktop overlay preload ↔ renderer wire contract', () => {
    it('the preload runs both of the store\'s clocks, at the store\'s values', () => {
        const ttl = /const LASER_TTL_MS = (\d+);/.exec(preload);
        expect(ttl, 'preload no longer declares LASER_TTL_MS').not.toBeNull();
        expect(Number(ttl![1])).toBe(LASER_TTL_MS);
        const idle = /const STROKE_IDLE_MS = (\w+);/.exec(preload);
        expect(idle, 'preload no longer declares STROKE_IDLE_MS').not.toBeNull();
        // Declared as `LASER_TTL_MS` (they are the same number by design) or
        // spelled out — either way it must equal the store's.
        const idleValue = idle![1] === 'LASER_TTL_MS' ? LASER_TTL_MS : Number(idle![1]);
        expect(idleValue).toBe(STROKE_IDLE_MS);
    });

    it('the preload does not require a field the sender stopped sending', () => {
        // The exact shipped bug. `tool` left Stroke with the pen; if the
        // preload ever gates on it again while toWire omits it, the overlay
        // goes blank again.
        expect(senderCode).not.toMatch(/\btool\b/);
        expect(preloadCode).not.toMatch(/\btool\b/);
        // Same class of drift, the fields that just left: per-point `at`
        // stamps and the `dropped` head-trim counter. Neither side may still
        // be reading or writing them.
        for (const [name, src] of [['sender', senderCode], ['preload', preloadCode]] as const) {
            expect(src, `${name} still references the removed per-point 'at'`).not.toMatch(/\bat:\s/);
            expect(src, `${name} still references the removed 'dropped'`).not.toMatch(/\bdropped\b/);
        }
    });

    it('both halves speak the two stroke clocks', () => {
        // updatedAt feeds the watchdog, closedAt the fade. The preload ages
        // strokes on its own clock rather than holding whatever frame it was
        // last sent, so both stamps have to be on every delta and validated.
        expect(senderCode).toMatch(/updatedAt:\s*s\.updatedAt/);
        expect(senderCode).toMatch(/closedAt:\s*s\.closedAt/);
        expect(preloadCode).toMatch(/function cleanStamp\(/);
        expect(preloadCode).toMatch(/closedAt:\s*cleanStamp\(/);
    });

    it('the preload closes an abandoned stroke and fades a closed one', () => {
        // The watchdog: no new points for STROKE_IDLE_MS closes it, whether or
        // not a release ever arrives. Then the whole stroke fades over the TTL.
        // A stroke stuck live was what pinned a mark on the streamer's real
        // desktop for the rest of the call.
        expect(preloadCode).toMatch(/now - s\.updatedAt >= STROKE_IDLE_MS/);
        expect(preloadCode).toMatch(/now - s\.closedAt >= LASER_TTL_MS/);
    });

    it('the preload keeps animating while any stroke is on screen', () => {
        // A live stroke is waiting on its watchdog and a closed one is
        // mid-fade; neither can wait for the next delta to arrive.
        expect(preloadCode).toMatch(/strokes\.size > 0 && raf == null/);
    });
});

/**
 * Both renderers paint the same thing and must paint it the same way. These
 * are performance and appearance regressions that no unit test can see,
 * measured on a simulated 4K surface (deviceScaleFactor 3, a 1280x720 tile,
 * one long stroke plus four remote ones):
 *
 *   per-segment stroking, dpr 3, 900 points ... 459 ms/frame
 *   one path + shadowBlur, same load ......... 412 ms/frame
 *   one path + two-pass glow, capped at 2x .... 30 ms/frame
 */
describe('both renderers share the same draw discipline', () => {
    const renderers = [['in-app overlay', inAppCode], ['desktop overlay preload', preloadCode]] as const;

    it('draws each stroke as ONE path, not one path per segment', () => {
        // Per-segment stroking is what per-point opacity forces, and it is
        // both the 15x cost above and the "dots on the trail" artifact:
        // adjacent round line caps compositing at differing alphas read as
        // beads rather than a continuous line. One beginPath per stroke.
        for (const [name, src] of renderers) {
            const opens = src.match(/\.beginPath\(\)/g) ?? [];
            expect(opens.length, `${name} opens ${opens.length} paths; the draw loop must open exactly one per stroke`).toBe(1);
        }
    });

    it('never sets a non-zero shadowBlur', () => {
        // shadowBlur is a gaussian over the drawn geometry's bounding box.
        // Survivable per tiny segment; applied to a whole-stroke path it
        // blurs the entire surface every frame. The glow is geometry now — a
        // wide translucent halo stroke under a bright core.
        for (const [name, src] of renderers) {
            const blurs = src.match(/shadowBlur\s*=\s*([^;]+);/g) ?? [];
            for (const b of blurs) {
                expect(b, `${name} sets a non-zero shadowBlur: ${b}`).toMatch(/shadowBlur\s*=\s*0\s*;/);
            }
            expect(src, `${name} still sets a shadowColor`).not.toMatch(/shadowColor/);
        }
    });

    it('caps the canvas backing store so a 4K panel does not pay for 3x', () => {
        // The FILL-RATE ceiling, and the one discipline both renderers share:
        // past 2x the extra device pixels are invisible on a soft glowing line
        // and cost real frame time. The in-app overlay reaches it through
        // effectiveDpr(w, h, window.devicePixelRatio) and so names its
        // parameter `rawDpr`; the preload applies it directly. Either spelling
        // satisfies the rule — what must not happen is sizing at the raw ratio.
        for (const [name, src] of renderers) {
            expect(src, `${name} sizes its backing store at the raw devicePixelRatio`)
                .toMatch(/Math\.min\(MAX_BACKING_SCALE, (?:window\.devicePixelRatio|rawDpr) \|\| 1\)/);
        }
    });

    it('gives the in-app overlay — and only it — an allocation budget on top', () => {
        // The two renderers deliberately DIVERGE here, and the divergence is
        // pinned so it stays deliberate.
        //
        // The in-app canvas is the only one that can sit inside a CSS
        // transform: the focused tile's wheel-zoom (utils/videoZoomPan, up to
        // 5x) wraps both the <video> and this canvas in one scaled layer, and
        // getBoundingClientRect() reports the TRANSFORMED box. So the store it
        // asks for is inflated by the zoom on top of whatever the 2x cap
        // allowed, and past ~16384px per axis Chromium refuses the allocation
        // outright — the canvas goes blank and strokes vanish with no error.
        // Hence the extra per-axis + total-area ceilings.
        //
        // The preload overlay is a bare always-on-top window with no transform
        // anywhere above its canvas, so that inflation cannot happen. Giving it
        // the same area budget would be a pure regression: an always-fullscreen
        // 4K surface (3840x2160 CSS px) is ~33 MPx at dpr 2, so a 16 MPx budget
        // would pull it down to ~1.4x and cost crispness to guard against a
        // hazard it does not have.
        expect(inAppCode, 'in-app overlay lost its allocation budget')
            .toMatch(/MAX_CANVAS_DIM[\s\S]*MAX_CANVAS_AREA/);
        expect(preloadCode, 'preload picked up an allocation budget it does not need — see above')
            .not.toMatch(/MAX_CANVAS_(?:DIM|AREA)/);
    });

    it('applies ONE opacity per PASS, never one per point', () => {
        for (const [name, src] of renderers) {
            expect(src, `${name} still fades per point`).not.toMatch(/pointAlpha/);
            // globalAlpha is set once inside the glow-layer loop, once for the
            // core, once for the hot centre, and reset once at the end — four
            // assignments in the source, none of them inside a POINT loop.
            // (The count is a proxy; what it is really guarding is that the
            // number of assignments is a property of the glow recipe, not of
            // how many points a stroke happens to have.)
            const sets = src.match(/globalAlpha\s*=/g) ?? [];
            expect(sets.length, `${name} sets globalAlpha ${sets.length} times`).toBe(4);
            // The point loop builds the path and nothing else: no styling call
            // may appear between moveTo and the end of the lineTo loop.
            expect(src, `${name} styles inside its point loop`)
                .not.toMatch(/for \(let i = 1; i < n; i\+\+\)[^\n]*(?:globalAlpha|lineWidth|strokeStyle)/);
        }
    });

    /**
     * The glow recipe itself. Both renderers paint the SAME strokes — the
     * in-call tile onto the video, the preload onto the sharer's real desktop
     * — so a divergence here means a viewer points at something that looks
     * like one thing to them and another thing to the person being pointed at.
     *
     * It is also the reproducibility guarantee for the wire: every number in
     * the recipe is a module constant and the only per-stroke inputs are
     * `color` and `width`, both of which travel in the packet. A receiver can
     * therefore rebuild a stroke's exact appearance from what it was sent,
     * with nothing local-only in the picture — which is what makes "everyone
     * sees the same mark" true rather than approximately true.
     */
    it('both renderers use the identical graded glow ramp', () => {
        const ramp = (src: string) => {
            const m = /GLOW_LAYERS[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
            expect(m, 'renderer no longer declares GLOW_LAYERS').not.toBeNull();
            return [...m![1].matchAll(/\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)].map(x => [Number(x[1]), Number(x[2])]);
        };
        const [inApp, preloadRamp] = [ramp(inAppCode), ramp(preloadCode)];
        expect(inApp.length, 'the glow needs more than one band or it has a hard edge again').toBeGreaterThanOrEqual(3);
        expect(preloadRamp).toEqual(inApp);
        // Widest+faintest first, strictly narrowing and strictly brightening
        // inward — that monotonicity IS the fade the owner asked for. A ramp
        // that is not sorted paints a band over a brighter one and the edge
        // comes back.
        for (let i = 1; i < inApp.length; i++) {
            expect(inApp[i][0], 'glow layers must narrow inward').toBeLessThan(inApp[i - 1][0]);
            expect(inApp[i][1], 'glow layers must brighten inward').toBeGreaterThan(inApp[i - 1][1]);
        }
        // The outermost band must be faint enough not to read as an edge of
        // its own. 0.28 was the single flat halo this replaced, and it was
        // reported as "a hard semi transparent color".
        expect(inApp[0][1], 'the outermost glow band is as hard as the one it replaced').toBeLessThan(0.15);
        // The white-hot centre, same value on both sides.
        for (const k of ['HOT_CORE_WIDTH', 'HOT_CORE_ALPHA'] as const) {
            const re = new RegExp(`${k}\\s*=\\s*([\\d.]+)`);
            const a = re.exec(inAppCode), b = re.exec(preloadCode);
            expect(a, `in-app overlay lost ${k}`).not.toBeNull();
            expect(b, `preload lost ${k}`).not.toBeNull();
            expect(Number(b![1]), `${k} differs between the two renderers`).toBe(Number(a![1]));
        }
    });
});
