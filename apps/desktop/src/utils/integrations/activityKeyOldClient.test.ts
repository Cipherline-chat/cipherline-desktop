import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OLD-CLIENT behaviour of the activity-key delivery (desktop <= 1.0.23).
 *
 * The key rides in an extra `activity_key` field of a `profile_update`, exactly
 * like `status_emoji` (statusEmojiOldClient.test.ts). This pins, against the
 * receive code an old client runs (dmInbound.ts / contentValidation.ts are not
 * touched by this change), that it is validated, dropped without a chat row,
 * and acted on by nothing - so an old friend simply keeps the catalogue cover.
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
    flushDurable: vi.fn(async () => {}),
};
vi.mock('../secureLocalStore', () => ({ default: fakeStore, secureLocalStore: fakeStore }));

const { applyIncomingDmMessages } = await import('../dmInbound');
const { contentProblem, storedContentProblem } = await import('../contentValidation');
const { shareActivityKey } = await import('./activityKeys');

/** The exact content a new client sends, built by the real sender. */
async function realKeyContent(): Promise<Record<string, unknown>> {
    mem.clear();
    let content: unknown = null;
    await shareActivityKey('alice', ['bob'], [{ userId: 'bob', conversationId: 'c1' }], {
        send: async (_t, c) => { content = c; return 'sent'; },
        now: () => 1, sleep: async () => {}, newId: () => 'm1',
    });
    return JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
}

const received = (content: Record<string, unknown>) => ({
    id: 'm1', content, sender_user_id: 'alice', sender_device_id: 'd1', timestamp: '2026-10-28T00:00:00Z', conversation_id: 'c1',
});

describe('old client receiving the activity-key delivery', () => {
    it('passes its content validation (no "could not be shown" placeholder)', async () => {
        const c = await realKeyContent();
        expect(c.type).toBe('profile_update');
        expect(contentProblem(c)).toBeNull();
        expect(storedContentProblem(c)).toBeNull();
    });

    it('becomes NO chat row', async () => {
        const c = await realKeyContent();
        expect(applyIncomingDmMessages({ c1: [] }, { c1: [received(c) as never] }).c1).toEqual([]);
    });

    it('names no avatar / banner, so the old profile_update handler does nothing with it', async () => {
        const c = await realKeyContent();
        expect(c).not.toHaveProperty('avatar_attachment_id');
        expect(c).not.toHaveProperty('banner_attachment_id');
        const src = readFileSync(join(__dirname, '../../components/Dashboard.tsx'), 'utf8');
        const handler = src.slice(src.indexOf("if (m.content?.type !== 'profile_update'"));
        expect(handler).toContain('if (m.content.avatar_attachment_id)');
    });

    it('a NEW client strips the key before the message goes anywhere (Dashboard pull loop)', () => {
        const src = readFileSync(join(__dirname, '../../components/Dashboard.tsx'), 'utf8');
        expect(src).toMatch(/const content = takeActivityKey\(ingestInboundStatusEmoji\(ingestInboundContent\(JSON\.parse\(contentJson\)\)/);
    });
});
