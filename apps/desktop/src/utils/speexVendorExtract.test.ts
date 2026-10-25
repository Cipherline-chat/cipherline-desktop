import { describe, it, expect } from 'vitest';
import speexGlueRaw from '@sapphi-red/speex-preprocess-wasm?raw';
import { extractSpeexVendorGlue } from './speexVendorExtract';

describe('extractSpeexVendorGlue', () => {
    it('finds the public names and strips the export block and source-map pointer', () => {
        const { body, preprocessorName, loadModuleName } = extractSpeexVendorGlue(speexGlueRaw);
        expect(preprocessorName).toBe('SpeexPreprocessor');
        expect(loadModuleName).toMatch(/^[A-Za-z_$][\w$]*$/);
        expect(body).not.toMatch(/^export\s*\{/m);
        expect(body).not.toContain('sourceMappingURL');
        // Both bindings must exist in the body under those internal names.
        expect(body).toMatch(new RegExp(`(var|const|let|class|function)\\s+${preprocessorName}\\b`));
        expect(body).toMatch(new RegExp(`(var|const|let|class|function)\\s+${loadModuleName}\\b`));
    });

    it('keeps the SpeexDSP license text (BSD requires it to travel with the binary)', () => {
        expect(extractSpeexVendorGlue(speexGlueRaw).body).toContain('Xiph.org Foundation');
    });

    // Canary, same idea as rnnoiseVendorExtract.test.ts: the worklet shadows
    // WorkerGlobalScope only to satisfy the glue's environment detection. If a
    // package bump starts USING window/document/fetch for real, this fails
    // instead of the worklet silently never loading.
    it('the glue only uses window / WorkerGlobalScope for environment detection', () => {
        const { body } = extractSpeexVendorGlue(speexGlueRaw);
        const uses = (name: string) => (body.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
        expect(uses('document')).toBe(0);
        expect(uses('importScripts')).toBe(0);
        expect(uses('window')).toBeLessThanOrEqual(2);
    });

    it('throws a clear error when the bundle shape changes', () => {
        expect(() => extractSpeexVendorGlue('var a = 1;')).toThrow(/Could not find an export block/);
        expect(() => extractSpeexVendorGlue('export { a, b };')).toThrow(/missing SpeexPreprocessor/);
    });
});

describe('Light worklet source: AudioWorkletGlobalScope has no URL constructor', () => {
    it('hands the glue a locateFile so findWasmBinary never reaches new URL(…, import.meta.url)', async () => {
        const { SPEEX_LIGHT_WORKLET_SOURCE } = await import('./speexLightWorkletSource');
        // staging.174: without it the worklet posted loadFailed "URL is not defined"
        // and Light noise suppression never started in the app.
        expect(SPEEX_LIGHT_WORKLET_SOURCE).toMatch(/loadSpeexModule\(\{[^}]*locateFile:/);
    });
});
