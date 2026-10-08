import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UNGUARDED_IPC_CHANNELS } from './ipc-guard';

/**
 * main.ts imports `electron` and cannot load under vitest, so — like
 * src/utils/ipcParameterForwarding.test.ts — this reads the source to pin
 * the WIRING of the staging lock: the pure policy is tested in
 * staging-lock.test.ts, but a policy nobody calls protects nothing.
 */
const MAIN = fs.readFileSync(path.resolve(__dirname, 'main.ts'), 'utf8');
const PRELOAD = fs.readFileSync(path.resolve(__dirname, 'preload.ts'), 'utf8');

function handlerSource(channel: string): string {
    const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
    expect(start, `no ipcMain.handle registration for '${channel}'`).toBeGreaterThan(-1);
    const open = MAIN.indexOf('(', start);
    let depth = 0;
    for (let i = open; i < MAIN.length; i++) {
        if (MAIN[i] === '(') depth++;
        else if (MAIN[i] === ')' && --depth === 0) return MAIN.slice(open, i + 1);
    }
    throw new Error(`unbalanced parentheses in '${channel}'`);
}

/** Source of a top-level `function name(...) { ... }` in main.ts. */
function fnSource(name: string): string {
    const start = MAIN.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
    expect(start, `no function ${name} in main.ts`).toBeGreaterThan(-1);
    const open = MAIN.indexOf('{', MAIN.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < MAIN.length; i++) {
        if (MAIN[i] === '{') depth++;
        else if (MAIN[i] === '}' && --depth === 0) return MAIN.slice(start, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

describe('staging lock wiring in main.ts', () => {
    it('updater:set-channel consults the policy and throws the distinct error BEFORE the consent dialog or any write', () => {
        const body = handlerSource('updater:set-channel');
        const policy = body.indexOf('decideSetChannel(');
        const thrown = body.indexOf('throw new Error(STAGING_LOCKED_ERROR)');
        const dialog = body.indexOf('dialog.showMessageBox');
        const write = body.indexOf('applyUpdateChannel(ch)');
        expect(policy).toBeGreaterThan(-1);
        expect(thrown).toBeGreaterThan(policy);
        expect(dialog).toBeGreaterThan(thrown);
        expect(write).toBeGreaterThan(thrown);
        expect(body).toMatch(/enforced:\s*STAGING_LOCK\.enforced,\s*unlocked:\s*isStagingUnlocked\(\)/);
    });

    it('registers status / unlock / relock, all through the ordinary guarded ipcMain.handle', () => {
        for (const ch of ['staging-lock:status', 'staging-lock:unlock', 'staging-lock:relock']) {
            handlerSource(ch);
            expect(UNGUARDED_IPC_CHANNELS.has(ch)).toBe(false);
        }
        // Registered after the guard is installed (the guard wraps ipcMain.handle itself).
        expect(MAIN.indexOf("ipcMain.handle('staging-lock:status'")).toBeGreaterThan(MAIN.indexOf('installIpcSenderGuard();'));
    });

    it('unlock validates input, applies the limiter before scrypt, verifies against the shipped verifier, and logs no input', () => {
        const body = handlerSource('staging-lock:unlock');
        const validate = body.indexOf('isAcceptablePasswordInput(password)');
        const limiter = body.indexOf('stagingAttempts.retryAfterMs()');
        const verify = body.indexOf('verifyPassword(password, STAGING_VERIFIER)');
        expect(validate).toBeGreaterThan(-1);
        expect(limiter).toBeGreaterThan(validate);
        expect(verify).toBeGreaterThan(limiter);
        expect(body).toContain('stagingAttempts.recordFailure()');
        expect(body).toContain('stagingAttempts.recordSuccess()');
        // Remembered in SecureStore (awaited to disk), and the legacy file is
        // never written again — only cleaned up.
        expect(body).toContain('await rememberStagingUnlock()');
        expect(MAIN).not.toContain('writeUnlockFileAtomic(');
        // Verification and the state flip happen before the only await, so
        // two concurrent attempts cannot interleave around the limiter.
        expect(body.indexOf('await ')).toBeGreaterThan(body.indexOf('stagingUnlocked = true'));
        // No console call may mention the password argument.
        for (const line of body.split('\n').filter((l) => /console\./.test(l))) {
            expect(line).not.toMatch(/password/i);
        }
    });

    it('relock forgets the unlock and moves a staging-channel install back to stable', () => {
        const body = handlerSource('staging-lock:relock');
        expect(body).toContain('stagingUnlocked = false');
        expect(body).toContain('forgetStagingUnlock()');
        const forget = fnSource('forgetStagingUnlock');
        expect(forget).toContain('secureStore.delete(STAGING_UNLOCK_KEY)');
        expect(forget).toContain('removeUnlockFile(STAGING_UNLOCK_PATH)');
        expect(body).toMatch(/readChannel\(\) === 'staging'[\s\S]*applyUpdateChannel\('latest'\)/);
    });

    it('the mode is derived from app.isPackaged and the smoke-test flag; module scope starts LOCKED and touches no store', () => {
        expect(MAIN).toMatch(/resolveStagingLockMode\(\{\s*packaged: IS_PACKAGED,\s*smokeTest: IS_SMOKE_TEST,/);
        expect(MAIN).toContain('let stagingUnlocked = !STAGING_LOCK.enforced;');
        // Nothing at module scope reads or writes SecureStore (it is not
        // initialized yet, and under the smoke test it is pathless).
        const block = MAIN.slice(MAIN.indexOf('const STAGING_LOCK = '), MAIN.indexOf('const stagingLockStatus'));
        expect(block).not.toContain('secureStore');
    });

    it('every SecureStore touch is gated on stagingStoreUsable(), which excludes the smoke test and a non-ok store', () => {
        const usable = fnSource('stagingStoreUsable');
        expect(usable).toContain('STAGING_LOCK.enforced');
        expect(usable).toContain('!IS_SMOKE_TEST');
        expect(usable).toContain("secureStore.status() === 'ok'");
        for (const name of ['readStagingMarker', 'rememberStagingUnlock']) {
            const src = fnSource(name);
            const gate = src.indexOf('if (!stagingStoreUsable()) return');
            expect(gate, name).toBeGreaterThan(-1);
            expect(src.indexOf('secureStore.'), name).toBeGreaterThan(gate);
        }
        const forget = fnSource('forgetStagingUnlock');
        expect(forget.indexOf('secureStore.delete')).toBeGreaterThan(forget.indexOf('if (stagingStoreUsable())'));
        // The startup loader bails out first under the smoke test / when not enforced.
        const load = fnSource('loadRememberedStagingUnlock');
        expect(load).toMatch(/^[^]*?\{\s*if \(!STAGING_LOCK\.enforced \|\| IS_SMOKE_TEST\) return;/);
        // The marker is written only bound to the shipped verifier.
        expect(fnSource('rememberStagingUnlock')).toContain('serializeUnlockMarker(STAGING_VERIFIER, Date.now())');
    });

    it('the remembered unlock is settled at the storeReady barrier, before the staging-lock IPC and the window', () => {
        const barrier = MAIN.indexOf('const storeOk = await storeReady');
        const load = MAIN.indexOf('loadRememberedStagingUnlock();', barrier);
        expect(barrier).toBeGreaterThan(-1);
        expect(load).toBeGreaterThan(barrier);
        expect(MAIN.indexOf("ipcMain.handle('staging-lock:status'")).toBeGreaterThan(load);
        expect(MAIN.indexOf("ipcMain.handle('updater:set-channel'")).toBeGreaterThan(load);
        expect(MAIN.indexOf('await createWindow(', load)).toBeGreaterThan(load);
        // The launch-time decision uses resolveRememberedUnlock (marker bound
        // to the verifier; legacy file only under the legacy verifier).
        expect(fnSource('loadRememberedStagingUnlock')).toMatch(/resolveRememberedUnlock\(\{[^}]*verifier: STAGING_VERIFIER/);
        expect(fnSource('isStagingUnlocked')).toMatch(/resolveRememberedUnlock\(\{[^}]*legacyFileValid: false, verifier: STAGING_VERIFIER/);
        // Status reports the live answer.
        expect(MAIN).toMatch(/unlocked: isStagingUnlocked\(\),/);
    });

    it('preload exposes the three calls and forwards the password argument', () => {
        expect(PRELOAD).toContain("ipcRenderer.invoke('staging-lock:status')");
        expect(PRELOAD).toContain("ipcRenderer.invoke('staging-lock:unlock', password)");
        expect(PRELOAD).toContain("ipcRenderer.invoke('staging-lock:relock')");
        expect(handlerSource('staging-lock:unlock')).toMatch(/\(_event, password: unknown\)/);
    });
});
