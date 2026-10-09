/**
 * The checkbox tick is drawn by a stroke-dashoffset animation. Under
 * prefers-reduced-motion (Windows "Animation effects" off) cl-kit.css sets
 * `animation: none` on everything, so a tick that only reached its visible
 * state through the animation's `forwards` fill stayed hidden: a checked box
 * looked blank (seen on the sign-up Terms box). The checked rule must itself
 * hold the visible end state; the animation only plays the draw-on.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const styles = path.join(__dirname, '../../styles');
const rule = (css: string, sel: string) => {
    const i = css.indexOf(sel + '{');
    return i < 0 ? null : css.slice(i, css.indexOf('}', i) + 1);
};

describe('checkbox tick without animations', () => {
    for (const file of ['cl-kit.css', 'cl-kit-fallback.css']) {
        it(`${file}: the checked tick is visible without relying on the animation`, () => {
            const r = rule(fs.readFileSync(path.join(styles, file), 'utf8'), '.clc.on .chk');
            expect(r).not.toBeNull();
            expect(r).toMatch(/stroke-dashoffset:0[;}]/);
            expect(r).not.toMatch(/\bforwards\b/);
        });
    }

    it('the draw keyframes start from the hidden offset (so the draw-on still plays)', () => {
        const css = fs.readFileSync(path.join(styles, 'cl-kit.css'), 'utf8');
        expect(css).toMatch(/@keyframes draw\{from\{stroke-dashoffset:16\}to\{stroke-dashoffset:0\}\}/);
    });

    it('control: the old rule shape is what this test rejects', () => {
        const old = '.clc.on .chk{animation:draw .28s ease-out .05s forwards}';
        expect(rule(old, '.clc.on .chk')).not.toMatch(/stroke-dashoffset:0[;}]/);
    });
});
