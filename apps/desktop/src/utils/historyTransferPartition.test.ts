import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * History transfer §3 (mobile handoff, 2026-09-24) — the send dialog's
 * separate "DMs" and "Groups" toggles did nothing useful.
 *
 * `partitionHistoryByType` built its DM set from `t.id`, but the topics it is
 * handed are the raw `GET /v1/conversations` rows the Dashboard caches under
 * `cipherline_convs_<uid>` — keyed `conversation_id`, with no `id` at all. So
 * the DM set was always empty and every conversation counted as a group:
 * "DMs only" sent nothing, "Groups only" sent the DMs too, and the attachment
 * toggles (same function) followed suit.
 */

// historyTransfer → attachmentDownload → axios probes window.location at
// IMPORT time, so this has to run before the dynamic import below.
if (!(window as { location?: unknown }).location) {
    Object.assign(window, { location: { href: 'http://localhost/', origin: 'http://localhost' } });
}

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

const { partitionHistoryByType } = await import('./historyTransfer');

beforeAll(() => {
    Object.assign(window, { crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob });
});

/** Exactly the row shape `ConversationsService.getConversations` returns. */
const TOPICS = [
    { conversation_id: 'dm-1', type: 'dm', title: 'Ana' },
    { conversation_id: 'grp-1', type: 'group', title: 'Team' },
];
const HISTORY = {
    'dm-1': [{ id: 'a' }],
    'grp-1': [{ id: 'b' }],
};

describe('partitionHistoryByType', () => {
    it('splits real GET /v1/conversations rows (keyed conversation_id) into DMs and groups', () => {
        const { dm, group } = partitionHistoryByType(HISTORY, TOPICS);
        expect(Object.keys(dm)).toEqual(['dm-1']);
        expect(Object.keys(group)).toEqual(['grp-1']);
    });

    it('still accepts rows keyed `id` (the shape its old signature assumed)', () => {
        const { dm, group } = partitionHistoryByType(HISTORY, [{ id: 'dm-1', type: 'dm' }, { id: 'grp-1', type: 'group' }]);
        expect(Object.keys(dm)).toEqual(['dm-1']);
        expect(Object.keys(group)).toEqual(['grp-1']);
    });
});

describe('exportLocalHistory honours the DM / group toggles end to end', () => {
    const UID = 'partition-user';

    async function exportWith(opts: Record<string, unknown>): Promise<string[]> {
        const { exportLocalHistory } = await import('./crypto');
        mem.clear();
        Object.assign(window, { electronAPI: undefined, dispatchEvent: () => true });
        const now = new Date().toISOString();
        mem.set(`cipherline_convs_${UID}`, JSON.stringify(TOPICS));
        mem.set(`cipherline_msgs_${UID}_dm-1`, JSON.stringify([{ id: 'a', timestamp: now, content: { type: 'text', text: 'dm' } }]));
        mem.set(`cipherline_msgs_${UID}_grp-1`, JSON.stringify([{ id: 'b', timestamp: now, content: { type: 'text', text: 'grp' } }]));
        const vault = JSON.parse(await (await exportLocalHistory(UID, { rangeDays: 30, includeGifFiles: false, ...opts })).text());
        return Object.keys(vault.history).sort();
    }

    it('"DMs only" sends the DM and not the group', async () => {
        expect(await exportWith({ includeDmMessages: true, includeGroupMessages: false })).toEqual(['dm-1']);
    });

    it('"Groups only" sends the group and not the DM', async () => {
        expect(await exportWith({ includeDmMessages: false, includeGroupMessages: true })).toEqual(['grp-1']);
    });

    it('both on sends both', async () => {
        expect(await exportWith({ includeDmMessages: true, includeGroupMessages: true })).toEqual(['dm-1', 'grp-1']);
    });
});
