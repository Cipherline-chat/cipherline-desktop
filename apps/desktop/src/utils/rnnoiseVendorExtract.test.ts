import { describe, it, expect } from 'vitest';
import { extractRnnoiseVendorGlue } from './rnnoiseVendorExtract';

describe('extractRnnoiseVendorGlue', () => {
    it('extracts renamed internal bindings from a minified trailing export block', () => {
        const src = `const kA = 1;\nconst l = 2;\nexport {\n  kA as DenoiseState,\n  l as Rnnoise\n};\n`;
        const result = extractRnnoiseVendorGlue(src);
        expect(result.denoiseStateName).toBe('kA');
        expect(result.rnnoiseName).toBe('l');
        expect(result.body).not.toContain('export');
        expect(result.body).toContain('const kA = 1;');
        expect(result.body).toContain('const l = 2;');
    });

    it('handles a single-line export block with no rename', () => {
        const src = `function Rnnoise() {}\nfunction DenoiseState() {}\nexport { Rnnoise, DenoiseState };`;
        const result = extractRnnoiseVendorGlue(src);
        expect(result.rnnoiseName).toBe('Rnnoise');
        expect(result.denoiseStateName).toBe('DenoiseState');
    });

    it('handles a mix of renamed and bare exports, and other unrelated exports present', () => {
        const src = `const A = 1, B = 2, C = 3;\nexport { A as Rnnoise, B as DenoiseState, C };`;
        const result = extractRnnoiseVendorGlue(src);
        expect(result.rnnoiseName).toBe('A');
        expect(result.denoiseStateName).toBe('B');
    });

    it('throws a clear, actionable error when there is no trailing export block at all', () => {
        expect(() => extractRnnoiseVendorGlue('const x = 1;')).toThrow(/rnnoiseVendorExtract/);
    });

    it('throws when the export block exists but is missing Rnnoise or DenoiseState', () => {
        const src = `const A = 1;\nexport { A as SomethingElse };`;
        expect(() => extractRnnoiseVendorGlue(src)).toThrow(/missing Rnnoise/);
    });

    it('strips only the trailing export statement, leaving everything before it untouched', () => {
        const src = `function noop() {}\nnoop();\nexport { noop as Rnnoise, noop as DenoiseState };`;
        const result = extractRnnoiseVendorGlue(src);
        expect(result.body).toBe('function noop() {}\nnoop();');
    });
});

describe('extractRnnoiseVendorGlue — against the real vendored package (canary)', () => {
    // Uses Vite's `?raw` loader on the actual pinned @shiguredo/rnnoise-wasm
    // dependency, the same way rnnoiseInWorkletSource.ts does for the real
    // build. If this test starts failing after a dependency bump, that's the
    // signal to re-verify the in-worklet RNNoise path by hand before trusting
    // it — see this file's header comment and package.json's pinned version.
    it('successfully extracts real Rnnoise/DenoiseState bindings from the pinned dependency', async () => {
        // Dynamic import so a missing/not-yet-installed dependency fails this
        // ONE test with a clear message instead of crashing the whole suite
        // at collection time.
        let raw: string;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mod: any = await import('@shiguredo/rnnoise-wasm?raw');
            raw = mod.default;
        } catch (err) {
            throw new Error(
                '@shiguredo/rnnoise-wasm is not installed in this environment — run `npm install` ' +
                `for apps/desktop, then re-run this test. Underlying error: ${err}`
            );
        }
        const result = extractRnnoiseVendorGlue(raw);
        expect(result.rnnoiseName).toBeTruthy();
        expect(result.denoiseStateName).toBeTruthy();
        expect(result.body.length).toBeGreaterThan(1000);
        expect(result.body).not.toMatch(/export\s*\{/);
    });

    // rnnoiseInWorkletSource.ts shadows `WorkerGlobalScope` inside the glue's
    // wrapping IIFE so Emscripten's environment detection accepts the
    // AudioWorkletGlobalScope (which has neither `window` nor
    // `WorkerGlobalScope` — the check otherwise throws "not compiled for this
    // environment" on EVERY load, the staging.92-era "Noise suppression
    // unavailable" bug). That shim is only sound while the glue's SOLE use of
    // those names is the detection check itself. Pin that invariant: if a
    // version bump starts genuinely using any of these globals, this fails
    // loudly instead of the shim silently corrupting real behavior.
    it('glue only references window/WorkerGlobalScope in the env check (shim safety canary)', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import('@shiguredo/rnnoise-wasm?raw');
        const raw: string = mod.default;
        expect(raw.match(/WorkerGlobalScope/g)?.length).toBe(1);
        expect(raw.match(/typeof window/g)?.length).toBe(1);
        expect(raw.match(/window\./g)).toBeNull();
        expect(raw.match(/\bdocument\b/g)).toBeNull();
        expect(raw.match(/importScripts/g)).toBeNull();
        expect(raw.match(/XMLHttpRequest/g)).toBeNull();
        // No network loads — the WASM must stay an inline payload, or the
        // worklet (which has no fetch) can't load it at all.
        expect(raw.match(/fetch\(/g)).toBeNull();
    });
});
