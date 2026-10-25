import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * OLD-CLIENT behaviour of the status-emoji delivery (desktop <= 1.0.22).
 *
 * The control message is a `profile_update` with an extra `status_emoji` field.
 * A brand-new content type would NOT be hidden on those clients: the receive
 * path (utils/dmInbound.ts applyIncomingDmMessages) makes a chat row of any type
 * it does not list, and the renderer shows "Unsupported message variant". This
 * pins that the chosen carrier is dropped without a row by the receive code an
 * old client runs - dmInbound.ts and contentValidation.ts are NOT touched by this
 * change, so running them here is running the old client's path.
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
const { shareStatusEmoji, statusEmojiRef } = await import('./statusEmoji');
const { personalEmojiIdFromBytes } = await import('./token');

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** The exact content a new client sends, built by the real sender. */
async function realShareContent(): Promise<Record<string, unknown>> {
    const id = await personalEmojiIdFromBytes(png);
    let content: unknown = null;
    await shareStatusEmoji(statusEmojiRef(id), 'alice', [{ userId: 'bob', conversationId: 'c1' }], {
        store: { read: async () => png, meta: () => undefined },
        load: () => ({}), save: () => {},
        send: async (_t, c) => { content = c; return 'sent'; },
        now: () => 1, sleep: async () => {}, newId: () => 'm1',
    });
    return JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
}

const received = (content: Record<string, unknown>) => ({
    id: 'm1', content, sender_user_id: 'alice', sender_device_id: 'd1', timestamp: '2026-10-24T00:00:00Z', conversation_id: 'c1',
});

describe('old client receiving the status-emoji delivery', () => {
    it('passes its content validation (unknown extra fields are ignored, so no "could not be shown" placeholder)', async () => {
        const c = await realShareContent();
        expect(c.type).toBe('profile_update');
        expect(contentProblem(c)).toBeNull();
        expect(storedContentProblem(c)).toBeNull();
    });

    it('becomes NO chat row: applyIncomingDmMessages drops a profile_update, whatever else it carries', async () => {
        const c = await realShareContent();
        const out = applyIncomingDmMessages({ c1: [] }, { c1: [received(c) as never] });
        expect(out.c1).toEqual([]);
        // And it does not disturb rows that are there.
        const existing = { id: 'x', content: { type: 'text', text: 'hi' }, sender_user_id: 'alice', sender_device_id: 'd1', timestamp: 't', conversation_id: 'c1' };
        expect(applyIncomingDmMessages({ c1: [existing as never] }, { c1: [received(c) as never] }).c1).toEqual([existing]);
    });

    it('does what an old client does with profile_update: nothing, because no avatar / banner is named', async () => {
        const c = await realShareContent();
        expect(c).not.toHaveProperty('avatar_attachment_id');
        expect(c).not.toHaveProperty('banner_attachment_id');
        // Dashboard's profile_update handler acts only on those two fields.
        const src = readFileSync(join(__dirname, '../../components/Dashboard.tsx'), 'utf8');
        const handler = src.slice(src.indexOf("if (m.content?.type !== 'profile_update'"));
        expect(handler).toContain('if (m.content.avatar_attachment_id)');
        expect(handler).toContain("m.content.type === 'profile_update' && m.content.banner_attachment_id");
    });

    it('is not an unread / notification / preview candidate on an old client', () => {
        const src = readFileSync(join(__dirname, '../../components/Dashboard.tsx'), 'utf8');
        // The pull loop only notifies for these types; profile_update is not one of them.
        expect(src).toContain("['text', 'attachment', 'server_invite', 'safety_number', 'klipy_gif'].includes(m.content.type)");
        // Retention treats it as a control row, never a visible message.
        const sweeper = readFileSync(join(__dirname, '../retentionSweeper.ts'), 'utf8');
        expect(sweeper).toMatch(/CONTROL_TYPES[\s\S]*'profile_update'/);
    });

    it('CONTROL: a brand-new content type WOULD have become a visible row on that client (why it is not used)', () => {
        const out = applyIncomingDmMessages({ c1: [] }, { c1: [received({ type: 'status_emoji', id: 'p_x' }) as never] });
        expect(out.c1).toHaveLength(1);
    });
});
