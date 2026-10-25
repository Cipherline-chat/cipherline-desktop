/**
 * Pulls the public `SpeexPreprocessor` class and the `loadSpeexModule` factory
 * out of @sapphi-red/speex-preprocess-wasm's compiled ES module
 * (dist/index.js) so its body can be concatenated as plain text into an
 * AudioWorklet's Blob-URL source string — the same technique
 * rnnoiseVendorExtract.ts uses for RNNoise, for the same reasons (no new
 * CSP / URL-resolution surface).
 *
 * dist/index.js ends with `export { SpeexPreprocessor, speex_default as
 * loadSpeexModule };` followed by a license comment. The internal names are
 * whatever the bundler assigned, so they are resolved by PUBLIC name. The
 * export statement is stripped (kept in a function scope it would be a syntax
 * error); the trailing license comment is kept, because SpeexDSP's BSD terms
 * require it to travel with the binary form.
 */

export interface SpeexVendorExtraction {
    /** The glue source with its `export {...}` statement removed. */
    body: string;
    /** Internal name of the class exported publicly as `SpeexPreprocessor`. */
    preprocessorName: string;
    /** Internal name of the factory exported publicly as `loadSpeexModule`. */
    loadModuleName: string;
}

const VERSION_MISMATCH_HINT =
    'The vendored @sapphi-red/speex-preprocess-wasm package likely changed its bundling shape ' +
    '(a version bump?) - re-verify this extraction against the new dist/index.js before the ' +
    'Light noise suppressor can be trusted again.';

export function extractSpeexVendorGlue(rawSrc: string): SpeexVendorExtraction {
    const m = rawSrc.match(/export\s*\{([\s\S]*?)\}\s*;?/);
    if (!m || m.index === undefined) {
        throw new Error(`[speexVendorExtract] Could not find an export block. ${VERSION_MISMATCH_HINT}`);
    }
    const names: Record<string, string> = {}; // publicName -> internalName
    for (const rawPart of m[1].split(',')) {
        const part = rawPart.trim();
        if (!part) continue;
        const asMatch = part.match(/^([a-zA-Z0-9_$]+)\s+as\s+([a-zA-Z0-9_$]+)$/);
        if (asMatch) { names[asMatch[2]] = asMatch[1]; continue; }
        const bare = part.match(/^([a-zA-Z0-9_$]+)$/);
        if (bare) names[bare[1]] = bare[1];
    }
    const preprocessorName = names.SpeexPreprocessor;
    const loadModuleName = names.loadSpeexModule;
    if (!preprocessorName || !loadModuleName) {
        throw new Error(
            `[speexVendorExtract] Export block found but missing SpeexPreprocessor and/or loadSpeexModule ` +
            `(found: ${Object.keys(names).join(', ') || '(none)'}). ${VERSION_MISMATCH_HINT}`,
        );
    }
    const body = (rawSrc.slice(0, m.index) + rawSrc.slice(m.index + m[0].length))
        // A Blob-URL module has no map file next to it; leaving the pointer in only
        // sends devtools (and test runners) looking for one.
        .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
        .trim();
    return { body, preprocessorName, loadModuleName };
}
