import { describe, expect, it } from 'vitest';
import { resolveNearHelper } from './near-helper-path';

const have = (...paths: string[]) => (p: string) => paths.includes(p);
const base = { platform: 'linux' as const, envHelper: undefined, resourcesPath: '/opt/Cipherline/resources', devTargetDir: '/repo/apps/desktop-host/near-helper/target' };

describe('resolveNearHelper', () => {
    it('a packaged build uses only <resources>/near-helper and ignores the env override and the dev tree', () => {
        const exists = have('/opt/Cipherline/resources/near-helper', '/evil/helper', '/repo/apps/desktop-host/near-helper/target/release/cl-near-helper');
        expect(resolveNearHelper({ ...base, isPackaged: true, envHelper: '/evil/helper', exists })).toEqual({ path: '/opt/Cipherline/resources/near-helper', source: 'packaged' });
        expect(resolveNearHelper({ ...base, isPackaged: true, exists: have('/evil/helper') })).toBeNull();
        expect(resolveNearHelper({ ...base, isPackaged: true, exists: have('/repo/apps/desktop-host/near-helper/target/release/cl-near-helper') })).toBeNull();
    });

    it('unpackaged: env override, then the in-tree release build, then debug', () => {
        const rel = '/repo/apps/desktop-host/near-helper/target/release/cl-near-helper';
        const dbg = '/repo/apps/desktop-host/near-helper/target/debug/cl-near-helper';
        expect(resolveNearHelper({ ...base, isPackaged: false, envHelper: '/x/h', exists: have('/x/h', rel) })).toEqual({ path: '/x/h', source: 'env' });
        expect(resolveNearHelper({ ...base, isPackaged: false, exists: have(rel, dbg) })).toEqual({ path: rel, source: 'dev' });
        expect(resolveNearHelper({ ...base, isPackaged: false, exists: have(dbg) })).toEqual({ path: dbg, source: 'dev' });
        expect(resolveNearHelper({ ...base, isPackaged: false, exists: have() })).toBeNull();
    });

    it('a relative or missing env override is not used', () => {
        expect(resolveNearHelper({ ...base, isPackaged: false, envHelper: 'rel/helper', exists: () => true })?.source).not.toBe('env');
        expect(resolveNearHelper({ ...base, isPackaged: false, envHelper: '/gone', exists: have() })).toBeNull();
    });

    it('Windows: the packaged file is near-helper.exe under resources, and the dev tree uses cl-near-helper.exe', () => {
        const w = { platform: 'win32' as const, envHelper: undefined, resourcesPath: 'C:\\Program Files\\Cipherline\\resources', devTargetDir: 'C:\\dev\\cl\\apps\\desktop-host\\near-helper\\target' };
        const pk = 'C:\\Program Files\\Cipherline\\resources\\near-helper.exe';
        expect(resolveNearHelper({ ...w, isPackaged: true, exists: have(pk) })).toEqual({ path: pk, source: 'packaged' });
        // the extensionless name is not the Windows file
        expect(resolveNearHelper({ ...w, isPackaged: true, exists: have('C:\\Program Files\\Cipherline\\resources\\near-helper') })).toBeNull();
        const rel = 'C:\\dev\\cl\\apps\\desktop-host\\near-helper\\target\\release\\cl-near-helper.exe';
        expect(resolveNearHelper({ ...w, isPackaged: false, exists: have(rel) })).toEqual({ path: rel, source: 'dev' });
        // a packaged build never takes the env override on Windows either
        expect(resolveNearHelper({ ...w, isPackaged: true, envHelper: 'C:\\evil\\h.exe', exists: have('C:\\evil\\h.exe') })).toBeNull();
        expect(resolveNearHelper({ ...w, isPackaged: false, envHelper: 'C:\\x\\h.exe', exists: have('C:\\x\\h.exe') })?.source).toBe('env');
        expect(resolveNearHelper({ ...w, isPackaged: false, envHelper: 'rel\\h.exe', exists: () => true })?.source).not.toBe('env');
    });
});
