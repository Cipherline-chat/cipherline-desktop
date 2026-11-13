/**
 * Every Web Worker in the app must be constructed in the ONE form Vite
 * recognises and bundles:
 *
 *     new Worker(new URL('../workers/x.ts', import.meta.url), { ... })
 *
 * Anything else - an aliased constructor (`new g.Worker(...)`), a URL built in
 * a variable - is invisible to Vite's worker plugin. Its asset plugin then
 * ships the RAW TypeScript file as a URL instead (inlined as
 * `data:video/mp2t;base64,...` when small - `.ts` reads as MPEG-TS), which no
 * browser will execute. The worker errors asynchronously, after the page has
 * already handed it whatever it transferred. That is exactly how the 1.0.23
 * Surround single-screen share published a track with no frames
 * (utils/shareCrop.ts header): dev and unit tests both hid it, because Vite's
 * dev server compiles .ts on request and the tests inject fake workers.
 *
 * This scans the source text, so it holds for code paths no test executes.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f)) out.push(p);
    }
    return out;
}

/** Each `new URL('<...worker file...>', import.meta.url)`, with the text right before it. */
function workerUrlSites(text: string): { url: string; before: string }[] {
    const re = /new\s+URL\(\s*(['"`])([^'"`]*(?:\/workers\/|\.worker\.)[^'"`]*)\1\s*,\s*import\.meta\.url\s*\)/g;
    const out: { url: string; before: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ url: m[2], before: text.slice(Math.max(0, m.index - 40), m.index) });
    return out;
}

const BUNDLED_FORM = /new\s+(?:Shared)?Worker\s*\(\s*$/;

describe('worker bundling: every worker uses the form Vite bundles', () => {
    const sites = walk(SRC).flatMap(f => workerUrlSites(readFileSync(f, 'utf8')).map(s => ({ file: relative(SRC, f), ...s })));

    it('finds the app\'s workers (positive control)', () => {
        const files = sites.map(s => s.url);
        expect(files.some(u => u.includes('shareCropWorker'))).toBe(true);
        expect(files.some(u => u.includes('loadingScreen.worker'))).toBe(true);
        expect(sites.length).toBeGreaterThanOrEqual(3);
    });

    it('each worker URL is passed straight to `new Worker(`', () => {
        const bad = sites.filter(s => !BUNDLED_FORM.test(s.before)).map(s => `${s.file}: ${s.url} (preceded by "${s.before.trim().slice(-20)}")`);
        expect(bad).toEqual([]);
    });

    it('the check itself rejects the aliased constructor that shipped broken (negative control)', () => {
        const [aliased] = workerUrlSites("return new g.Worker(new URL('../workers/shareCropWorker.ts', import.meta.url), { type: 'module' });");
        expect(BUNDLED_FORM.test(aliased.before)).toBe(false);
        const [plain] = workerUrlSites("return new Worker(\n        new URL('../workers/shareCropWorker.ts', import.meta.url),\n        { type: 'module' });");
        expect(BUNDLED_FORM.test(plain.before)).toBe(true);
    });
});
