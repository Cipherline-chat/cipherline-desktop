import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Node-level smoke test of the REAL built addon (crates/cl-audio-node -> build/Release/cl_audio_node.node, built by
 * `npm run build-audio-node`). Skipped when it is not built (like the other optional native tests here); CI builds it first and
 * this is the gate that the addon loads and honours its never-throw contract. The model test additionally needs
 * resources/dfn/ (npm run fetch-dfn-model).
 */
const addonPath = join(__dirname, '../build/Release/cl_audio_node.node');
const modelPath = join(__dirname, '../resources/dfn/DeepFilterNet3_ll_onnx.tar.gz');
const built = existsSync(addonPath);
/** CI sets CL_REQUIRE_AUDIO_NODE=1 after the build step: a missing addon is then a FAILURE, not a skip (docs/plans/audio-strong-native-ci.md). */
const required = process.env.CL_REQUIRE_AUDIO_NODE === '1';
type Node = {
    process480(f: Float32Array): number; setSettings(s: Record<string, unknown>): boolean; setStrongModel(b: Buffer): boolean; setGate(e: boolean, t: number): boolean;
    deviceChanged(h: boolean, g: number): void; setInitialDeviceGainDb(g: number): void; deviceGainDb(): number; delaySamples(): number;
    failed(): boolean; lastError(): string; stats(take?: boolean): Record<string, number | boolean>;
};
const load = () => new (createRequire(__filename)(addonPath).ClAudioNode as new (r?: number) => Node)(48000);
const tone = (n: number, k = 0) => Float32Array.from({ length: n }, (_, i) => 0.1 * Math.sin((i + k) * 0.05));
const ok = { noise: 1, autoGain: true, manualGainDb: 0, originalSound: false, idleSkip: true };

it.runIf(required)('the addon was built when CI requires it', () => { expect(built, `${addonPath} missing: run scripts/build-audio-node.sh`).toBe(true); });

describe.skipIf(!built)('cl_audio_node.node (built addon)', () => {
    it('loads, processes 480-float frames in place and reports stats', () => {
        const e = load();
        expect(e.failed()).toBe(false);
        for (let k = 0; k < 20; k++) {
            const f = tone(480, k * 480);
            expect(e.process480(f)).toBe(0);
            expect(f.every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
        }
        const s = e.stats(false);
        expect(s.frames).toBe(20);
        expect(s.failed).toBe(false);
        expect(e.delaySamples()).toBeGreaterThanOrEqual(0);
    });

    it('never throws: wrong lengths, garbage settings, NaN gains, empty and bad model bytes', () => {
        const e = load();
        for (const n of [0, 1, 479, 481, 4800]) { const f = tone(n); const before = Array.from(f); expect(e.process480(f)).toBe(1); expect(Array.from(f)).toEqual(before); }
        const nan = new Float32Array(480).fill(NaN);
        expect(e.process480(nan)).toBe(0);
        expect(nan.every(Number.isFinite)).toBe(true);
        expect(e.setSettings(ok)).toBe(true);
        expect(e.setSettings({ ...ok, noise: 9 })).toBe(false);
        expect(e.setSettings({ ...ok, manualGainDb: NaN })).toBe(false);
        expect(e.setSettings({ ...ok, noise: 2 })).toBe(true);   // model bytes are only validated while Strong is the active profile
        expect(e.setStrongModel(Buffer.alloc(0))).toBe(false);
        expect(e.setStrongModel(Buffer.from([1, 2, 3]))).toBe(false);
        expect(e.lastError().length).toBeGreaterThan(0);
        expect(() => { e.deviceChanged(true, NaN); e.setInitialDeviceGainDb(Infinity); }).not.toThrow();
        expect(e.failed()).toBe(false);
        expect(e.process480(tone(480))).toBe(0);
    });

    it('the manual gate: never throws, closes on quiet input, stats say so', () => {
        const e = load();
        expect(e.setGate(true, -40)).toBe(true);
        for (let k = 0; k < 300; k++) e.process480(Float32Array.from({ length: 480 }, (_, i) => 0.0003 * Math.sin((i + k * 7) * 0.37)));
        const f = Float32Array.from({ length: 480 }, (_, i) => 0.0003 * Math.sin(i * 0.37));
        e.process480(f);
        expect(f.every(v => Math.abs(v) < 1e-6)).toBe(true);
        expect(e.stats(false).gateOpen).toBe(false);
        expect(e.setGate(true, NaN)).toBe(true);
        expect(e.setGate(false, 0)).toBe(true);
        expect(e.stats(false).gateOpen).toBe(true);
    });

    it.skipIf(!existsSync(modelPath))('loads the real low-delay model: Strong, 480 samples of delay, stats carry the watchdog counter', { timeout: 60_000 }, () => {
        const e = load();
        expect(e.setStrongModel(readFileSync(modelPath))).toBe(true);
        expect(e.setSettings({ ...ok, noise: 2 })).toBe(true);
        expect(e.stats(false).effectiveNoise).toBe(2);
        expect(e.delaySamples()).toBe(480);
        for (let k = 0; k < 50; k++) expect(e.process480(tone(480, k * 480))).toBe(0);
        expect(typeof e.stats(false).watchdogFrames).toBe('number'); // a bare synthetic tone may be removed by the model; the cl-audio tests cover the watchdog itself
    });
});
