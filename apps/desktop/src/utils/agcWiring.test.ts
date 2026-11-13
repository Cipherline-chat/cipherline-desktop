import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MIC_CAPTURE_BASE_CONSTRAINTS, micCaptureConstraints, UNPROCESSED_TRACK_SETTINGS } from './audioInput';
import { SPEEX_LIGHT_WORKLET_SOURCE } from './speexLightWorkletSource';
import { AGC_WORKLET_SOURCE } from './agcWorkletSource';

/**
 * No STACKED automatic gain control. Exactly one AGC acts on the outgoing mic:
 * ours (agcKernel.js, in the voice processor). Chromium's own AGC would run on
 * the raw capture BEFORE the chain, double the levelling, and on Windows move the
 * OS mic slider. Neither noise suppressor may carry an AGC of its own either
 * (SpeexDSP's preprocessor has one), or Light would level twice and Strong once.
 */

const SRC = join(__dirname, '..');

function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
            if (name === 'node_modules') continue;
            sources(p, out);
        } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
            out.push(p);
        }
    }
    return out;
}

describe('no stacked AGC - capture constraints', () => {
    it('every mic open asks for autoGainControl:false, whatever the echo-cancellation choice', () => {
        expect(MIC_CAPTURE_BASE_CONSTRAINTS.autoGainControl).toBe(false);
        expect(micCaptureConstraints(true).autoGainControl).toBe(false);
        expect(micCaptureConstraints(false).autoGainControl).toBe(false);
        expect(UNPROCESSED_TRACK_SETTINGS.autoGainControl).toBe(false);
    });

    it('browser noise suppression and voice isolation are off too (the processor owns them)', () => {
        expect(micCaptureConstraints().noiseSuppression).toBe(false);
        expect(micCaptureConstraints().voiceIsolation).toBe(false);
    });

    it('no production source turns the browser AGC on', () => {
        const offenders: string[] = [];
        for (const f of sources(SRC)) {
            const text = readFileSync(f, 'utf8');
            if (/autoGainControl\s*:\s*(true|\{\s*(ideal|exact)\s*:\s*true)/.test(text)) offenders.push(relative(SRC, f));
            if (/autoGainControl\s*=\s*true/.test(text)) offenders.push(relative(SRC, f));
        }
        expect(offenders).toEqual([]);
    });
});

describe('no stacked AGC - the suppressors and the worklet', () => {
    it('Light (SpeexDSP) has its own AGC explicitly OFF', () => {
        expect(SPEEX_LIGHT_WORKLET_SOURCE).toMatch(/sp\.agc\s*=\s*false/);
        expect(SPEEX_LIGHT_WORKLET_SOURCE).not.toMatch(/sp\.agc\s*=\s*true/);
    });

    it('the AGC worklet is registered once, and its source has no reference to a noise-suppression mode', () => {
        expect(AGC_WORKLET_SOURCE.match(/registerProcessor\(/g)).toHaveLength(1);
        // Code only (the kernel's header comments explain the Light/Strong history).
        const code = AGC_WORKLET_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(code).not.toMatch(/light|strong|speex|rnnoise|noiseSuppressionMode/i);
    });

    it('the voice processor builds one AGC node', () => {
        const text = readFileSync(join(SRC, 'utils', 'voiceProcessor.ts'), 'utf8');
        expect(text.match(/new AudioWorkletNode\(ctx, 'agc-worklet'/g)).toHaveLength(1);
    });
});
