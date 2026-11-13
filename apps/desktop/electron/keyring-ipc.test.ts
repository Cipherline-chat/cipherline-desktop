import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KEYRING_ACTION_CHANNEL, KEYRING_STATUS_CHANNEL, parseKeyringAction, relaunchOptions } from './keyring-ipc';

describe('parseKeyringAction: strict, never coerced', () => {
    it('accepts exactly { action: "retry" }', () => {
        expect(parseKeyringAction({ action: 'retry' })).toEqual({ action: 'retry' });
        expect(parseKeyringAction(Object.assign(Object.create(null), { action: 'retry' }))).toEqual({ action: 'retry' });
    });

    it('NEGATIVE CONTROLS: everything else is refused', () => {
        const bad: unknown[] = [
            undefined, null, 0, 1, true, 'retry', [], ['retry'], () => 'retry', Symbol('retry'),
            {}, { action: '' }, { action: 'Retry' }, { action: 'retry ' }, { action: 'RETRY' },
            { action: 'unlock' }, { action: 'factory-reset' }, { action: 'recover', key: 'x' },
            { action: 1 }, { action: null }, { action: ['retry'] }, { action: { toString: () => 'retry' } },
            { action: 'retry', extra: 1 }, { action: 'retry', password: 'hunter2' }, { Action: 'retry' },
            { retry: true },
        ];
        for (const input of bad) expect(parseKeyringAction(input), JSON.stringify(String(input))).toBeNull();
    });

    it('refuses class instances and prototype tricks', () => {
        class Evil { action = 'retry'; }
        expect(parseKeyringAction(new Evil())).toBeNull();
        const child = Object.create({ action: 'retry' });
        expect(parseKeyringAction(child)).toBeNull();
        expect(parseKeyringAction(JSON.parse('{"__proto__":{"action":"retry"}}'))).toBeNull();
    });

    it('has no way to carry a secret: the only accepted payload is one fixed enum', () => {
        expect(JSON.stringify(parseKeyringAction({ action: 'retry' }))).toBe('{"action":"retry"}');
    });
});

describe('relaunchOptions', () => {
    it('regular install: relaunch the same executable with the same arguments', () => {
        expect(relaunchOptions({}, ['/opt/Cipherline/cipherline', '--foo', 'bar'])).toEqual({ args: ['--foo', 'bar'] });
    });

    it('AppImage: relaunch the .AppImage FILE, not the (unmounted) path inside it', () => {
        expect(relaunchOptions({ APPIMAGE: '/home/u/Apps/Cipherline.AppImage' }, ['/tmp/.mount_abc/cipherline', '--x']))
            .toEqual({ execPath: '/home/u/Apps/Cipherline.AppImage', args: ['--x'] });
    });

    it('a relative or empty $APPIMAGE is ignored', () => {
        expect(relaunchOptions({ APPIMAGE: 'Cipherline.AppImage' }, ['x'])).toEqual({ args: [] });
        expect(relaunchOptions({ APPIMAGE: '' }, ['x'])).toEqual({ args: [] });
    });
});

describe('channel names', () => {
    it('are the ones the preload invokes, and main registers', () => {
        expect(KEYRING_STATUS_CHANNEL).toBe('secure:get-keyring-status');
        expect(KEYRING_ACTION_CHANNEL).toBe('secure:keyring-action');
        const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
        expect(preload).toContain(`ipcRenderer.invoke('${KEYRING_STATUS_CHANNEL}')`);
        expect(preload).toContain(`ipcRenderer.invoke('${KEYRING_ACTION_CHANNEL}', { action: 'retry' })`);
        const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
        expect(main).toContain('ipcMain.handle(KEYRING_STATUS_CHANNEL');
        expect(main).toContain('ipcMain.handle(KEYRING_ACTION_CHANNEL');
        expect(main).toContain('parseKeyringAction(payload)');
    });

    it('neither channel is exempt from the sender check (ipc-guard UNGUARDED_IPC_CHANNELS stays empty)', async () => {
        const { channelRequiresSenderCheck } = await import('./ipc-guard');
        expect(channelRequiresSenderCheck(KEYRING_STATUS_CHANNEL)).toBe(true);
        expect(channelRequiresSenderCheck(KEYRING_ACTION_CHANNEL)).toBe(true);
    });
});
