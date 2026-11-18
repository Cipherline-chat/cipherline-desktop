import { describe, it, expect } from 'vitest';
import { stripHiddenCharacters } from '@cipherline/shared';

/**
 * stripHiddenCharacters used to vet tag characters with a regex that backtracked
 * quadratically (CodeQL js/polynomial-redos on packages/shared/display-name.ts):
 * a pictograph, a long run of tags and then a cancel tag made every start
 * position rescan the rest of the run. It is now a linear pass. These tests pin
 * that (1) the output is IDENTICAL to the old regex-based implementation on
 * random and hand-picked input, and (2) adversarial input stays fast.
 */

// The previous implementation, verbatim, as the oracle.
const OLD_TAG_RE =
    /(?<![\p{Extended_Pictographic}\u{E0020}-\u{E007F}])[\u{E0020}-\u{E007F}]+|[\u{E0020}-\u{E007E}]+(?![\u{E0020}-\u{E007F}])|(?<![\u{E0020}-\u{E007E}])\u{E007F}/gu;
const ZWJ = 0x200d;
const CC = /\p{Cc}/u;
const CF = /\p{Cf}/u;
const ZL_ZP = /[\p{Zl}\p{Zp}]/u;
const EXT_PICT = /\p{Extended_Pictographic}/u;
const isPict = (cp: number) => EXT_PICT.test(String.fromCodePoint(cp));
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
function oldStrip(s: string): string {
    const pre = s.replace(OLD_TAG_RE, '');
    const cps = Array.from(pre, ch => ch.codePointAt(0) as number);
    let out = '';
    let prevKept: number | undefined;
    for (let i = 0; i < cps.length; i++) {
        const c = cps[i];
        const ch = String.fromCodePoint(c);
        let keep = true;
        if (c === ZWJ) {
            const prev = prevKept;
            const next = cps[i + 1];
            keep = prev !== undefined && next !== undefined
                && (isPict(prev) || isSkinTone(prev) || prev === 0xfe0f) && isPict(next);
        } else if ((c >= 0xe0020 && c <= 0xe007e) || c === 0xe007f) keep = true;
        else if (CC.test(ch) || CF.test(ch) || ZL_ZP.test(ch)) keep = false;
        if (keep) { out += ch; prevKept = c; }
    }
    return out.replace(/\s+/g, ' ').trim();
}

const FLAG = '\u{1F3F4}'; // black flag, the base of subdivision-flag tag sequences
const TAG_G = '\u{E0067}';
const TAG_SP = '\u{E0020}';
const CANCEL = '\u{E007F}';

// Small deterministic PRNG so a failure is reproducible.
function rng(seed: number) {
    let x = seed >>> 0;
    return () => {
        x ^= x << 13; x >>>= 0;
        x ^= x >>> 17;
        x ^= x << 5; x >>>= 0;
        return x / 0x100000000;
    };
}

describe('stripHiddenCharacters (linear tag vetting)', () => {
    it('matches the old regex implementation on hand-picked tag-sequence cases', () => {
        const cases = [
            '',
            'plain name',
            // a valid subdivision flag (England): pictograph + tags + cancel
            `${FLAG}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}${CANCEL} team`,
            `${FLAG}${TAG_G}${TAG_G}`, // unterminated
            `${FLAG}${CANCEL}`, // lone cancel on a pictograph
            `${FLAG}${CANCEL}${CANCEL}${TAG_G}${CANCEL}`,
            `${FLAG}${TAG_G}${CANCEL}${CANCEL}${TAG_G}`,
            `a${TAG_G}${CANCEL}b`, // not on a pictograph
            `${TAG_G}${CANCEL}`, // at the very start
            `${CANCEL}`,
            `${FLAG}${TAG_G}${CANCEL}${FLAG}${TAG_G}${CANCEL}`,
            `${FLAG}\u200D${FLAG}${TAG_G}${CANCEL}`,
            `x\u202Ey\u0000z\u2028w`, // bidi override, control, line separator
            '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
            '\uD800 lone surrogate',
        ];
        for (const c of cases) expect(stripHiddenCharacters(c), JSON.stringify(c)).toBe(oldStrip(c));
    });

    it('matches the old regex implementation on 5000 random strings', () => {
        const alphabet = [
            FLAG, '\u{1F600}', 'a', 'Z', ' ', '\t', '-', TAG_SP, TAG_G, '\u{E007E}', CANCEL,
            '\u200D', '\uFE0F', '\u{1F3FD}', '\u0000', '\u202E', '\u2028', '\uD800', '\u00E9', '\u0301',
        ];
        const r = rng(0x5eed);
        for (let n = 0; n < 5000; n++) {
            const len = Math.floor(r() * 24);
            let s = '';
            for (let k = 0; k < len; k++) s += alphabet[Math.floor(r() * alphabet.length)];
            expect(stripHiddenCharacters(s), JSON.stringify(s)).toBe(oldStrip(s));
        }
    });

    it('stays linear on the input that made the old regex quadratic', () => {
        // ~2.3 s for n = 16k with the old regex; 200k here must finish in well under a second.
        const n = 200_000;
        const inputs = [
            FLAG + TAG_SP.repeat(n) + CANCEL + TAG_SP,
            FLAG + TAG_SP.repeat(n) + CANCEL.repeat(2) + 'x',
            TAG_SP.repeat(n) + CANCEL,
            (FLAG + TAG_G + CANCEL).repeat(n / 3),
        ];
        for (const s of inputs) {
            const t0 = performance.now();
            stripHiddenCharacters(s);
            expect(performance.now() - t0).toBeLessThan(1500);
        }
    });

    it('keeps a complete subdivision flag and drops an unterminated one', () => {
        const england = `${FLAG}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}${CANCEL}`;
        expect(stripHiddenCharacters(`${england} fans`)).toBe(`${england} fans`);
        expect(stripHiddenCharacters(`${FLAG}${TAG_G}${TAG_G} fans`)).toBe(`${FLAG} fans`);
        expect(stripHiddenCharacters(`ab${TAG_G}${CANCEL}c`)).toBe('abc');
    });
});
