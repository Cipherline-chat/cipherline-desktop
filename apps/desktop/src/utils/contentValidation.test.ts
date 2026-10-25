/**
 * The content boundary: every variant another client sends is accepted
 * exactly as it is sent today (fixtures below are copied from the real
 * senders on desktop and mobile), and no shape a sender can choose makes the
 * validator, or a renderer behind it, throw.
 */
import { describe, it, expect } from 'vitest';
import {
    contentProblem,
    storedContentProblem,
    sanitizeStoredThreads,
    storedSystemRowProblem,
    unshowablePlaceholderContent,
    ACCEPTED_CONTENT_TYPES,
    MAX_RECEIVED_TEXT_LENGTH,
} from './contentValidation';
import { UNDECRYPTABLE_KIND } from './dmInbound';
import { mentionsToPlainText, extractMentionsFromText } from './mentionTokens';
import { isEmojiOnly, countEmojis } from './emojiText';
import { displayPreviewOf } from './messagePreviewText';
import { memberEventFromLive } from './systemMessages';

const UUID = '3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c';
const UUID2 = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const KEY = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=';
const NONCE = 'AAECAwQFBgcICQoL';

/** Real payloads, field for field, from the senders cited. */
const FIXTURES: Record<string, Record<string, unknown>> = {
    // desktop ChatPane channel send (mentions + channel_refs + reply)
    'text (desktop channel)': {
        client_msg_id: UUID, type: 'text', text: `hi <@u:${UUID2}:dawson> see #memes`,
        reply_to_id: UUID2, mentions: [{ type: 'user', id: UUID2 }, { type: 'everyone' }],
        channel_refs: [{ id: UUID2, name: 'memes' }],
    },
    // desktop quick reply (utils/quickReply.ts)
    'text (desktop quick reply)': { client_msg_id: UUID, type: 'text', text: 'ok' },
    // mobile pipeline/send.ts
    'text (mobile dm)': { type: 'text', text: 'hey', client_msg_id: UUID, reply_to_id: UUID2, mentions: [{ type: 'role', id: UUID2 }] },
    'text (empty)': { client_msg_id: UUID, type: 'text', text: '' },
    'text (at receive cap)': { client_msg_id: UUID, type: 'text', text: 'x'.repeat(MAX_RECEIVED_TEXT_LENGTH) },
    'server_invite': { client_msg_id: UUID, type: 'server_invite', code: 'aB3dE5fG' },
    // desktop ChatPane attachment send
    'attachment (desktop)': {
        client_msg_id: UUID, type: 'attachment', attachment_id: UUID2, filename: 'report.pdf', byte_size: 1048576,
        mime: 'application/pdf', file_key_b64: KEY, file_nonce_b64: NONCE, enc_alg: 'aes256gcm', chunk_size: 0,
    },
    // mobile features/attachments/upload.ts (staging id, octet-stream)
    'attachment (mobile)': {
        client_msg_id: 'local-1729440000000-abc', type: 'attachment', attachment_id: UUID2, filename: 'IMG_0001.HEIC',
        byte_size: 2_500_000, mime: 'image/heic', file_key_b64: KEY, file_nonce_b64: NONCE, enc_alg: 'aes256gcm', chunk_size: 0,
    },
    'attachment (empty filename, zero bytes)': {
        client_msg_id: UUID, type: 'attachment', attachment_id: UUID2, filename: '', byte_size: 0,
        mime: 'application/octet-stream', file_key_b64: KEY, file_nonce_b64: NONCE, enc_alg: 'aes256gcm', chunk_size: 0,
    },
    'klipy_gif': {
        client_msg_id: UUID, type: 'klipy_gif', slug: 'happy-dance-123',
        media: { url: 'https://static.klipy.com/ii/abc123/de/f0/Ab12Cd34.webp', width: 498, height: 480, mime: 'image/webp' },
        title: 'Happy dance',
    },
    'safety_number': { client_msg_id: UUID, type: 'safety_number', user_id: UUID2, code: 'ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGH', device_count: 2 },
    'edit (desktop channel)': { client_msg_id: UUID, type: 'edit', target_id: UUID2, text: 'fixed', channel_refs: [{ id: UUID2, name: 'memes' }] },
    'edit (mobile)': { type: 'edit', target_id: UUID2, text: 'fixed', client_msg_id: UUID },
    'delete': { client_msg_id: UUID, type: 'delete', target_id: UUID2 },
    'reaction (unicode)': { client_msg_id: UUID, type: 'reaction', target_id: UUID2, emoji: '👍🏽', action: 'add' },
    'reaction (custom token)': { client_msg_id: UUID, type: 'reaction', target_id: UUID2, emoji: `<:party:${UUID2}>`, action: 'remove' },
    'pin': { client_msg_id: UUID, type: 'pin', conversation_id: UUID2, target_id: UUID, action: 'add', at: 1729440000000 },
    // desktop Dashboard call start (`global-<ts>` id)
    'call_key (desktop start)': {
        client_msg_id: 'global-1729440000000', type: 'call_key', call_id: UUID2, epoch: 1, e2ee_key_b64: KEY,
        key_id: 'initial', rotates_at: '2026-10-20T14:10:00.000Z',
    },
    // desktop ChatPane call start: no client_msg_id at all
    'call_key (no client_msg_id)': { type: 'call_key', call_id: UUID2, epoch: 1, e2ee_key_b64: KEY, key_id: 'initial', rotates_at: '2026-10-20T14:10:00.000Z' },
    'call_key (rotation)': { client_msg_id: UUID, type: 'call_key', call_id: UUID2, epoch: 4, e2ee_key_b64: KEY, key_id: 'rotate-3', rotates_at: '2026-10-20T14:40:00.000Z' },
    // desktop hooks/useCallKeySharing.ts: a joiner without the call key asks for it
    'call_key_request': { client_msg_id: UUID, type: 'call_key_request', call_id: UUID2 },
    'call_key_request (no client_msg_id)': { type: 'call_key_request', call_id: UUID2 },
    // the answer to it
    'call_key (share)': { client_msg_id: UUID, type: 'call_key', call_id: UUID2, epoch: 4, e2ee_key_b64: KEY, key_id: 'share', rotates_at: '2026-10-20T14:40:00.000Z' },
    'call_event (mobile-known)': { type: 'call_event', call_id: UUID2, event: 'ended' },
    // desktop utils/channelKeyDistribution.ts
    'channel_key (desktop)': {
        client_msg_id: `ck-${UUID2}-3-${UUID}`, type: 'channel_key', channel_id: UUID2, epoch: 3, key_b64: KEY,
        rotates_at: '2026-10-27T14:00:00.000Z', rotation_reason: 'member_removed',
    },
    // mobile core/crypto/channel-sender-key.ts (no client_msg_id)
    'channel_key (mobile)': { type: 'channel_key', channel_id: UUID2, epoch: 1, key_b64: KEY, rotates_at: '2026-10-27T14:00:00.000Z', rotation_reason: 'initial' },
    'profile_update': {
        type: 'profile_update', user_id: UUID2, avatar_attachment_id: UUID, avatar_file_key_b64: KEY, avatar_file_nonce_b64: NONCE,
        banner_attachment_id: UUID, banner_file_key_b64: KEY, banner_file_nonce_b64: NONCE,
    },
    'group_update': { type: 'group_update', conversation_id: UUID2, title: 'Weekend plans', avatar_attachment_id: UUID, avatar_file_key_b64: KEY, avatar_file_nonce_b64: NONCE },
    'group_update (title only)': { type: 'group_update', conversation_id: UUID2, title: 'x' },
    'text (extra unknown field from a newer client)': { client_msg_id: UUID, type: 'text', text: 'hi', some_future_field: { a: 1 } },
};

describe('every legitimate variant is accepted unchanged', () => {
    it.each(Object.entries(FIXTURES))('%s', (_name, content) => {
        expect(contentProblem(content)).toBeNull();
        expect(storedContentProblem(content)).toBeNull();
    });

    it('covers every accepted type', () => {
        const covered = new Set(Object.values(FIXTURES).map(f => f.type));
        expect([...ACCEPTED_CONTENT_TYPES].sort()).toEqual([...covered].sort());
    });
});

describe('refused shapes', () => {
    const cases: Array<[string, unknown]> = [
        ['numeric text', { type: 'text', text: 42 }],
        ['object text', { type: 'text', text: { toString: 1 } }],
        ['text over the cap', { type: 'text', text: 'x'.repeat(MAX_RECEIVED_TEXT_LENGTH + 1) }],
        ['mentions not an array', { type: 'text', text: 'a', mentions: 'everyone' }],
        ['mentions entry without id', { type: 'text', text: 'a', mentions: [{ type: 'user' }] }],
        ['huge mentions', { type: 'text', text: 'a', mentions: Array.from({ length: 1001 }, () => ({ type: 'here' })) }],
        ['channel_refs object', { type: 'text', text: 'a', channel_refs: { id: 'x' } }],
        ['attachment without filename', { type: 'attachment', attachment_id: UUID, byte_size: 1, mime: 'a/b', file_key_b64: KEY, file_nonce_b64: NONCE }],
        ['attachment numeric mime', { ...FIXTURES['attachment (desktop)'], mime: 7 }],
        ['attachment negative size', { ...FIXTURES['attachment (desktop)'], byte_size: -1 }],
        ['attachment NaN size', { ...FIXTURES['attachment (desktop)'], byte_size: Number.NaN }],
        ['attachment string size', { ...FIXTURES['attachment (desktop)'], byte_size: '10' }],
        ['attachment huge filename', { ...FIXTURES['attachment (desktop)'], filename: 'a'.repeat(5000) }],
        ['reaction bad action', { type: 'reaction', target_id: UUID, emoji: '👍', action: 'toggle' }],
        ['reaction huge emoji', { type: 'reaction', target_id: UUID, emoji: 'x'.repeat(300), action: 'add' }],
        ['pin without at', { type: 'pin', conversation_id: UUID, target_id: UUID, action: 'add' }],
        ['call_key_request without call_id', { type: 'call_key_request' }],
        ['call_key_request numeric call_id', { type: 'call_key_request', call_id: 7 }],
        ['call_key_request object call_id', { type: 'call_key_request', call_id: { id: UUID } }],
        ['call_key_request empty call_id', { type: 'call_key_request', call_id: '' }],
        ['call_key_request huge call_id', { type: 'call_key_request', call_id: 'a'.repeat(300) }],
        ['call_key_request bad client_msg_id', { type: 'call_key_request', call_id: UUID, client_msg_id: 5 }],
        ['call_key numeric key', { type: 'call_key', call_id: UUID, epoch: 1, e2ee_key_b64: 5 }],
        ['edit without target', { type: 'edit', text: 'x' }],
        ['delete object target', { type: 'delete', target_id: { id: 1 } }],
        ['client_msg_id number', { type: 'text', text: 'a', client_msg_id: 5 }],
        ['reply_to_id object', { type: 'text', text: 'a', reply_to_id: {} }],
        ['unknown type', { type: 'poll', question: 'x' }],
        ['channel_message as content', { type: 'channel_message', channel_id: UUID }],
        ['type number', { type: 3 }],
        ['type empty', { type: '' }],
        ['__proto__ type', JSON.parse('{"type":"__proto__"}')],
        ['constructor type', { type: 'constructor' }],
        ['array', ['text']],
        ['string', 'text'],
        ['null', null],
    ];
    it.each(cases)('%s', (_name, content) => {
        expect(contentProblem(content)).toEqual(expect.any(String));
    });
});

// ── fuzz: wrong types / missing fields on every variant never throw ─────────

const WRONG_VALUES: unknown[] = [
    undefined, null, 0, -1, 1.5, Number.NaN, Infinity, true, '', 'x', 'x'.repeat(70_000), {}, [], [1, 2], { a: { b: 1 } },
    JSON.parse('{"__proto__":{"polluted":1}}'),
];

/** Exercise what a renderer does with an accepted payload's fields. */
function renderLikeUse(c: Record<string, unknown>): void {
    switch (c.type) {
        case 'text':
            mentionsToPlainText(c.text as string, () => undefined);
            isEmojiOnly((c.text as string).trim());
            countEmojis(c.text as string);
            displayPreviewOf(c);
            extractMentionsFromText(c.text as string);
            break;
        case 'attachment':
            (c.filename as string).split('.').pop()?.toLowerCase();
            (c.mime as string).startsWith('image/');
            (c.byte_size as number).toFixed(1);
            break;
        case 'reaction':
            (c.emoji as string).slice(0);
            break;
        case 'safety_number':
            (c.code as string).toUpperCase();
            break;
        case 'call_key':
            (c.call_id as string).slice(0);
            (c.e2ee_key_b64 as string).slice(0);
            break;
        default:
            break;
    }
}

describe('fuzz: every field of every variant set to every wrong value', () => {
    it('validator never throws, and whatever it accepts is safe to render', () => {
        let accepted = 0;
        let refused = 0;
        for (const fixture of Object.values(FIXTURES)) {
            const keys = [...Object.keys(fixture), 'mentions', 'channel_refs', 'reply_to_id', 'client_msg_id'];
            for (const key of keys) {
                for (const v of WRONG_VALUES) {
                    const c: Record<string, unknown> = { ...fixture };
                    if (v === undefined) delete c[key];
                    else c[key] = v;
                    let problem: string | null = null;
                    expect(() => { problem = contentProblem(c); }).not.toThrow();
                    expect(() => storedContentProblem(c)).not.toThrow();
                    if (problem === null) {
                        accepted++;
                        expect(() => renderLikeUse(c)).not.toThrow();
                    } else {
                        refused++;
                    }
                }
            }
        }
        // Both sides are exercised: optional fields accept absence, required ones refuse.
        expect(accepted).toBeGreaterThan(100);
        expect(refused).toBeGreaterThan(500);
    });
});

// ── stored rows ─────────────────────────────────────────────────────────────

describe('sanitizeStoredThreads (history loaded from disk)', () => {
    const good = { id: 'a', timestamp: '2026-10-20T00:00:00Z', sender_user_id: UUID, content: { type: 'text', text: 'hi' } };
    const bad = { id: 'b', timestamp: '2026-10-20T00:00:01Z', sender_user_id: UUID, sender_device_id: 'd', content: { type: 'text', text: 42 } };
    const badAttachment = { id: 'c', timestamp: 't', content: { type: 'attachment', attachment_id: UUID } };
    const legacyControl = { id: 'd', timestamp: 't', content: { type: 'delete' } };
    const localSystem = { id: 'e', timestamp: 't', sender_user_id: null, content: { type: 'system', kind: 'encrypted', data: { reason: 'key_missing' } } };
    const unknownType = { id: 'f', timestamp: 't', content: { type: 'call_end' } };

    it('returns the same map and arrays when nothing needs fixing', () => {
        const thread = [good, legacyControl, localSystem, unknownType];
        const map = { c1: thread };
        const out = sanitizeStoredThreads(map);
        expect(out).toBe(map);
        expect(out.c1).toBe(thread);
    });

    it('replaces only the rows a renderer would throw on, keeping their id, time and sender', () => {
        const clean = [good];
        const map = { c1: [good, bad, badAttachment, null, 'junk'] as unknown[], c2: clean };
        const out = sanitizeStoredThreads(map);
        expect(out).not.toBe(map);
        expect(out.c2).toBe(clean);
        expect(out.c1).toEqual([
            good,
            { ...bad, content: unshowablePlaceholderContent() },
            { ...badAttachment, content: unshowablePlaceholderContent() },
        ]);
    });

    it('the placeholder is the one the thread renders as "couldn\'t be shown"', () => {
        expect(unshowablePlaceholderContent()).toEqual({ type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } });
    });
});

// ── `system` rows are local-only ─────────────────────────────────────────────

describe('system rows cannot come from another client', () => {
    it.each([
        ['member event pill', { type: 'system', kind: 'member_event', event: 'member_ban', subject_user_id: UUID, actor_user_id: UUID2 }],
        ['text pill', { type: 'system', text: 'alice was banned by the server owner' }],
        ['placeholder look-alike', { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } }],
        ['channel placeholder look-alike', { type: 'system', kind: 'encrypted', data: { reason: 'key_missing' } }],
    ])('%s is refused on the wire', (_n, content) => {
        expect(contentProblem(content)).toEqual(expect.any(String));
    });

    it('the rows this client builds itself survive a reload unchanged', () => {
        const memberEvent = memberEventFromLive({
            kind: 'system', channel_id: UUID, message_id: UUID2, created_at: '2026-10-20T10:00:00.000Z',
            system_event: 'member_ban', system_subject_user_id: UUID, system_actor_user_id: UUID2,
        });
        expect(memberEvent).not.toBeNull();
        const groupLine = {
            id: 'system-1-abc', content: { type: 'system', text: 'alice added bob' },
            sender_device_id: '__system__', sender_user_id: '__system__', timestamp: 't', conversation_id: UUID,
        };
        const dmPlaceholder = {
            id: UUID, content: { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } },
            sender_user_id: null, sender_device_id: 'd', timestamp: 't', conversation_id: UUID,
        };
        const channelPlaceholder = {
            id: UUID2, content: { type: 'system', kind: 'encrypted', data: { reason: 'key_missing', epoch: 3 } },
            sender_user_id: UUID, sender_device_id: 'd', timestamp: 't', conversation_id: UUID,
        };
        const thread = [memberEvent, groupLine, dmPlaceholder, channelPlaceholder] as unknown[];
        const map = { t: thread };
        expect(sanitizeStoredThreads(map)).toBe(map);
        for (const r of thread) expect(storedSystemRowProblem(r as Record<string, unknown>)).toBeNull();
    });

    it('a forged system row stored by an older build is replaced on load', () => {
        const forgedEvent = {
            id: 'x1', sender_user_id: UUID, sender_device_id: 'dev', timestamp: 't', conversation_id: UUID,
            content: { type: 'system', kind: 'member_event', event: 'member_ban', subject_user_id: UUID2, actor_user_id: UUID },
        };
        const forgedText = {
            id: 'x2', sender_user_id: UUID, sender_device_id: 'dev', timestamp: 't', conversation_id: UUID,
            content: { type: 'system', text: 'Your account was suspended' },
        };
        const forgedKind = {
            id: 'x3', sender_user_id: UUID, sender_device_id: 'dev', timestamp: 't', conversation_id: UUID,
            content: { type: 'system', kind: 'announcement', text: 'x' },
        };
        const out = sanitizeStoredThreads({ t: [forgedEvent, forgedText, forgedKind] as unknown[] });
        expect(out.t.map(r => (r as { content: unknown }).content)).toEqual([
            unshowablePlaceholderContent(), unshowablePlaceholderContent(), unshowablePlaceholderContent(),
        ]);
        expect(out.t.map(r => (r as { id: string }).id)).toEqual(['x1', 'x2', 'x3']);
    });
});

// ── reaction keys ────────────────────────────────────────────────────────────

describe('reaction emoji cannot be an Object.prototype name', () => {
    const r = (emoji: string) => ({ type: 'reaction', target_id: UUID, emoji, action: 'add' });

    it.each(['__proto__', 'constructor', 'hasOwnProperty', 'toString', 'valueOf', 'isPrototypeOf', '__defineGetter__', 'prototype'])('%s is refused', key => {
        expect(contentProblem(r(key))).toEqual(expect.any(String));
        // JSON.parse makes `__proto__` an OWN key — the wire shape.
        expect(contentProblem(JSON.parse(JSON.stringify(r(key))))).toEqual(expect.any(String));
    });

    it.each(['👍', '❤️', '🇺🇸', '1️⃣', '👩\u200D👩\u200D👧', `<:party:${UUID2}>`, '<:constructor:e1>'])('%s is accepted', emoji => {
        expect(contentProblem(r(emoji))).toBeNull();
    });

    it('a stored row whose reactions map carries a reserved key keeps its real reactions only', () => {
        const reactions = JSON.parse(`{"__proto__":["u1"],"constructor":["u2"],"👍":["u3"]}`);
        const row = { id: 'm', timestamp: 't', content: { type: 'text', text: 'hi' }, reactions };
        const out = sanitizeStoredThreads({ t: [row] as unknown[] });
        const fixed = (out.t[0] as { reactions: Record<string, unknown> }).reactions;
        expect(Object.keys(fixed)).toEqual(['👍']);
        expect(Object.getPrototypeOf(fixed)).toBe(Object.prototype);
        // and the thread with nothing to fix keeps its identity
        const clean = { t: [{ ...row, reactions: { '👍': ['u3'] } }] as unknown[] };
        expect(sanitizeStoredThreads(clean)).toBe(clean);
    });
});
