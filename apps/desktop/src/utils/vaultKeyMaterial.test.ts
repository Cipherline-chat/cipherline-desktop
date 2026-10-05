import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * History transfer §2 (mobile handoff, 2026-09-24) — per-device key material
 * left the device in every export.
 *
 * `exportLocalHistory` wrote `cipherline_private_key` / `cipherline_public_key`
 * into EVERY vault: backups and device-to-device history transfers alike. The
 * first-run "Restore from backup file" screen then wrote that pair onto the new
 * device. That breaks CLAUDE.md's multi-device rule ("each device has its own
 * ... identity ... nothing copied between devices"): whoever holds any backup
 * or intercepts any transfer holds another device's private key, and every
 * restored device ends up sharing it.
 *
 * The pair is a legacy Ed25519 key generated per device by AuthContext.login;
 * nothing in message crypto uses it, and the server never sees or checks it.
 * So: never exported, and ignored wherever an old vault still carries one.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: () => true,
};
vi.mock('./secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { exportLocalHistory, importLocalHistory } = await import('./crypto');

const UID = 'key-material-user';
const THIS_DEVICE_PRIV = 'VEhJUy1ERVZJQ0UtUFJJVkFURS1LRVktMzItQllURVMhIQ==';
const THIS_DEVICE_PUB = 'VEhJUy1ERVZJQ0UtUFVCTElDLUtFWQ==';

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
    // The transfer path lazy-imports historyTransfer → attachmentDownload →
    // axios, whose platform probe reads window.location.href at import time.
    if (!(window as { location?: unknown }).location) {
        Object.assign(window, { location: { href: 'http://localhost/', origin: 'http://localhost' } });
    }
});
beforeEach(() => {
    mem.clear();
    Object.assign(window, { electronAPI: undefined, dispatchEvent: () => true });
    mem.set('cipherline_private_key', THIS_DEVICE_PRIV);
    mem.set('cipherline_public_key', THIS_DEVICE_PUB);
    mem.set(`cipherline_convs_${UID}`, JSON.stringify([{ conversation_id: 'conv-1', type: 'dm' }]));
    mem.set(`cipherline_msgs_${UID}_conv-1`, JSON.stringify([
        { id: 'm1', content: { type: 'text', text: 'hi' }, timestamp: new Date().toISOString() },
    ]));
});

async function exported(opts: Parameters<typeof exportLocalHistory>[1]): Promise<{ json: string; vault: Record<string, unknown> }> {
    const json = await (await exportLocalHistory(UID, opts)).text();
    return { json, vault: JSON.parse(json) };
}

describe('exportLocalHistory never carries this device\'s keypair', () => {
    it.each([
        ['a backup (unfiltered export)', { includeGifFiles: false }],
        ['a device-to-device transfer (rangeDays set)', { rangeDays: null, includeGifFiles: false }],
        ['a per-type transfer', { rangeDays: 30, includeDmMessages: true, includeGroupMessages: true, includeServerMessages: false, includeGifFiles: false }],
    ])('%s', async (_label, opts) => {
        const { json, vault } = await exported(opts);
        expect(vault).not.toHaveProperty('privateKey');
        expect(vault).not.toHaveProperty('publicKey');
        // Not under any other name either.
        expect(json).not.toContain(THIS_DEVICE_PRIV);
        expect(json).not.toContain(THIS_DEVICE_PUB);
        // Positive control: the export is live and did carry the history.
        expect(Object.keys(vault.history as object)).toContain('conv-1');
    });
});

describe('importing an old vault that still carries a keypair', () => {
    it('ignores it: this device keeps its own pair', async () => {
        await importLocalHistory(UID, new Blob([JSON.stringify({
            version: 4, userId: UID, deviceId: 'other-device',
            privateKey: 'OTHER-DEVICE-PRIVATE', publicKey: 'OTHER-DEVICE-PUB',
            topics: [], history: {},
        })], { type: 'application/json' }));
        expect(mem.get('cipherline_private_key')).toBe(THIS_DEVICE_PRIV);
        expect(mem.get('cipherline_public_key')).toBe(THIS_DEVICE_PUB);
    });
});

describe('the first-run restore screen no longer installs a backup\'s keypair', () => {
    const code = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('AuthScreen never writes the key slots from a backup, and does not require them', () => {
        const src = code('components/AuthScreen.tsx');
        // Meta: the scan is looking at the real restore handler.
        expect(src).toContain('const handleRestoreBackup');
        expect(src).toContain('backup.apply(');
        expect(src).not.toContain("setItem('cipherline_private_key'");
        expect(src).not.toContain("setItem('cipherline_public_key'");
        expect(src).not.toContain('backup.privateKey');
        expect(src).not.toContain('backup.publicKey');
    });

    it('openBackupFile does not hand a keypair to its caller', () => {
        const src = code('services/driveBackup.ts');
        expect(src).toContain('export async function openBackupFile');
        expect(src).not.toMatch(/privateKey\s*:/);
        expect(src).not.toMatch(/publicKey\s*:/);
    });
});
