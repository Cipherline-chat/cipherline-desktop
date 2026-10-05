import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * The Windows taskbar showed "desktop" on hover instead of "Cipherline".
 *
 * Root cause: `index.html`'s `<title>` was left at Vite's scaffold default,
 * `desktop` — the same string as `apps/desktop/package.json`'s workspace
 * `name` field. Electron applies a loaded document's own `<title>` OVER a
 * `BrowserWindow`'s `title` constructor option once the page finishes
 * loading (see the Electron `page-title-updated` docs), so even a correct
 * `title` option on `mainWindow` was overwritten the moment the renderer
 * painted. `app.setName('Cipherline')` and `app.setAppUserModelId(...)`
 * (both present and correct in `main.ts`) govern OS notification attribution
 * and Windows taskbar grouping / jump-list identity respectively — NEITHER
 * one feeds the per-window title text a user hovers over.
 *
 * `electron/main.ts` imports `electron` and therefore cannot be loaded under
 * vitest (see the note in `vitest.config.ts`), so this reads source, the same
 * approach `ipcParameterForwarding.test.ts` uses for the same reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.resolve(here, '..', '..', 'electron', 'main.ts');
const INDEX_HTML = path.resolve(here, '..', '..', 'index.html');
const PACKAGE_JSON = path.resolve(here, '..', '..', 'package.json');
const ANNOTATION_OVERLAY_TS = path.resolve(here, '..', '..', 'electron', 'annotation-overlay.ts');

/** The source text of the `new BrowserWindow({...})` call whose opening line
 * contains `marker` (e.g. an adjacent variable assignment or comment), found
 * by walking balanced braces from the constructor's opening `{`. */
function browserWindowOptionsSource(source: string, marker: string): string {
    const markerIdx = source.indexOf(marker);
    expect(markerIdx, `marker '${marker}' not found`).toBeGreaterThan(-1);

    const ctorIdx = source.indexOf('new BrowserWindow(', markerIdx);
    expect(ctorIdx, `no 'new BrowserWindow(' after marker '${marker}'`).toBeGreaterThan(-1);

    const open = source.indexOf('{', ctorIdx);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`unbalanced braces walking BrowserWindow options after '${marker}'`);
}

describe('the app window is titled "Cipherline", not the npm workspace name', () => {
    const main = fs.readFileSync(MAIN_TS, 'utf8');
    const indexHtml = fs.readFileSync(INDEX_HTML, 'utf8');
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
        name: string;
        build?: { productName?: string };
    };

    it('sanity: package.json "name" really is the bare workspace id this bug leaked', () => {
        // If this ever stops being true the whole scenario below is moot —
        // pins the premise of the regression, not just its fix.
        expect(pkg.name).toBe('desktop');
    });

    it('index.html <title> is "Cipherline", not the workspace name — this is what actually reaches the taskbar', () => {
        const titleMatch = /<title>([^<]*)<\/title>/.exec(indexHtml);
        expect(titleMatch, 'index.html has no <title> element').not.toBeNull();
        const title = titleMatch![1];

        // Positive control: this is the literal string the regression shipped
        // with. If it comes back, this line alone fails the test.
        expect(title).not.toBe(pkg.name);
        expect(title).not.toBe('desktop');
        expect(title).toBe('Cipherline');
    });

    it('mainWindow declares an explicit "Cipherline" title, not left to the BrowserWindow default', () => {
        const opts = browserWindowOptionsSource(main, 'mainWindow = new BrowserWindow(');
        expect(opts).toMatch(/title:\s*'Cipherline'/);
        // Positive control for the class of bug: a title option present but
        // wrong (e.g. copy-pasted workspace name) must also fail here.
        expect(opts).not.toMatch(/title:\s*'desktop'/);
    });

    it('the installer splash window is explicitly titled "Cipherline"', () => {
        const opts = browserWindowOptionsSource(main, 'function createInstallerSplash');
        expect(opts).toMatch(/title:\s*'Cipherline'/);
    });

    it('the annotation overlay window (and the HTML it loads) is explicitly titled, consistently', () => {
        const overlaySrc = fs.readFileSync(ANNOTATION_OVERLAY_TS, 'utf8');
        const opts = browserWindowOptionsSource(overlaySrc, 'const win = new BrowserWindow(');
        const winTitleMatch = /title:\s*'([^']*)'/.exec(opts);
        expect(winTitleMatch, 'annotation overlay BrowserWindow has no title option').not.toBeNull();

        // The overlay writes its own HTML to a temp file and loads it; a
        // <title> in THAT document would silently override the constructor
        // option the same way index.html overrode mainWindow's. Assert they
        // agree so nobody can drift them apart again.
        const htmlTitleMatch = /<title>([^<]*)<\/title>/.exec(overlaySrc);
        expect(htmlTitleMatch, 'annotation overlay HTML has no <title> element').not.toBeNull();
        expect(htmlTitleMatch![1]).toBe(winTitleMatch![1]);
    });

    it('app.setName and app.setAppUserModelId are both set to the Cipherline identity, before app.whenReady()', () => {
        // These govern OS notification attribution and Windows taskbar
        // GROUPING/jump-list identity — a separate mechanism from the window
        // title text, and a separate bug if missing or mismatched.
        expect(main).toMatch(/app\.setName\('Cipherline'\)/);
        expect(main).toMatch(/app\.setAppUserModelId\('com\.cipherline\.desktop'\)/);

        const setNameIdx = main.indexOf("app.setName('Cipherline')");
        const setAumidIdx = main.indexOf("app.setAppUserModelId('com.cipherline.desktop')");
        // `app.whenReady()` also appears inside earlier comments referencing
        // it, so anchor on the actual call site (`.then(` immediately after)
        // rather than the first textual occurrence.
        const whenReadyIdx = main.indexOf('app.whenReady().then(');
        expect(setNameIdx).toBeGreaterThan(-1);
        expect(setAumidIdx).toBeGreaterThan(-1);
        expect(whenReadyIdx).toBeGreaterThan(-1);
        // AppUserModelId must be set before the app is ready on Windows, or
        // the OS may have already bucketed the process under a default id.
        expect(setNameIdx).toBeLessThan(whenReadyIdx);
        expect(setAumidIdx).toBeLessThan(whenReadyIdx);
    });

    it('package.json build.productName is "Cipherline" (top-level "name" is the npm workspace id and must stay "desktop"; there is no top-level "productName")', () => {
        expect(pkg.build?.productName).toBe('Cipherline');
    });
});
