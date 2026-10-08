import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { escapeNonAsciiJs, isAscii } from './asciiJsSource';
import { RNNOISE_INLINE_WORKLET_SOURCE } from './rnnoiseInWorkletSource';
import rnnoiseGlueRaw from '@shiguredo/rnnoise-wasm?raw';

/** Evaluate an expression-bodied snippet and return its value. */
const run = (src: string): unknown => new Function(`return (${src});`)();

describe('escapeNonAsciiJs', () => {
    it('returns ASCII input unchanged (same string, no copy)', () => {
        const s = 'const a = "plain"; // nothing to do';
        expect(escapeNonAsciiJs(s)).toBe(s);
    });

    it('produces pure ASCII for comments, strings, templates, regexes and identifiers', () => {
        const src = `
            // 一度の呼び出し — a comment
            /* 音声 ── block */
            const café = 'naïve — “quoted”';
            const t = \`tmpl ✓ \${café}\`;
            const re = /[à-ÿ]+/;
        `;
        const out = escapeNonAsciiJs(src);
        expect(isAscii(out)).toBe(true);
    });

    it('preserves the VALUE of string, template and regex literals', () => {
        const cases = [
            `'naïve — “quoted” ✓'`,
            '`tmpl ✓ ${"é"}`',
            `"emoji 🎉 pair"`,
            `/[à-ÿ]+/.test("ça")`,
            `/🎉/u.test("x🎉y")`,
            `[..."a🎉b"].length`,
            `(() => { const café = 1; return café + 1; })()`,
        ];
        for (const c of cases) {
            const escaped = escapeNonAsciiJs(c);
            expect(isAscii(escaped)).toBe(true);
            expect(run(escaped)).toEqual(run(c));
        }
    });

    it('leaves a character alone when a backslash escapes it (an identity escape)', () => {
        // "\é" is the string "é"; escaping it would give a backslash-escaped backslash followed by the letters u00e9.
        const src = '"\\é"';
        const out = escapeNonAsciiJs(src);
        expect(run(out)).toBe(run(src));
        expect(out).toBe(src);
    });

    it('still escapes after an EVEN run of backslashes (an escaped backslash)', () => {
        const src = '"\\\\é"'; // the string backslash + é
        const out = escapeNonAsciiJs(src);
        expect(isAscii(out)).toBe(true);
        expect(run(out)).toBe(run(src));
    });
});

describe('worklet sources stay one-byte (renderer memory)', () => {
    it('the vendored RNNoise glue becomes pure ASCII once escaped (what the build serves)', () => {
        // It ships Japanese JSDoc; unescaped, V8 holds the whole ~4.8 MB worklet
        // source two bytes per character.
        expect(isAscii(rnnoiseGlueRaw)).toBe(false);
        expect(isAscii(escapeNonAsciiJs(rnnoiseGlueRaw))).toBe(true);
    });

    it.each([
        ['rnnoiseInWorkletSource.ts', 'export const RNNOISE_INLINE_WORKLET_SOURCE'],
        ['rnnoiseWorkletSource.ts', 'export const RNNOISE_WORKLET_SOURCE'],
        ['agcWorkletSource.ts', 'export const AGC_WORKLET_SOURCE'],
    ])('%s: the worklet template text itself is ASCII', (file, marker) => {
        // The kernels are escaped at build time (vite.config.ts), but the
        // template around them is ours — one em dash in a comment inside it
        // doubles the size of the whole assembled source again.
        const text = readFileSync(join(__dirname, file), 'utf8');
        const at = text.indexOf(marker);
        expect(at).toBeGreaterThan(-1);
        expect(isAscii(text.slice(at))).toBe(true);
    });
});

describe('escaped RNNoise inline worklet source still evaluates as a real ES module', () => {
    const globalsToClean: string[] = [];
    afterEach(() => {
        for (const key of globalsToClean) delete (globalThis as unknown as Record<string, unknown>)[key];
        globalsToClean.length = 0;
    });

    it('registers rnnoise-inline-worklet with a constructable processor class', async () => {
        const escaped = escapeNonAsciiJs(RNNOISE_INLINE_WORKLET_SOURCE);
        expect(isAscii(escaped)).toBe(true);
        const registered: Record<string, unknown> = {};
        const g = globalThis as unknown as Record<string, unknown>;
        g.registerProcessor = (name: string, ctor: unknown) => { registered[name] = ctor; };
        g.AudioWorkletProcessor = class { port = { onmessage: null, postMessage: () => { /* noop */ } }; };
        g.sampleRate = 48000;
        globalsToClean.push('registerProcessor', 'AudioWorkletProcessor', 'sampleRate');
        const tmpFile = join(tmpdir(), `rnnoise-ascii-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
        writeFileSync(tmpFile, escaped);
        try {
            await import(/* @vite-ignore */ `file://${tmpFile}`);
        } finally {
            unlinkSync(tmpFile);
        }
        expect(typeof registered['rnnoise-inline-worklet']).toBe('function');
        const Ctor = registered['rnnoise-inline-worklet'] as new () => unknown;
        expect(() => new Ctor()).not.toThrow();
    }, 60_000);
});
