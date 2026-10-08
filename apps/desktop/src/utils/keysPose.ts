/**
 * Keys' pose on the loading screen, as plain maths the tests can check: the
 * swim's deformation limits, the perspective tilt toward the pointer, and the
 * sprite box he is drawn in. The worker (workers/loadingScreen.worker.ts)
 * builds its shader from these constants and uploads tiltHomography()'s
 * matrix as-is, so what is tested here is exactly what draws.
 *
 * Coordinates are the logo's own (apps/website/public/logo.svg, 110×90,
 * SVG space: y DOWN), centred on the mark's bounds (x 21..89, y 14..78):
 * CENTER is (55, 46). Screen offsets inside his sprite use the same units
 * and the same y-down orientation (gl_PointCoord's origin is the top-left).
 */

export const CENTER = { x: 55, y: 46 } as const;

/** The sprite square he is drawn in, in logo units (the mark is 68 × 64). */
export const BOX = 104;

/** The swim, in logo units. The shader reads these; swimEnvelope() bounds them. */
export const SWIM = {
    relaxSpread: 1.1, // legs spread this far (at the tip) when relaxed
    contractIn: 2.6, // ...drawn in this far at the top of the stroke
    fallSpread: 3.0, // ...splayed this far when sinking in the game
    wave: 0.7, // the slow ripple along each leg
    push: 0.09, // legs lengthen by this fraction as they push down
    relaxShort: 0.03, // ...and shorten by this fraction when relaxed
    fallShort: 0.26, // ...and by this much as the tips drift up while sinking
    bellX: 0.07, // the bell narrows by this fraction on the contraction
    bellY: 0.05, // ...and lengthens by this fraction
} as const;

/** The largest tilt toward the pointer, radians: ~4.0° about the horizontal, ~5.7° about the vertical. */
export const TILT = { x: 0.07, y: 0.1 } as const;

/** Eye distance for the tilt's perspective, logo units (≈ a CSS perspective of ~3.4× his height). */
export const EYE = 220;

/** The furthest any part of him can reach at any point of the swim, logo units (y down). */
export function swimEnvelope(): { x0: number; x1: number; y0: number; y1: number } {
    const shift = Math.max(SWIM.relaxSpread, SWIM.contractIn, SWIM.relaxSpread + SWIM.fallSpread) + SWIM.wave;
    const legLen = 1 + SWIM.push; // the longest a leg gets
    const legBottom = 48 + (71.5 - 48) * legLen + 6.5;
    const domeTop = 48 - 34 * (1 + SWIM.bellY);
    return { x0: 21 - shift, x1: 89 + shift, y0: domeTop, y1: legBottom };
}

/** His rotation for a tilt: about the horizontal axis (ax), then the vertical (ay). Row-major 3×3. */
function rotation(ax: number, ay: number): number[] {
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
    // Ry(ay) · Rx(ax), y-down / z-into-the-screen axes
    return [
        cy, sy * sx, sy * cx,
        0, cx, -sx,
        -sy, cy * sx, cy * cx,
    ];
}

/**
 * Where a point of his (logo units relative to CENTER, y down) lands on
 * screen (same units, relative to the sprite's centre): rotate it with him,
 * then project from an eye EYE units in front of the screen.
 */
export function logoToScreen(ax: number, ay: number, u: number, v: number): [number, number] {
    const R = rotation(ax, ay);
    const X = R[0] * u + R[1] * v, Y = R[3] * u + R[4] * v, Z = R[6] * u + R[7] * v;
    const k = EYE / (Z + EYE);
    return [X * k, Y * k];
}

/**
 * The inverse, as a homography H with [u·w, v·w, w] = H · [sx, sy, 1]: for
 * each pixel of his sprite, which point of him is there. Returned
 * COLUMN-MAJOR, ready for uniformMatrix3fv(…, false, H).
 */
export function tiltHomography(ax: number, ay: number): Float32Array {
    const R = rotation(ax, ay);
    // forward: [s·w, w] = F · [u, v, 1], F = [[E·R00, E·R01, 0], [E·R10, E·R11, 0], [R20, R21, E]]
    const E = EYE;
    const f = [E * R[0], E * R[1], 0, E * R[3], E * R[4], 0, R[6], R[7], E];
    const [a, b, c, d, e, g, h, i, j] = f;
    const A = e * j - g * i, B = -(d * j - g * h), C = d * i - e * h;
    const det = a * A + b * B + c * C;
    // inverse = adjugate / det, row-major
    const inv = [
        A / det, -(b * j - c * i) / det, (b * g - c * e) / det,
        B / det, (a * j - c * h) / det, -(a * g - c * d) / det,
        C / det, -(a * i - b * h) / det, (a * e - b * d) / det,
    ];
    // column-major for GL
    return new Float32Array([inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]);
}

/** Apply a column-major homography from tiltHomography() to a sprite offset, as the shader does. */
export function applyHomography(H: Float32Array, sx: number, sy: number): [number, number] {
    const x = H[0] * sx + H[3] * sy + H[6];
    const y = H[1] * sx + H[4] * sy + H[7];
    const w = H[2] * sx + H[5] * sy + H[8];
    return [x / w, y / w];
}

/**
 * The tilt that turns him to face the pointer. px, py in -1..1 from the
 * window centre, y UP (as the worker gets them); on = the pointer is in the
 * window. Facing it: the side toward the pointer turns away from you.
 */
export function tiltToward(px: number, py: number, on: number): { ax: number; ay: number } {
    return { ax: -py * on * TILT.x, ay: -px * on * TILT.y };
}
