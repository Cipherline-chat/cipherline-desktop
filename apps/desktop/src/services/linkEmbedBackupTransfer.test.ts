import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Every backup round trip derives a real PBKDF2 key.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Sender-built link previews are message content (packages/shared
 * link-embeds.ts): they must survive the encrypted backup, the device-to-
 * device history transfer, and reach a report — franked, so a reported
 * preview is the one that was sent.
 *
 *   backup:   buildBackupPlan -> writeBackupRecords -> openContainer -> applyBackupContainer
 *   transfer: exportLocalHistory -> importLocalHistory
 *   report:   frankForSend (sender) -> frankBody / verifyFranking (reporter's recompute)
 *
 * secureLocalStore and the Electron file bridge are in-memory fakes; the
 * crypto, container, vault builder, importers and franking are real.
 */
const mem = new Map<string, string>();
const fakeStore = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    keysWithPrefix: (p: string) => [...mem.keys()].filter(k => k.startsWith(p)),
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
    hydrateMessages: async () => {},
    whenAccountReady: async () => {},
    isAccountReady: (u: string) => u === USER,
    flushNow: async () => {},
};
vi.mock('../utils/secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));
vi.mock('../utils/attachmentDownload', () => ({ downloadEncryptedAttachment: async () => null }));

const electronAPI = {
    getUserDataPath: async () => '/ud',
    listGifFiles: async () => [],
    readGifFile: async () => { throw new Error('ENOENT'); },
    writeGifFile: async () => {},
    deleteFile: async () => ({ ok: true }),
    listCustomSounds: async () => [],
};

const { exportLocalHistory, importLocalHistory } = await import('../utils/crypto');
const { buildBackupPlan, writeBackupRecords, applyBackupContainer } = await import('./backupRecords');
const { ContainerWriter, openContainer, MemoryContainer, memorySource } = await import('../utils/backupContainer');
const messageStore = await import('../utils/messageStore');
const { frankBody, frankForSend } = await import('../utils/franking');
const { sanitizeLinkEmbeds, withEditEmbeds } = await import('@cipherline/shared');
const { embedUrlsOf } = await import('../utils/formatting/plainText');

const USER = 'embed-user';
const PW = 'pw-for-test';

const TEXT = 'read https://arstechnica.com/reviews/2026/11/review/ and https://www.youtube.com/watch?v=jNQXAC9IVRw';
const EMBEDS = [
    {
        url: 'https://arstechnica.com/reviews/2026/11/review/', kind: 'card', site: 'Ars Technica', title: 'Review: The Asus ProArt P16',
        description: 'The new Asus ProArt laptop costs up to $7,000.', color: '#ff4e00', image_large: true,
        thumb: { mime: 'image/webp', width: 640, height: 360, attachment_id: '0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c', file_key_b64: 'A'.repeat(43) + '=', file_nonce_b64: 'B'.repeat(16), byte_size: 41_000 },
    },
    {
        url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', kind: 'player', site: 'YouTube', title: 'Me at the zoo', author: 'jawed',
        player: { provider: 'youtube', id: 'jNQXAC9IVRw' }, thumb: { mime: 'image/webp', width: 320, height: 180, inline_b64: btoa('RIFF$\u0000\u0000\u0000WEBPVP8 ' + 'x'.repeat(30)) },
    },
];

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});
function freshDevice(): void {
    mem.clear();
    messageStore._resetForTest();
    mem.set('cipherline_user_id', USER);
}
beforeEach(() => {
    freshDevice();
    Object.assign(window, { electronAPI, dispatchEvent: () => true });
});

function populate() {
    messageStore.saveAll('dm', USER, {
        'conv-bob': [{ id: 'm1', sender_id: 'bob', timestamp: 1_700_000_000_000, content: { type: 'text', text: TEXT, embeds: EMBEDS } }],
    });
    messageStore.saveAll('channel', USER, {
        'chan-1': [{ id: 'm2', sender_id: USER, timestamp: 1_700_000_100_000, content: { type: 'text', text: TEXT, embeds: [EMBEDS[1]] } }],
    });
}

async function assertArrived() {
    const dm = (await messageStore.loadAll('dm', USER))['conv-bob'];
    const c = dm.find(m => m.id === 'm1')!.content as { text: string; embeds: unknown };
    expect(c.embeds).toEqual(EMBEDS);
    // ...and every one of them still validates against the text, so it draws.
    expect(sanitizeLinkEmbeds(c.embeds, embedUrlsOf(c.text))).toHaveLength(2);
    const ch = (await messageStore.loadAll('channel', USER))['chan-1'];
    expect((ch[0].content as { embeds: unknown }).embeds).toEqual([EMBEDS[1]]);
}

describe('link embeds travel with their messages', () => {
    it('encrypted backup -> restore on a fresh device', async () => {
        populate();
        const plan = await buildBackupPlan(USER, { includeAttachments: false });
        const container = new MemoryContainer();
        const writer = await ContainerWriter.create(PW, container);
        await writeBackupRecords(plan, { fresh: writer });
        await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
        const opened = await openContainer(memorySource(container.bytes()), PW);
        freshDevice();
        expect(await messageStore.loadAll('dm', USER)).toEqual({});
        await applyBackupContainer(USER, opened);
        await assertArrived();
    });

    it('device-to-device history transfer', async () => {
        populate();
        const vault = await exportLocalHistory(USER, { rangeDays: null });
        freshDevice();
        await importLocalHistory(USER, vault);
        await assertArrived();
    });

    it('POSITIVE CONTROL: a restore of a backup without the message has no embeds', async () => {
        const plan = await buildBackupPlan(USER, { includeAttachments: false });
        const container = new MemoryContainer();
        const writer = await ContainerWriter.create(PW, container);
        await writeBackupRecords(plan, { fresh: writer });
        await writer.finish({ userId: USER, fingerprint: plan.fingerprint });
        freshDevice();
        await applyBackupContainer(USER, await openContainer(memorySource(container.bytes()), PW));
        expect((await messageStore.loadAll('dm', USER))['conv-bob']).toBeUndefined();
    });
});

describe('reports: the preview is in the reported (franked) body', () => {
    const content = { type: 'text', text: TEXT, embeds: EMBEDS };

    it('the body a reporter sends contains every preview\'s title, description and URL', () => {
        const fb = frankBody(content)!;
        expect(fb.kind).toBe('text');
        expect(fb.body.startsWith(TEXT)).toBe(true);
        expect(fb.body).toContain('[Link preview: https://arstechnica.com/reviews/2026/11/review/]');
        expect(fb.body).toContain('Title: Review: The Asus ProArt P16');
        expect(fb.body).toContain('Description: The new Asus ProArt laptop costs up to $7,000.');
        expect(fb.body).toContain('Player: youtube jNQXAC9IVRw');
        expect(fb.body).toContain('Picture: attachment 0b3c7a9e-1f2d-4c5b-8a6e-9d0f1e2a3b4c');
    });

    it('sender commitment and reporter recompute agree; a tampered preview does not', async () => {
        const ids = { contextKind: 'dm' as const, contextId: '11111111-2222-4333-8444-555555555555', senderUserId: '21111111-2222-4333-8444-555555555555', senderDeviceId: '31111111-2222-4333-8444-555555555555' };
        const sent = await frankForSend(JSON.stringify(content), ids);
        expect(sent.commitment_b64).toBeTruthy();
        const sealed = JSON.parse(sent.contentJson);
        // What the reporter recomputes from the content it received equals what was committed...
        expect(frankBody(sealed)!.body).toBe(frankBody(content)!.body);
        // ...and a different preview title gives a different body (so it would not verify).
        const tampered = { ...sealed, embeds: [{ ...EMBEDS[0], title: 'Official bank login' }, EMBEDS[1]] };
        expect(frankBody(tampered)!.body).not.toBe(frankBody(content)!.body);
    });

    it('a forged embed for a link not in the text adds nothing to the body; no embeds = bare text', () => {
        expect(frankBody({ type: 'text', text: 'hi https://a.example/', embeds: [{ url: 'https://phish.example/', kind: 'card', title: 'x' }] })!.body).toBe('hi https://a.example/');
        expect(frankBody({ type: 'text', text: 'plain' })!.body).toBe('plain');
    });

    it('after "Remove embed" (an edit with embeds: []) the body is the bare text again', () => {
        const edit = { type: 'edit', target_id: 'm1', text: TEXT, embeds: [] };
        expect(frankBody(edit)!.body).toBe(TEXT);
        const after = withEditEmbeds(content, edit);
        expect(frankBody(after)!.body).toBe(TEXT);
    });
});
