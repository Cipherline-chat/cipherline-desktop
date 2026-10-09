/**
 * Resting state vs. animation end state, for the OS "reduce motion" setting
 * (Windows "Animation effects" off, macOS "Reduce motion").
 *
 * Chromium never turns animations off by itself: it only exposes
 * `prefers-reduced-motion: reduce`, and OUR css reacts with `animation: none`
 * (cl-kit.css does it for everything inside `.cl-kit`; brand.css does it for
 * the whole website). An element whose visible state is reached ONLY through a
 * `forwards`/`both` fill then renders its resting rule, and an element that
 * should disappear through an animation end state just stays. Two instances
 * found by the sweep (the first, the `.clc` tick, was fixed in eb9bac9f):
 *
 *   - `.cl-check .cl-chk` — the unscoped copy of the checkbox tick (desktop
 *     index.css, and brand.css which the website loads twice). Same bug: the
 *     tick was hidden at rest and only drawn by the `forwards` animation.
 *   - `.auth-lume-bloom` — the one-shot "lume bloom" behind the sign-in screen.
 *     Its keyframes carry the centring `translate(-50%,-50%)` and end at
 *     opacity 0, so with animation off it sat at full opacity, un-centred, as a
 *     permanent 640px teal blob at the lower right of every auth screen.
 *
 * The rule for both: the RESTING rule holds the right final state (tick drawn;
 * bloom invisible) and the animation only plays the transition to/from it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const src = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(src, p), 'utf8');
// apps/website is not part of the public desktop export (scripts/release/export-public-desktop.sh):
// check the website stylesheet when it's there, skip it in the standalone public tree.
const websiteBrandPath = path.join(src, '../../website/src/styles/brand.css');
const websiteBrand = fs.existsSync(websiteBrandPath) ? fs.readFileSync(websiteBrandPath, 'utf8') : null;

/** Every `{...}` body whose selector is exactly `sel` (the css here is minified one-rule-per-line or plain). */
const bodies = (css: string, sel: string): string[] => {
    const out: string[] = [];
    const re = new RegExp('(^|[}\\s])' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) out.push(m[2]);
    return out;
};
const keyframes = (css: string, name: string): string | null => {
    const i = css.indexOf('@keyframes ' + name + '{');
    if (i < 0) return null;
    let depth = 0;
    for (let j = css.indexOf('{', i); j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}' && --depth === 0) return css.slice(i, j + 1);
    }
    return null;
};

describe('unscoped checkbox tick (.cl-check .cl-chk) without animations', () => {
    const files: Array<[string, string]> = [
        ['apps/desktop/src/index.css', read('index.css')],
        ...(websiteBrand !== null ? [['apps/website/src/styles/brand.css', websiteBrand] as [string, string]] : []),
    ];
    for (const [name, css] of files) {
        it(`${name}: every checked-tick rule holds stroke-dashoffset:0 itself and does not rely on a forwards fill`, () => {
            const rules = bodies(css, '.cl-check.is-on .cl-chk');
            expect(rules.length).toBeGreaterThan(0);
            for (const r of rules) {
                expect(r).toMatch(/stroke-dashoffset:0[;}]?/);
                expect(r).not.toMatch(/\bforwards\b/);
            }
        });
        it(`${name}: cl-draw starts from the hidden offset so the draw-on still plays`, () => {
            const kf = keyframes(css, 'cl-draw');
            expect(kf).not.toBeNull();
            expect(kf).toMatch(/from\{stroke-dashoffset:16\}/);
            expect(kf).toMatch(/to\{stroke-dashoffset:0\}/);
        });
    }

    it('control: the old rule shape is rejected', () => {
        const old = '.cl-check.is-on .cl-chk{animation:cl-draw .28s ease-out .05s forwards}';
        const [r] = bodies(old, '.cl-check.is-on .cl-chk');
        expect(r).not.toMatch(/stroke-dashoffset:0/);
        expect(r).toMatch(/\bforwards\b/);
    });
});

describe('sign-in lume bloom without animations', () => {
    const css = read('index.css');

    it('the resting rule is invisible (an animation-less bloom must not linger)', () => {
        const [r] = bodies(css, '.auth-lume-bloom');
        expect(r).toBeDefined();
        expect(r).toMatch(/(^|;)\s*opacity:0\s*(;|$)/);
    });

    it('control: the animation still plays the bloom (peaks above 0 mid-way)', () => {
        const [r] = bodies(css, '.auth-lume-bloom');
        expect(r).toMatch(/animation:auth-lume-bloom\b/);
        const kf = keyframes(css, 'auth-lume-bloom');
        expect(kf).not.toBeNull();
        expect(kf).toMatch(/25%\{opacity:\.72\}/);
    });

    it('control: the old rule (no resting opacity) is rejected', () => {
        const old = '.auth-lume-bloom{position:absolute;top:42%;left:50%;width:640px;animation:auth-lume-bloom 1.1s both}';
        const [r] = bodies(old, '.auth-lume-bloom');
        expect(r).not.toMatch(/(^|;)\s*opacity:0\s*(;|$)/);
    });
});
