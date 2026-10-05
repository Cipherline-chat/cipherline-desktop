/**
 * Phase 3 (in-worklet synchronous RNNoise): pulls the public `Rnnoise`/
 * `DenoiseState` bindings out of @shiguredo/rnnoise-wasm's compiled ES
 * module (dist/rnnoise.js) so the module body can be concatenated as plain
 * text into an AudioWorklet's Blob-URL source string — the same technique
 * this codebase already uses for nsKernel.js (see rnnoiseWorkletSource.ts's
 * header comment) and GATE_WORKLET_SOURCE/AGC_WORKLET_SOURCE.
 *
 * Why not a real `import` statement instead of text concatenation? Worklet
 * modules DO support real ES module imports per spec, but that would need a
 * stable, CSP-clean, dev-AND-packaged-build-correct absolute URL for the
 * vendored file, adding a new class of environment-specific failure surface
 * (relative-URL resolution from a blob module has no useful base, Vite's
 * `?url` output differs between dev server and packaged builds, and it's a
 * genuinely new kind of resource for the existing CSP to have to cover).
 * Text concatenation stays entirely inside the already-proven blob-URL
 * pattern — same mechanism, zero new CSP/URL-resolution surface.
 *
 * dist/rnnoise.js embeds the compiled WASM as an inline base64 payload (no
 * fetch/XHR/importScripts — confirmed by grepping the vendored file for
 * those, see the commit that added this file) and ends with a real ESM
 * export statement, e.g. `export {\n  kA as DenoiseState,\n  l as Rnnoise\n};`
 * — `kA`/`l` are whatever names the bundler's minifier happened to assign
 * internally, NOT stable across versions. This extracts those internal
 * names (by public name, not position — order isn't guaranteed either) so
 * the caller can wrap the body in a plain function scope and expose the
 * bindings under their real names, and strips the trailing `export {...}`
 * itself (illegal syntax outside a real module).
 */

export interface RnnoiseVendorExtraction {
    /** The glue source with its trailing `export {...}` statement removed —
     *  safe to wrap in a plain (non-module) function scope. */
    body: string;
    /** Internal (possibly minified) name the module exports publicly as `Rnnoise`. */
    rnnoiseName: string;
    /** Internal (possibly minified) name the module exports publicly as `DenoiseState`. */
    denoiseStateName: string;
}

const VERSION_MISMATCH_HINT =
    'The vendored @shiguredo/rnnoise-wasm package likely changed its bundling shape ' +
    '(a version bump?) — re-verify this extraction against the new dist/rnnoise.js ' +
    'before the in-worklet RNNoise path can be trusted again.';

export function extractRnnoiseVendorGlue(rawGlueSrc: string): RnnoiseVendorExtraction {
    // Trailing `export { ... };` (or without the semicolon) at the very end
    // of the file — this is the standard shape for a single-file ESM bundle
    // with only named re-exports (no default export, no re-exported `* as`).
    const exportBlockMatch = rawGlueSrc.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/);
    if (!exportBlockMatch) {
        throw new Error(`[rnnoiseVendorExtract] Could not find a trailing export block. ${VERSION_MISMATCH_HINT}`);
    }

    const nameMap: Record<string, string> = {}; // publicName -> internalName
    for (const rawPart of exportBlockMatch[1].split(',')) {
        const part = rawPart.trim();
        if (!part) continue;
        const asMatch = part.match(/^([a-zA-Z0-9_$]+)\s+as\s+([a-zA-Z0-9_$]+)$/);
        if (asMatch) {
            nameMap[asMatch[2]] = asMatch[1]; // "internal as Public" -> nameMap[Public] = internal
            continue;
        }
        const bareMatch = part.match(/^([a-zA-Z0-9_$]+)$/);
        if (bareMatch) nameMap[bareMatch[1]] = bareMatch[1]; // exported under its own name, no rename
    }

    const rnnoiseName = nameMap.Rnnoise;
    const denoiseStateName = nameMap.DenoiseState;
    if (!rnnoiseName || !denoiseStateName) {
        throw new Error(
            `[rnnoiseVendorExtract] Export block found but missing Rnnoise and/or DenoiseState ` +
            `(found: ${Object.keys(nameMap).join(', ') || '(none)'}). ${VERSION_MISMATCH_HINT}`
        );
    }

    const body = rawGlueSrc.slice(0, exportBlockMatch.index).trimEnd();
    return { body, rnnoiseName, denoiseStateName };
}
