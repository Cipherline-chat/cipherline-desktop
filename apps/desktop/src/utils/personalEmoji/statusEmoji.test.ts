import { describe, expect, it, vi } from 'vitest';
import {
    STATUS_EMOJI_LEDGER_TTL_MS, ledgerHas, ledgerRecord, parseStatusEmojiLedger, personalIdOfStatusEmoji,
    shareStatusEmoji, statusEmojiFromSelection, statusEmojiRef, statusEmojiTargets, takeStatusEmoji,
    type ShareDeps, type ShareSendResult, type StatusEmojiLedger, type StatusEmojiShareContent,
} from './statusEmoji';
import { b64ToBytes, bytesToB64, personalEmojiIdFromBytes, PERSONAL_EMOJI_MAX_BYTES } from './token';
import { customStatusLabel, draftPayload, parseStatusEmoji } from '../customStatus';
import { personSecondary } from '../peoplePicker';

const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, 7, 7, 7]);
const webp = (n: number) => new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, n, 9]);
const gif = (n: number) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, n, 1, 2, 3]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

describe('status emoji reference', () => {
    it('a personal ref parses to its id; unicode and malformed refs do not', async () => {
        const id = await personalEmojiIdFromBytes(png(1));
        expect(personalIdOfStatusEmoji(statusEmojiRef(id))).toBe(id);
        expect(personalIdOfStatusEmoji('🔥')).toBeNull();
        expect(personalIdOfStatusEmoji('cl:p_xyz')).toBeNull();
        expect(personalIdOfStatusEmoji('cl:' + '123e4567-e89b-12d3-a456-426614174000')).toBeNull();
        expect(personalIdOfStatusEmoji(null)).toBeNull();
    });
    it('never prints the raw ref as text', () => {
        const ref = 'cl:p_' + 'a'.repeat(32);
        expect(parseStatusEmoji(ref)).toMatchObject({ kind: 'custom' });
        expect(customStatusLabel({ emoji: ref, text: 'lunch' })).toBe('lunch');
        expect(customStatusLabel({ emoji: '🍜', text: 'lunch' })).toBe('🍜 lunch');
        expect(personSecondary({ status: 'online', customText: 'lunch', customEmoji: ref } as never)).toBe('lunch');
    });
});

describe('picker choice -> payload', () => {
    const ID = 'p_' + 'b'.repeat(32);
    it('a unicode pick is kept', () => {
        expect(statusEmojiFromSelection({ native: '🎧' }, () => undefined)).toEqual({ emoji: '🎧' });
    });
    it('a My Emojis pick becomes cl:<id> and goes out in the save payload', () => {
        const choice = statusEmojiFromSelection({ id: ID, native: undefined }, () => ({ m: 'image/webp' }));
        expect(choice).toEqual({ emoji: `cl:${ID}` });
        const payload = draftPayload({ text: 'brb', emoji: (choice as { emoji: string }).emoji, clearAfter: 'never' }, null);
        expect(payload).toEqual({ text: 'brb', emoji: `cl:${ID}`, expiresAt: null });
    });
    it('a JPEG library emoji is refused with a reason (WebP/PNG/GIF only)', () => {
        expect(statusEmojiFromSelection({ id: ID }, () => ({ m: 'image/jpeg' }))).toMatchObject({ issue: expect.any(String) });
    });
    it('a server emoji or an empty pick is ignored', () => {
        expect(statusEmojiFromSelection({ id: '123e4567-e89b-12d3-a456-426614174000' }, () => undefined)).toBeNull();
        expect(statusEmojiFromSelection({}, () => undefined)).toBeNull();
    });
});

describe('who is a target - accepted friends with a DM, nobody else', () => {
    it('a non-friend DM, a friend without a DM and a duplicate are all left out', () => {
        const t = statusEmojiTargets(
            ['f1', 'f2', 'f3'],
            [
                { conversationId: 'c1', otherUserId: 'f1' },
                { conversationId: 'cX', otherUserId: 'stranger' }, // a DM with someone who is no longer a friend
                { conversationId: 'c1b', otherUserId: 'f1' },
                { conversationId: 'cG', otherUserId: undefined }, // group / unknown
                { conversationId: 'c3', otherUserId: 'f3' },
            ],
        );
        expect(t).toEqual([{ userId: 'f1', conversationId: 'c1' }, { userId: 'f3', conversationId: 'c3' }]);
    });
});

describe('delivery ledger', () => {
    const ID = 'p_' + 'a'.repeat(32);
    it('records per (emoji, friend) and expires', () => {
        const l = ledgerRecord({}, ID, 'f1', 1_000);
        expect(ledgerHas(l, ID, 'f1', 1_001)).toBe(true);
        expect(ledgerHas(l, ID, 'f2', 1_001)).toBe(false);
        expect(ledgerHas(l, ID, 'f1', 1_000 + STATUS_EMOJI_LEDGER_TTL_MS)).toBe(false);
        // Recording again prunes the expired row.
        expect(ledgerRecord(l, 'p_' + 'b'.repeat(32), 'f9', 1_000 + STATUS_EMOJI_LEDGER_TTL_MS)[ID]).toBeUndefined();
    });
    it('parses defensively', () => {
        expect(parseStatusEmojiLedger(null)).toEqual({});
        expect(parseStatusEmojiLedger('not json')).toEqual({});
        expect(parseStatusEmojiLedger('[1]')).toEqual({});
        expect(parseStatusEmojiLedger(JSON.stringify({ [ID]: { f1: 5, f2: 'x' }, bad: { f1: 1 } }))).toEqual({ [ID]: { f1: 5 } });
    });
});

// ── Sending ──────────────────────────────────────────────────────────────────

function shareHarness(opts: { bytes?: Uint8Array | null; results?: Record<string, ShareSendResult>; ledger?: StatusEmojiLedger; animated?: boolean } = {}) {
    let ledger: StatusEmojiLedger = opts.ledger ?? {};
    const sent: { to: string; content: StatusEmojiShareContent }[] = [];
    const read = vi.fn(async () => (opts.bytes === undefined ? null : opts.bytes));
    const sleeps: number[] = [];
    const deps: ShareDeps = {
        store: { read, meta: () => ({ s: 1, t: 1, m: 'image/webp', a: opts.animated ? 1 : 0, n: 'x' }) },
        load: () => ledger,
        save: l => { ledger = l; },
        async send(t, content) {
            sent.push({ to: t.userId, content });
            return opts.results?.[t.userId] ?? 'sent';
        },
        now: () => 5_000,
        sleep: async ms => { sleeps.push(ms); },
        newId: () => 'msg-1',
    };
    return { deps, sent, read, sleeps, ledger: () => ledger };
}

describe('shareStatusEmoji - friends get the bytes over the E2EE path, once', () => {
    const targets = [{ userId: 'f1', conversationId: 'c1' }, { userId: 'f2', conversationId: 'c2' }];

    it('sends a profile_update with the verified bytes to every target and records the ledger', async () => {
        const bytes = webp(1);
        const id = await personalEmojiIdFromBytes(bytes);
        const h = shareHarness({ bytes, animated: true });
        const out = await shareStatusEmoji(statusEmojiRef(id), 'me', targets, h.deps);
        expect(out).toEqual({ sent: ['f1', 'f2'], failed: [], retry: false });
        expect(h.sent.map(s => s.to)).toEqual(['f1', 'f2']);
        const c = h.sent[0].content;
        // Old clients drop a profile_update without a chat row; it names no avatar / banner.
        expect(c).toMatchObject({ type: 'profile_update', user_id: 'me', status_emoji: { id, mime: 'image/webp', animated: true } });
        expect(c).not.toHaveProperty('avatar_attachment_id');
        expect(c).not.toHaveProperty('banner_attachment_id');
        expect(Array.from(b64ToBytes(c.status_emoji.bytes_b64))).toEqual(Array.from(bytes));
        expect(ledgerHas(h.ledger(), id, 'f1', 5_000)).toBe(true);
        expect(ledgerHas(h.ledger(), id, 'f2', 5_000)).toBe(true);
    });

    it('paces the sends (messages/send is 5 per 3 s)', async () => {
        const bytes = png(2);
        const h = shareHarness({ bytes });
        await shareStatusEmoji(statusEmojiRef(await personalEmojiIdFromBytes(bytes)), 'me', targets, h.deps);
        expect(h.sleeps).toEqual([1_000]); // between the two, not before the first
    });

    it('dedupes: a second status change to the same emoji sends nothing and does not even read the bytes', async () => {
        const bytes = gif(3);
        const ref = statusEmojiRef(await personalEmojiIdFromBytes(bytes));
        const h = shareHarness({ bytes });
        await shareStatusEmoji(ref, 'me', targets, h.deps);
        h.sent.length = 0; h.read.mockClear();
        const again = await shareStatusEmoji(ref, 'me', targets, h.deps);
        expect(again).toEqual({ sent: [], failed: [], retry: false });
        expect(h.sent).toEqual([]);
        expect(h.read).not.toHaveBeenCalled();
    });

    it('a friend added later gets it; the ones who already have it do not get it again', async () => {
        const bytes = png(4);
        const ref = statusEmojiRef(await personalEmojiIdFromBytes(bytes));
        const h = shareHarness({ bytes });
        await shareStatusEmoji(ref, 'me', targets, h.deps);
        h.sent.length = 0;
        await shareStatusEmoji(ref, 'me', [...targets, { userId: 'f3', conversationId: 'c3' }], h.deps);
        expect(h.sent.map(s => s.to)).toEqual(['f3']);
    });

    it('a re-send after the ledger entry expired (cache evicted / new device)', async () => {
        const bytes = png(5);
        const id = await personalEmojiIdFromBytes(bytes);
        const h = shareHarness({ bytes, ledger: { [id]: { f1: 5_000 - STATUS_EMOJI_LEDGER_TTL_MS - 1, f2: 5_000 } } });
        await shareStatusEmoji(statusEmojiRef(id), 'me', targets, h.deps);
        expect(h.sent.map(s => s.to)).toEqual(['f1']);
    });

    it('never sends to myself or twice to one friend', async () => {
        const bytes = png(6);
        const h = shareHarness({ bytes });
        await shareStatusEmoji(statusEmojiRef(await personalEmojiIdFromBytes(bytes)), 'me', [
            { userId: 'me', conversationId: 'self' }, { userId: 'f1', conversationId: 'c1' }, { userId: 'f1', conversationId: 'c1b' },
        ], h.deps);
        expect(h.sent.map(s => s.to)).toEqual(['f1']);
    });

    it('unicode / empty statuses send nothing', async () => {
        const h = shareHarness({ bytes: png(7) });
        for (const e of ['🔥', '', null, undefined]) {
            expect(await shareStatusEmoji(e, 'me', targets, h.deps)).toEqual({ sent: [], failed: [], retry: false });
        }
        expect(h.sent).toEqual([]);
        expect(h.read).not.toHaveBeenCalled();
    });

    it('a failed send is not recorded (it retries), a rate limit stops the run', async () => {
        const bytes = png(8);
        const id = await personalEmojiIdFromBytes(bytes);
        const h = shareHarness({ bytes, results: { f1: 'failed', f2: 'throttled' } });
        const three = [...targets, { userId: 'f3', conversationId: 'c3' }];
        const out = await shareStatusEmoji(statusEmojiRef(id), 'me', three, h.deps);
        expect(out).toEqual({ sent: [], failed: ['f1', 'f2'], retry: true });
        expect(h.sent.map(s => s.to)).toEqual(['f1', 'f2']); // f3 was not attempted
        expect(h.ledger()).toEqual({});
    });

    it('a friend with no registered device is skipped quietly (not recorded, not retried)', async () => {
        const bytes = png(9);
        const h = shareHarness({ bytes, results: { f1: 'skipped' } });
        const out = await shareStatusEmoji(statusEmojiRef(await personalEmojiIdFromBytes(bytes)), 'me', targets, h.deps);
        expect(out).toEqual({ sent: ['f2'], failed: [], retry: false });
    });

    it('an emoji not (yet) on this device is not sent, and is retried later; a JPEG / SVG / oversize one never is', async () => {
        const ref = 'cl:p_' + 'e'.repeat(32);
        expect(await shareStatusEmoji(ref, 'me', targets, shareHarness({ bytes: null }).deps)).toEqual({ sent: [], failed: [], retry: true });
        for (const bad of [jpeg, svg, new Uint8Array(PERSONAL_EMOJI_MAX_BYTES + 1).fill(1)]) {
            const h = shareHarness({ bytes: bad });
            expect(await shareStatusEmoji(ref, 'me', targets, h.deps)).toEqual({ sent: [], failed: [], retry: false });
            expect(h.sent).toEqual([]);
        }
    });

    it('stops at once when cancelled (the status changed again)', async () => {
        const bytes = png(10);
        const h = shareHarness({ bytes });
        let n = 0;
        h.deps.cancelled = () => n++ >= 1;
        const out = await shareStatusEmoji(statusEmojiRef(await personalEmojiIdFromBytes(bytes)), 'me', targets, h.deps);
        expect(out.sent).toEqual(['f1']);
        expect(out.retry).toBe(true);
    });
});

// ── Receiving ────────────────────────────────────────────────────────────────

describe('takeStatusEmoji - verify, then file in the received cache', () => {
    const wire = async (bytes: Uint8Array, over: Record<string, unknown> = {}) => ({
        client_msg_id: 'm1', type: 'profile_update', user_id: 'f1',
        status_emoji: { id: await personalEmojiIdFromBytes(bytes), mime: 'image/webp', animated: false, bytes_b64: bytesToB64(bytes), ...over },
    });
    const ctx = (over: Partial<Parameters<typeof takeStatusEmoji>[1]> = {}) => {
        const put = vi.fn(async () => undefined);
        return { put, c: { senderUserId: 'f1', myUserId: 'me', isFriend: (id: string) => id === 'f1', store: { put }, ...over } };
    };

    it('files a friend\'s valid WebP / PNG / GIF and strips the bytes from the content', async () => {
        for (const bytes of [webp(1), png(2), gif(3)]) {
            const { put, c } = ctx();
            const r = takeStatusEmoji(await wire(bytes), c);
            expect(r.content).not.toHaveProperty('status_emoji');
            expect(r.content).toMatchObject({ type: 'profile_update', user_id: 'f1' });
            expect(await r.stored).toBe(await personalEmojiIdFromBytes(bytes));
            expect(put).toHaveBeenCalledTimes(1);
        }
    });

    it('derives the mime and animation from the bytes, not from what the sender claims', async () => {
        const { put, c } = ctx();
        await takeStatusEmoji(await wire(png(1), { mime: 'image/gif', animated: true }), c).stored;
        expect(put).toHaveBeenCalledWith(expect.any(String), expect.any(Uint8Array), expect.objectContaining({ mime: 'image/png', animated: false }));
    });

    it('rejects bytes that do not hash to the id (tamper)', async () => {
        const { put, c } = ctx();
        const w = await wire(png(1), { bytes_b64: bytesToB64(png(2)) });
        const r = takeStatusEmoji(w, c);
        expect(await r.stored).toBeNull();
        expect(put).not.toHaveBeenCalled();
        expect(r.content).not.toHaveProperty('status_emoji'); // still stripped
    });

    it('rejects SVG and JPEG even with a matching hash', async () => {
        for (const bad of [svg, jpeg]) {
            const { put, c } = ctx();
            expect(await takeStatusEmoji(await wire(bad), c).stored).toBeNull();
            expect(put).not.toHaveBeenCalled();
        }
    });

    it('rejects oversize', async () => {
        const big = new Uint8Array(PERSONAL_EMOJI_MAX_BYTES + 1).fill(7);
        big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const { put, c } = ctx();
        expect(await takeStatusEmoji(await wire(big), c).stored).toBeNull();
        expect(put).not.toHaveBeenCalled();
    });

    it('rejects garbage shapes without throwing', async () => {
        for (const status_emoji of [null, 5, 'x', [], { id: 'p_' + 'a'.repeat(32) }, { id: 1, bytes_b64: 2 }]) {
            const { put, c } = ctx();
            const r = takeStatusEmoji({ type: 'profile_update', user_id: 'f1', status_emoji }, c);
            expect(await r.stored).toBeNull();
            expect(put).not.toHaveBeenCalled();
        }
    });

    it('only from an accepted friend: a stranger, myself, or a missing sender is ignored', async () => {
        for (const over of [{ senderUserId: 'stranger' }, { senderUserId: 'me' }, { senderUserId: null }, { senderUserId: undefined }]) {
            const { put, c } = ctx(over as never);
            expect(await takeStatusEmoji(await wire(png(1), {}), c).stored).toBeNull();
            expect(put).not.toHaveBeenCalled();
        }
    });

    it('the user_id inside must be the envelope sender (no planting under someone else\'s name)', async () => {
        const { put, c } = ctx();
        const w = { ...(await wire(png(1))), user_id: 'someone-else' };
        expect(await takeStatusEmoji(w, c).stored).toBeNull();
        expect(put).not.toHaveBeenCalled();
    });

    it('only profile_update carries it; anything else is returned untouched', async () => {
        const { put, c } = ctx();
        const w = { ...(await wire(png(1))), type: 'text' };
        const r = takeStatusEmoji(w, c);
        expect(r.content).toBe(w);
        expect(await r.stored).toBeNull();
        expect(put).not.toHaveBeenCalled();
        const plain = { type: 'profile_update', user_id: 'f1', avatar_attachment_id: 'a' };
        expect(takeStatusEmoji(plain, c).content).toBe(plain);
    });

    it('a store failure is swallowed', async () => {
        const { c } = ctx({ store: { put: vi.fn(async () => { throw new Error('disk full'); }) } });
        expect(await takeStatusEmoji(await wire(png(1)), c).stored).toBeNull();
    });
});

describe('a complete round trip', () => {
    it('what shareStatusEmoji sends, takeStatusEmoji accepts', async () => {
        const bytes = webp(42);
        const id = await personalEmojiIdFromBytes(bytes);
        const h = shareHarness({ bytes });
        await shareStatusEmoji(statusEmojiRef(id), 'alice', [{ userId: 'bob', conversationId: 'c' }], h.deps);
        const put = vi.fn(async () => undefined);
        const wireJson = JSON.parse(JSON.stringify(h.sent[0].content));
        const r = takeStatusEmoji(wireJson, { senderUserId: 'alice', myUserId: 'bob', isFriend: u => u === 'alice', store: { put } });
        expect(await r.stored).toBe(id);
        expect(put).toHaveBeenCalledWith(id, expect.any(Uint8Array), expect.objectContaining({ mime: 'image/webp' }));
    });
});
