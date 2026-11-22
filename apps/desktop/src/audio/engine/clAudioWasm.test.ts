import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CL_AUDIO_WASM_BASE64, CL_AUDIO_WASM_SHA256 } from './clAudioWasmBase64';
import { clAudioWasmBytes } from '../../utils/clAudioWasm';

/**
 * Catches a STALE engine binary. cl_audio.wasm is built from crates/ (scripts/build-audio-wasm.sh) and installed with
 * scripts/gen-cl-audio-wasm.mjs, which records the crates/ commit and the sha256 in cl_audio.wasm.json and writes the
 * base64 module the renderer loads. This test fails when any of the four disagree, or when crates/ has moved on since
 * the binary was built. Fix: rebuild and re-run the generator (crates/cl-audio/README.md, "Rebuilding the wasm").
 */
const here = dirname(fileURLToPath(import.meta.url));
const wasm = readFileSync(join(here, 'cl_audio.wasm'));
const meta = JSON.parse(readFileSync(join(here, 'cl_audio.wasm.json'), 'utf8')) as { crateCommit: string; sha256: string; bytes: number };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('cl_audio.wasm', () => {
    it('the sha256 on disk matches cl_audio.wasm.json', () => {
        expect(sha(wasm)).toBe(meta.sha256);
        expect(wasm.length).toBe(meta.bytes);
    });

    it('the base64 module the app loads decodes to the same bytes', () => {
        expect(CL_AUDIO_WASM_SHA256).toBe(meta.sha256);
        expect(Buffer.from(CL_AUDIO_WASM_BASE64, 'base64').equals(wasm)).toBe(true);
        expect(sha(new Uint8Array(clAudioWasmBytes()))).toBe(meta.sha256);
    });

    it('is a valid WebAssembly module with the C ABI the worklet calls and no imports', () => {
        const mod = new WebAssembly.Module(wasm);
        expect(WebAssembly.Module.imports(mod)).toEqual([]);
        const names = WebAssembly.Module.exports(mod).map(e => e.name);
        for (const n of ['memory', 'cla_new', 'cla_free', 'cla_in_ptr', 'cla_out_ptr', 'cla_push', 'cla_set_settings',
            'cla_set_initial_device_gain_db', 'cla_device_changed', 'cla_device_gain_db', 'cla_delay_samples', 'cla_stats', 'cla_take_stats']) {
            expect(names, n).toContain(n);
        }
    });

    it('was built from the current crates/ (no commit has touched crates/ since)', () => {
        let head: string;
        try {
            head = execFileSync('git', ['log', '-1', '--format=%H', '--', '../../../../../crates', ':(exclude,glob)../../../../../crates/**/*.md'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch { return; // no git (a source tarball): the sha checks above are all there is
        }
        if (!head) return; // shallow clone without crates/ history
        expect(meta.crateCommit, 'crates/ changed after cl_audio.wasm was built: rebuild + node scripts/gen-cl-audio-wasm.mjs').toBe(head);
    });
});
