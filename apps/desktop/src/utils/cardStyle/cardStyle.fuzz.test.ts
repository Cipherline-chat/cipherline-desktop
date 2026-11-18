/**
 * Message card style: property-based / fuzz checks without a fuzz library
 * (fast-check is not installed in the shared node_modules). A seeded PRNG
 * makes every run reproducible; a failure prints the seed and the input.
 *
 * Properties, for thousands of random inputs:
 *  1. neither entry point ever throws;
 *  2. whatever comes out is canonical (normalising again changes nothing),
 *     under the byte cap, and every number is inside its bound;
 *  3. the CSS the app could render for it contains no forbidden token;
 *  4. every generated VALID style round-trips: normalize(json) ===
 *     parse(cardStyleToCss(normalize(json))).
 */
import { describe, it, expect } from 'vitest';
import {
    parseCardStyleCss, normalizeCardStyle, cardStyleToCss, cardStyleByteSize,
    CARD_LIMITS, CARD_STYLE_MAX_BYTES, CARD_BORDER_STYLES, CARD_ANIMATIONS, CARD_PADDINGS, type CardStyle,
} from '@cipherline/shared';

/** mulberry32: tiny, seeded, good enough for test generation. */
function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const SEED = 20261117;
const FORBIDDEN = /url|var\(|expression|@|\\|attr\(|image-set|element\(|position|z-index|inset|transform|content|filter|mask|calc\(|!|javascript|<|>|"|'|;\s*\S+\s*:/i;

function checkInvariants(s: CardStyle | null, input: unknown) {
    const ctx = JSON.stringify(input)?.slice(0, 300);
    if (s === null) return;
    expect(normalizeCardStyle(s), ctx).toEqual(s);
    expect(cardStyleByteSize(s), ctx).toBeLessThanOrEqual(CARD_STYLE_MAX_BYTES);
    const out = cardStyleToCss(s);
    // Each line is exactly one declaration of an allowed property.
    for (const line of out.split('\n')) {
        expect(line, ctx).toMatch(/^(background|background-opacity|border|border-style|border-width|border-color|border-image|border-radius|padding|box-shadow|color|text-shadow|text-align|heading-align|letter-spacing|stripe|animation): [a-z0-9#%(),. /-]+;$/);
    }
    expect(out.replace(/;\n/g, ' '), ctx).not.toMatch(FORBIDDEN);
    if (s.border) for (const w of [s.border.width].flat()) expect(w >= CARD_LIMITS.borderWidth.min && w <= CARD_LIMITS.borderWidth.max, ctx).toBe(true);
    if (s.radius !== undefined) for (const r of [s.radius].flat()) expect(r >= 0 && r <= CARD_LIMITS.radius.max, ctx).toBe(true);
    if (s.shadows) {
        expect(s.shadows.length).toBeLessThanOrEqual(CARD_LIMITS.shadows.max);
        for (const sh of s.shadows) {
            expect(sh.blur <= CARD_LIMITS.shadowBlur.max && sh.spread <= CARD_LIMITS.shadowSpread.max && sh.blur >= 0 && sh.spread >= 0).toBe(true);
            expect(Math.abs(sh.x) <= CARD_LIMITS.shadowOffset.max && Math.abs(sh.y) <= CARD_LIMITS.shadowOffset.max).toBe(true);
        }
    }
    if (s.letterSpacing !== undefined) expect(s.letterSpacing >= CARD_LIMITS.letterSpacing.min && s.letterSpacing <= CARD_LIMITS.letterSpacing.max).toBe(true);
    if (s.textGlow) expect(s.textGlow.blur >= CARD_LIMITS.textGlowBlur.min && s.textGlow.blur <= CARD_LIMITS.textGlowBlur.max).toBe(true);
    if (s.animation) expect(s.animation.seconds >= CARD_LIMITS.animationSeconds.min && s.animation.seconds <= CARD_LIMITS.animationSeconds.max).toBe(true);
    if (s.background && s.background.type !== 'solid') {
        const n = s.background.stops.length;
        expect(n >= CARD_LIMITS.stops.min && n <= CARD_LIMITS.stops.max).toBe(true);
        for (let i = 1; i < n; i++) expect(s.background.stops[i].at).toBeGreaterThanOrEqual(s.background.stops[i - 1].at);
    }
}

// ── Generators ──────────────────────────────────────────────────────────────

const HOSTILE_ATOMS = [
    'url(', 'url(x)', ')', '(', '@import', '\\', '\\75', '/*', '*/', '!important', ';', ':', '{', '}', '"', "'", '<', '>',
    'position', 'fixed', 'z-index', 'transform', 'inset', 'var(--cl-lume)', 'expression(', 'attr(', 'image-set(',
    'element(', 'calc(', 'nan', 'infinity', '-', '1e9', '9999999px', 'K', '：', '‍', '‮', '\u0000',
    'linear-gradient(', 'radial-gradient(', 'rgb(', 'hsl(', ',', '#', '%', 'px', 'deg', ' ', '\n',
    'background', 'border', 'color', 'box-shadow', 'animation', 'padding', 'border-radius', 'drift', 'pulse', 'shimmer',
    '0', '12px', '#25e0c8', '#fff', 'solid', 'double', '0 0 12px', '135deg',
];

const PROPS = ['background', 'background-color', 'background-image', 'border', 'border-width', 'border-style', 'border-color', 'border-radius', 'padding', 'box-shadow', 'color', 'animation', 'position', 'margin', 'z-index'];

/** Declaration-shaped soup: a property, a colon, then random value atoms. */
function randomDeclarations(r: () => number): string {
    const n = 1 + Math.floor(r() * 8);
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        const atoms = 1 + Math.floor(r() * 5);
        let v = '';
        for (let k = 0; k < atoms; k++) v += (k ? ' ' : '') + (r() < 0.8 ? HOSTILE_ATOMS[Math.floor(r() * HOSTILE_ATOMS.length)] : colour(r));
        out.push(`${PROPS[Math.floor(r() * PROPS.length)]}: ${v}`);
    }
    return out.join(r() < 0.9 ? '; ' : ';;\n');
}

function randomCssSoup(r: () => number): string {
    if (r() < 0.5) return randomDeclarations(r);
    const n = 1 + Math.floor(r() * 40);
    let s = '';
    for (let i = 0; i < n; i++) {
        const roll = r();
        if (roll < 0.75) s += HOSTILE_ATOMS[Math.floor(r() * HOSTILE_ATOMS.length)];
        else s += String.fromCharCode(Math.floor(r() * (roll < 0.95 ? 128 : 0x3000)));
    }
    return s;
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const hex = (r: () => number) => '#' + Array.from({ length: pick(r, [3, 4, 6, 8]) }, () => '0123456789abcdefABCDEF'[Math.floor(r() * 22)]).join('');
const anyNum = (r: () => number): unknown => pick(r, [() => Math.floor(r() * 60) - 10, () => r() * 1e6, () => -r() * 1e6, () => NaN, () => Infinity, () => '12', () => null, () => r() * 30])();
const colour = (r: () => number): string => pick(r, [
    () => hex(r),
    () => `rgb(${Math.floor(r() * 300)}, ${Math.floor(r() * 256)}, ${Math.floor(r() * 256)})`,
    () => `rgba(${Math.floor(r() * 256)} ${Math.floor(r() * 256)} ${Math.floor(r() * 256)} / ${Math.floor(r() * 100)}%)`,
    () => `hsl(${Math.floor(r() * 360)}, ${Math.floor(r() * 100)}%, ${Math.floor(r() * 100)}%)`,
    () => pick(r, ['red', 'url(x)', 'var(--x)', '#fff;x:y', '']),
])();

function randomJson(r: () => number): unknown {
    const o: Record<string, unknown> = { v: r() < 0.9 ? 1 : pick(r, [2, '1', 0, null]) };
    if (r() < 0.6) {
        const type = pick(r, ['solid', 'linear', 'radial', 'repeating-linear', 'repeating-radial', 'image']);
        o.background = type === 'solid'
            ? { type, color: colour(r) }
            : { type, angle: anyNum(r), shape: pick(r, ['circle', 'ellipse', 'square', undefined]), stops: Array.from({ length: Math.floor(r() * 7) }, () => ({ color: colour(r), ...(r() < 0.5 ? { at: anyNum(r) } : {}) })) };
    }
    if (r() < 0.5) o.border = { width: anyNum(r), style: pick(r, [...CARD_BORDER_STYLES, 'groove', undefined]), color: colour(r) };
    if (r() < 0.5) o.radius = r() < 0.5 ? anyNum(r) : Array.from({ length: pick(r, [3, 4, 4, 5]) }, () => anyNum(r));
    if (r() < 0.4) o.padding = pick(r, [...CARD_PADDINGS, 'huge', 4]);
    if (r() < 0.5) o.shadows = Array.from({ length: pick(r, [1, 2, 2, 3]) }, () => ({ color: colour(r), x: anyNum(r), y: anyNum(r), blur: anyNum(r), spread: anyNum(r) }));
    if (r() < 0.3) o.textGlow = { color: colour(r), blur: anyNum(r) };
    if (r() < 0.3) o.align = pick(r, ['left', 'center', 'right', 'justify']);
    if (r() < 0.3) o.headingAlign = pick(r, ['left', 'center', 'right', 'up']);
    if (r() < 0.3) o.letterSpacing = anyNum(r);
    if (r() < 0.3) o.backgroundOpacity = anyNum(r);
    if (r() < 0.3) o.stripe = { color: colour(r), width: anyNum(r) };
    if (r() < 0.4) o.text = colour(r);
    if (r() < 0.4) o.animation = { name: pick(r, [...CARD_ANIMATIONS, 'spin']), seconds: anyNum(r) };
    if (r() < 0.1) o.extra = 'x'.repeat(Math.floor(r() * 2000));
    return o;
}

// Generous timeout: thousands of cases; on a loaded box (several sessions running suites) the default 5s is not enough.
describe('fuzz', { timeout: 60_000 }, () => {
    it('random hostile CSS soup never throws and only yields safe, canonical styles', () => {
        const r = rng(SEED);
        let produced = 0;
        for (let i = 0; i < 4000; i++) {
            const input = randomCssSoup(r);
            let res;
            try {
                res = parseCardStyleCss(input);
            } catch (e) {
                throw new Error(`seed ${SEED} case ${i} threw on ${JSON.stringify(input)}: ${(e as Error).message}`);
            }
            if (res.style) produced++;
            checkInvariants(res.style, input);
            for (const d of res.declarations) expect(['accepted', 'adjusted', 'ignored', 'overridden']).toContain(d.status);
        }
        // Not vacuous: some of the soup forms valid declarations.
        expect(produced).toBeGreaterThan(0);
    });

    it('random JSON never throws, is canonical, and round-trips through CSS', () => {
        const r = rng(SEED + 1);
        let valid = 0;
        for (let i = 0; i < 4000; i++) {
            const input = randomJson(r);
            const s = normalizeCardStyle(input);
            checkInvariants(s, input);
            if (s) {
                valid++;
                const back = parseCardStyleCss(cardStyleToCss(s));
                expect(back.style, JSON.stringify(s)).toEqual(s);
                expect(back.declarations.every(d => d.status === 'accepted'), JSON.stringify(back.declarations)).toBe(true);
            }
        }
        expect(valid).toBeGreaterThan(500);
    });

    it('splicing a hostile atom into a valid declaration list never lets the atom through', () => {
        const r = rng(SEED + 2);
        const base = ['background: linear-gradient(135deg, #25e0c8, #5c6bc0)', 'border: 1px solid #25e0c8', 'border-radius: 12px', 'box-shadow: 0 0 10px #25e0c866', 'color: #f4f7ff'];
        const evil = ['position: fixed', 'z-index: 9', 'background: url(x)', 'margin: -9px', 'transform: scale(9)', 'color: #fff !important', 'back\\67 round: red', 'content: x', 'filter: blur(9px)', 'color: var(--x)'];
        for (let i = 0; i < 500; i++) {
            const decls = [...base];
            const at = Math.floor(r() * (decls.length + 1));
            const e = pick(r, evil);
            decls.splice(at, 0, e);
            const res = parseCardStyleCss(decls.join('; '));
            checkInvariants(res.style, decls);
            const evilReport = res.declarations.find(d => d.text === e.trim());
            expect(evilReport?.status, e).toBe('ignored');
        }
    });
});
