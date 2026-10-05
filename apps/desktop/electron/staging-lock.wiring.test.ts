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
        expect(body).toMatch(/enforced:\s*STAGING_LOCK\.enforced,\s*unlocked:\s*stagingUnlocked/);
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
        expect(body).toContain('writeUnlockFileAtomic(STAGING_UNLOCK_PATH');
        // No console call may mention the password argument.
        for (const line of body.split('\n').filter((l) => /console\./.test(l))) {
            expect(line).not.toMatch(/password/i);
        }
    });

    it('relock forgets the unlock and moves a staging-channel install back to stable', () => {
        const body = handlerSource('staging-lock:relock');
        expect(body).toContain('stagingUnlocked = false');
        expect(body).toContain('removeUnlockFile(STAGING_UNLOCK_PATH)');
        expect(body).toMatch(/readChannel\(\) === 'staging'[\s\S]*applyUpdateChannel\('latest'\)/);
    });

    it('the mode is derived from app.isPackaged and the smoke-test flag, and reads nothing when not enforced', () => {
        expect(MAIN).toMatch(/resolveStagingLockMode\(\{\s*packaged: IS_PACKAGED,\s*smokeTest: IS_SMOKE_TEST,/);
        expect(MAIN).toContain('let stagingUnlocked = STAGING_LOCK.enforced ? readUnlockFileSync(STAGING_UNLOCK_PATH) : true;');
        // No SecureStore involvement at all (the smoke-test trap).
        const block = MAIN.slice(MAIN.indexOf('const STAGING_LOCK = '), MAIN.indexOf('const stagingLockStatus'));
        expect(block).not.toContain('secureStore');
    });

    it('preload exposes the three calls and forwards the password argument', () => {
        expect(PRELOAD).toContain("ipcRenderer.invoke('staging-lock:status')");
        expect(PRELOAD).toContain("ipcRenderer.invoke('staging-lock:unlock', password)");
        expect(PRELOAD).toContain("ipcRenderer.invoke('staging-lock:relock')");
        expect(handlerSource('staging-lock:unlock')).toMatch(/\(_event, password: unknown\)/);
    });
});
