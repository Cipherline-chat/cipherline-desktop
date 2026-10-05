import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

/**
 * An `ipcMain.handle` callback that DROPS its parameters is invisible to every
 * other kind of test here.
 *
 * `keys:get-rotation-bundle` shipped as:
 *
 *     ipcMain.handle('keys:get-rotation-bundle', async () => {
 *       return generateRotationBundle();      // <- opts silently discarded
 *     });
 *
 * while `preload.ts` had been passing `{ rotateSpk }` since the C5 split. So
 * `rotateSpk: false` never arrived and EVERY one-time-prekey top-up also
 * rotated the signed prekey — exactly the superseded-key pile-up that split
 * exists to prevent (each retired SPK private is kept 35 days and tried as a
 * candidate on every decrypt, against a top-up that runs whenever the pool
 * drops below 20).
 *
 * Nothing caught it, and nothing could have: unit tests call
 * `generateRotationBundle` directly, so they never cross the bridge; the
 * function's own behaviour was correct; `preload.ts` was correct; and
 * `tsc` is happy because a JS callback may always declare fewer parameters
 * than its caller supplies. The defect lived purely in the WIRING.
 *
 * `electron/main.ts` imports `electron` and therefore cannot be loaded under
 * vitest (see the note in `vitest.config.ts`), so this reads the source — the
 * same approach `backupRegistry`'s test uses for the same reason. It is a
 * coarse check and deliberately so: it asserts the argument REACHES the
 * function, which is the exact thing that was missing.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN_TS = path.resolve(here, '..', '..', 'electron', 'main.ts');
const PRELOAD_TS = path.resolve(here, '..', '..', 'electron', 'preload.ts');

/** The source text of the `ipcMain.handle('<channel>', ...)` callback body. */
function handlerSource(source: string, channel: string): string {
    const start = source.indexOf(`ipcMain.handle('${channel}'`);
    expect(start, `no ipcMain.handle registration for '${channel}'`).toBeGreaterThan(-1);

    // Walk balanced parentheses from the opening `(` of the handle() call.
    const open = source.indexOf('(', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`unbalanced parentheses in the '${channel}' registration`);
}

describe('IPC handlers forward the arguments preload sends them', () => {
    const main = fs.readFileSync(MAIN_TS, 'utf8');
    const preload = fs.readFileSync(PRELOAD_TS, 'utf8');

    it('preload actually sends an options argument on keys:get-rotation-bundle', () => {
        // The other half of the contract. If preload stopped sending `opts`,
        // the assertion below would be guarding nothing.
        expect(preload).toContain("ipcRenderer.invoke('keys:get-rotation-bundle', opts)");
    });

    it('the keys:get-rotation-bundle handler PASSES its options to generateRotationBundle', () => {
        const body = handlerSource(main, 'keys:get-rotation-bundle');

        // 1. The callback must declare a second parameter at all. The bug was a
        //    zero-parameter `async () =>`, which TypeScript accepts happily.
        const params = body.slice(body.indexOf(',') + 1, body.indexOf('=>'));
        expect(
            params.replace(/\s/g, ''),
            'handler callback declares no parameter for the options preload sends',
        ).not.toMatch(/^async\(\)/);

        // 2. And it must actually hand them on. `generateRotationBundle()` with
        //    empty parens is the exact shape of the shipped bug.
        expect(body).not.toMatch(/generateRotationBundle\(\s*\)/);
        expect(body).toMatch(/generateRotationBundle\(\s*\w/);
    });

    it('the rotateSpk split is reachable end to end — the renderer sets it, the generator reads it', () => {
        // useKeyRotation decides rotateSpk from spk_age_days and passes it to
        // getRotationBundle; preload forwards it; main hands it to the
        // generator, which defaults it to true. Every link is asserted
        // elsewhere except the one that broke, so this pins the chain's shape.
        const hook = fs.readFileSync(
            path.resolve(here, '..', 'hooks', 'useKeyRotation.ts'), 'utf8',
        );
        expect(hook).toMatch(/rotateSpk/);
        expect(preload).toMatch(/rotateSpk\?: boolean/);
        expect(main).toMatch(/rotateSpk\?: boolean/);
    });

    it('the prekey id lists ride the same channel, so the same drop would disable them too', () => {
        const body = handlerSource(main, 'keys:get-rotation-bundle');
        expect(body).toMatch(/unclaimedPrekeyIds/);
        expect(body).toMatch(/retiredPrekeyIds/);
    });
});
