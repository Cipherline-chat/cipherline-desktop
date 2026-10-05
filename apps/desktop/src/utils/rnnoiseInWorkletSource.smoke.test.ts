import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RNNOISE_INLINE_WORKLET_SOURCE } from './rnnoiseInWorkletSource';

/**
 * This is the closest thing to real AudioWorklet verification possible
 * without an actual browser: Node's dynamic `import()` on a real .mjs file
 * on disk parses AND evaluates the text as a genuine ES module — the same
 * "Module goal" grammar the browser's `audioWorklet.addModule()` uses (which
 * matters concretely here: the vendored RNNoise glue uses `import.meta.url`,
 * legal only inside Module-goal code, illegal inside a plain Function/Script
 * — see rnnoiseInWorkletSource.ts's header comment).
 *
 * What this DOES verify: the ~4.8MB assembled source (nsKernel.js + the
 * wrapped vendor glue + the new worklet class) is syntactically valid
 * JavaScript, evaluates top-to-bottom without throwing, and calls
 * registerProcessor() with a real constructable class under the expected
 * name.
 *
 * What this does NOT verify: real-time audio behavior, actual WASM
 * instantiation (the constructor's _initRnnoise() only runs on actual
 * AudioWorkletNode construction, which this test never does — registering
 * the class is as far as this goes), CSP/blob-URL loading in Electron, or
 * anything about how it sounds/performs under load. Those need a real
 * Windows/Chromium pass — this only rules out "the file is broken" before
 * it ever reaches one.
 */
describe('RNNOISE_INLINE_WORKLET_SOURCE — parses and evaluates as a real ES module', () => {
    const globalsToClean: string[] = [];

    afterEach(() => {
        for (const key of globalsToClean) delete (globalThis as unknown as Record<string, unknown>)[key];
        globalsToClean.length = 0;
    });

    it('registers rnnoise-inline-worklet with a constructable processor class', async () => {
        const registered: Record<string, unknown> = {};
        const g = globalThis as unknown as Record<string, unknown>;
        g.registerProcessor = (name: string, ctor: unknown) => { registered[name] = ctor; };
        g.AudioWorkletProcessor = class {
            port = { onmessage: null, postMessage: () => { /* noop */ } };
        };
        g.sampleRate = 48000;
        globalsToClean.push('registerProcessor', 'AudioWorkletProcessor', 'sampleRate');

        const tmpFile = join(tmpdir(), `rnnoise-inline-worklet-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
        writeFileSync(tmpFile, RNNOISE_INLINE_WORKLET_SOURCE);
        try {
            // @vite-ignore: this path is computed at test-run time (a temp
            // file), not statically analyzable — Vite must not try to bundle it.
            await import(/* @vite-ignore */ `file://${tmpFile}`);
        } finally {
            unlinkSync(tmpFile);
        }

        expect(typeof registered['rnnoise-inline-worklet']).toBe('function');
        // Constructing it must not throw synchronously — _initRnnoise() is
        // fire-and-forget async (kicked off in the constructor, not awaited),
        // so a REJECTED promise inside it must not escape as an unhandled
        // rejection either. Rnnoise.load() will fail here (no real
        // WebAssembly/base64 environment quirks aside, this Node context has
        // no AudioWorkletGlobalScope machinery around it) — that's fine and
        // expected; the class exercises its own graceful-failure path
        // (postMessage({type:'rnnoiseLoadFailed'})) rather than throwing.
        const Ctor = registered['rnnoise-inline-worklet'] as new () => unknown;
        expect(() => new Ctor()).not.toThrow();
    });
});
