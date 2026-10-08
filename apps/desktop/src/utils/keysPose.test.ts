import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    BOX, CENTER, TILT, swimEnvelope, logoToScreen, tiltHomography, applyHomography, tiltToward,
} from './keysPose';

/**
 * Keys must be upright at every moment and never clipped by his sprite. A
 * shipped preview drew him upside down and cut in half: the ray/plane maths
 * in the shader had a flipped sign, which point-mirrors every pixel (180°)
 * and, once tilted, slides him sideways out of his sprite. These tests pin
 * the maths the worker now uploads (tiltHomography) and the motion envelope.
 */

const extremes: Array<[number, number]> = [];
for (const px of [-1, 0, 1]) for (const py of [-1, 0, 1]) {
    const { ax, ay } = tiltToward(px, py, 1);
    extremes.push([ax, ay]);
}

describe('orientation', () => {
    it('untilted, the sprite maps straight onto him: no mirror, no flip, no shift', () => {
        const H = tiltHomography(0, 0);
        for (const [x, y] of [[10, 5], [-20, 30], [0, -40], [33, -12]]) {
            const [u, v] = applyHomography(H, x, y);
            expect(u).toBeCloseTo(x, 6);
            expect(v).toBeCloseTo(y, 6);
        }
    });

    it('is upright at every tilt: the dome is above the legs, left is left', () => {
        for (const [ax, ay] of extremes) {
            const domeTop = logoToScreen(ax, ay, 0, 14 - CENTER.y);
            const legTip = logoToScreen(ax, ay, 0, 78 - CENTER.y);
            expect(domeTop[1]).toBeLessThan(legTip[1] - 50); // y down: the dome is higher on screen
            const left = logoToScreen(ax, ay, 21 - CENTER.x, 0);
            const right = logoToScreen(ax, ay, 89 - CENTER.x, 0);
            expect(left[0]).toBeLessThan(right[0] - 50);
            // and the homography is the true inverse of what we draw
            const H = tiltHomography(ax, ay);
            for (const [u, v] of [[-34, -32], [34, 32], [0, 0], [20, -10]]) {
                const [sx, sy] = logoToScreen(ax, ay, u, v);
                const back = applyHomography(H, sx, sy);
                expect(back[0]).toBeCloseTo(u, 4);
                expect(back[1]).toBeCloseTo(v, 4);
            }
        }
    });

    it('stays a tilt, never a roll: his centre line stays vertical-ish and centred', () => {
        for (const [ax, ay] of extremes) {
            const top = logoToScreen(ax, ay, 0, -32);
            const bottom = logoToScreen(ax, ay, 0, 32);
            // the vertical through his centre leans at most a degree or two
            expect(Math.abs(Math.atan2(bottom[0] - top[0], bottom[1] - top[1]))).toBeLessThan(0.035);
            const c = logoToScreen(ax, ay, 0, 0);
            expect(Math.hypot(c[0], c[1])).toBeLessThan(1e-9);
        }
    });

    it('faces the pointer: the side toward it turns away (gets smaller)', () => {
        const right = tiltToward(1, 0, 1);
        const r = logoToScreen(right.ax, right.ay, 34, 0)[0];
        const l = logoToScreen(right.ax, right.ay, -34, 0)[0];
        expect(Math.abs(r)).toBeLessThan(Math.abs(l));
        const up = tiltToward(0, 1, 1);
        const top = logoToScreen(up.ax, up.ay, 0, -32)[1];
        const bot = logoToScreen(up.ax, up.ay, 0, 32)[1];
        expect(Math.abs(top)).toBeLessThan(Math.abs(bot));
        // and returns upright when the pointer leaves
        expect(tiltToward(1, 1, 0)).toEqual({ ax: -0, ay: -0 });
        expect(Math.abs(right.ay)).toBeCloseTo(TILT.y, 9);
    });
});

describe('never clipped', () => {
    it('his whole swim envelope, at every tilt, fits inside his sprite with room to spare', () => {
        const env = swimEnvelope();
        const half = BOX / 2;
        for (const [ax, ay] of extremes) {
            for (const x of [env.x0, env.x1]) for (const y of [env.y0, env.y1]) {
                const [sx, sy] = logoToScreen(ax, ay, x - CENTER.x, y - CENTER.y);
                expect(Math.abs(sx)).toBeLessThan(half * 0.9);
                expect(Math.abs(sy)).toBeLessThan(half * 0.9);
            }
        }
        // sanity: the envelope really is bigger than the mark at rest
        expect(env.x0).toBeLessThan(21);
        expect(env.x1).toBeGreaterThan(89);
        expect(env.y1).toBeGreaterThan(78);
        expect(env.y0).toBeLessThan(14);
    });

    it('the worker draws with exactly this maths and these sizes', () => {
        const worker = readFileSync(join(__dirname, '../workers/loadingScreen.worker.ts'), 'utf8');
        expect(worker).toMatch(/from '\.\.\/utils\/keysPose'/);
        expect(worker).toMatch(/tiltHomography\(/);
        expect(worker).toMatch(/uniformMatrix3fv\(u\.uTilt, false,/);
        // no hand-rolled ray casting left in the shader
        expect(worker).not.toMatch(/dirv|vec3\(0\.0, 0\.0, -D\)/);
        // the sprite and the swim come from keysPose, not literals
        expect(worker).not.toMatch(/const BOX = /);
        expect(worker).toMatch(/SWIM\.contractIn/);
    });
});
