import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    contentProblem,
    sanitizeStoredThreads,
    storedSystemRowProblem,
    unshowablePlaceholderContent,
} from './contentValidation';
import { UNDECRYPTABLE_KIND, applyIncomingDmMessages } from './dmInbound';
import {
    contentTypeName,
    isControlContent,
    problemCode,
    recordUnshowable,
    unshowableDisposition,
} from './unshowableContent';
import { clear as clearDelivery, snapshot as deliverySnapshot } from './deliveryDiagnostics';
import { deliveryEntryToBeta } from './betaDiagnostics/bridges';

/**
 * "A message couldn't be shown" rows that were never messages (owner report,
 * 2026-10-26). Each case below reproduces one way a row that is not a lost
 * message ended up as that stand-in.
 */

const UUID = '11111111-2222-4333-8444-555555555555';
const UUID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

// ── Cause 1: the legacy server member line ─────────────────────────────────
//
// Desktop 2026-05-10 … 1.0.21 (Dashboard.tsx `channelSystemEvent` effect,
// removed by 88d11af5) injected "X joined the server." into the channel cache
// as a LOCAL row, persisted with every channel:
//
//     { id: 'sys_<ms>_<rand>', content: { type: 'system', text },
//       sender_device_id: '', sender_user_id: '' }
//
// 1.0.23's forged-system-row check (5f9d3fed) only knew the group line
// (sender '__system__'), so every one of these became "A message couldn't be
// shown" on load — and the replacement was written back to disk.

const legacyLine = (n: number, text = 'alice joined the server.') => ({
    id: `sys_${1_760_000_000_000 + n}_k3j9x`,
    content: { type: 'system', text },
    sender_device_id: '',
    sender_user_id: '',
    timestamp: '2026-08-01T10:00:00.000Z',
    conversation_id: UUID,
});

describe('legacy local member lines (≤1.0.21 channel cache)', () => {
    it('are not mistaken for a forged system row', () => {
        for (const text of ['alice joined the server.', 'bob left the server.', 'carol was kicked by dave.', 'eve was banned by a moderator.', 'x triggered an unknown event.']) {
            expect(storedSystemRowProblem(legacyLine(1, text))).toBeNull();
        }
    });

    it('survive a reload unchanged (the map keeps its identity)', () => {
        const map = { [UUID]: [legacyLine(1), legacyLine(2, 'bob left the server.')] as unknown[] };
        expect(sanitizeStoredThreads(map)).toBe(map);
    });

    it('a stand-in 1.0.23 already wrote over one is removed, not shown', () => {
        const converted = { ...legacyLine(3), content: unshowablePlaceholderContent() };
        const real = { id: UUID2, content: { type: 'text', text: 'hi' }, sender_user_id: UUID, sender_device_id: 'd', timestamp: 't', conversation_id: UUID };
        const out = sanitizeStoredThreads({ [UUID]: [legacyLine(1), converted, real] as unknown[] });
        expect(out[UUID].map(r => (r as { id: string }).id)).toEqual([legacyLine(1).id, UUID2]);
    });

    it('a real lost message keeps its stand-in (DM placeholder, channel key pill, forged-row replacement)', () => {
        const dmPlaceholder = {
            id: UUID, content: { type: 'system', kind: UNDECRYPTABLE_KIND, data: { reason: 'malformed' } },
            sender_user_id: null, sender_device_id: 'd', timestamp: 't', conversation_id: UUID,
        };
        const channelReplaced = {
            id: UUID2, content: unshowablePlaceholderContent(),
            sender_user_id: UUID, sender_device_id: 'd', timestamp: 't', conversation_id: UUID,
        };
        // A sys_-looking id from another client never has sender_user_id ''
        // (DMs store the sealed sender or null; channel rows the server's id).
        const lookalike = { ...channelReplaced, id: 'sys_1_x', sender_user_id: null, sender_device_id: '' };
        const map = { t: [dmPlaceholder, channelReplaced, lookalike] as unknown[] };
        expect(sanitizeStoredThreads(map)).toBe(map);
    });

    it('the exemption is narrow: a sender, a kind, or a non-local id is still refused', () => {
        expect(storedSystemRowProblem({ ...legacyLine(1), sender_user_id: UUID })).toEqual(expect.any(String));
        expect(storedSystemRowProblem({ ...legacyLine(1), sender_user_id: null })).toEqual(expect.any(String));
        expect(storedSystemRowProblem({ ...legacyLine(1), id: 'x1' })).toEqual(expect.any(String));
        expect(storedSystemRowProblem({ ...legacyLine(1), sender_device_id: 'dev' })).toEqual(expect.any(String));
        expect(storedSystemRowProblem({ ...legacyLine(1), content: { type: 'system', text: 42 } })).toEqual(expect.any(String));
        expect(storedSystemRowProblem({ ...legacyLine(1), content: { type: 'system', kind: 'announcement', text: 'x' } })).toEqual(expect.any(String));
    });

    it('still refused on the wire', () => {
        expect(contentProblem(legacyLine(1).content)).toEqual(expect.any(String));
    });
});

// ── Cause 2: control messages turned into rows ─────────────────────────────

describe('a control message that cannot be applied never becomes a row', () => {
    it.each([
        ['edit', { type: 'edit', target_id: 42, text: 'x' }],
        ['delete', { type: 'delete' }],
        ['reaction', { type: 'reaction', target_id: UUID, emoji: '__proto__', action: 'add' }],
        ['pin', { type: 'pin', conversation_id: UUID, target_id: UUID2, action: 'add' }],
        ['profile_update', { type: 'profile_update', user_id: 7 }],
        ['group_update', { type: 'group_update' }],
        ['call_key_request', { type: 'call_key_request' }],
        ['channel_key', { type: 'channel_key', channel_id: UUID }],
        ['call_key share', { type: 'call_key', key_id: 'share', call_id: UUID }],
        ['call_key rotation', { type: 'call_key', key_id: 'rotate-3', call_id: UUID }],
        ['call_key mint', { type: 'call_key', key_id: 'mint', call_id: UUID }],
    ])('%s → drop', (_n, content) => {
        // Each of these really is refused at the boundary…
        expect(contentProblem(content)).toEqual(expect.any(String));
        // …and is dropped rather than stored as a stand-in.
        expect(isControlContent(content)).toBe(true);
        expect(unshowableDisposition(content)).toBe('drop');
    });

    it.each([
        ['text', { type: 'text', text: 7 }],
        ['attachment', { type: 'attachment' }],
        ['safety_number', { type: 'safety_number', code: 1 }],
        ['klipy_gif', { type: 'klipy_gif' }],
        ['server_invite', { type: 'server_invite' }],
        ['the call start', { type: 'call_key', key_id: 'initial' }],
        ['call_event', { type: 'call_event' }],
        ['a type from a newer client', { type: 'poll', question: 'x' }],
        ['a system row from the wire', { type: 'system', text: 'x' }],
        ['no type', { text: 'x' }],
        ['not an object', 'hello'],
    ])('%s → placeholder (it may be a message the user was meant to see)', (_n, content) => {
        expect(unshowableDisposition(content)).toBe('placeholder');
    });

    it('the DM merge already treats every dropped type as "not a row" when valid', () => {
        // Pins the two lists together: anything unshowableDisposition drops is
        // something applyIncomingDmMessages never appends when well formed.
        const row = (content: Record<string, unknown>) => ({ id: 'r', content, sender_user_id: UUID, sender_device_id: 'd', timestamp: 't', conversation_id: 'c' });
        for (const content of [
            { type: 'edit', target_id: 'nope', text: 'x' },
            { type: 'delete', target_id: 'nope' },
            { type: 'reaction', target_id: 'nope', emoji: '👍', action: 'add' },
            { type: 'pin', conversation_id: 'c', target_id: 'nope', action: 'add', at: 1 },
            { type: 'profile_update', user_id: UUID },
            { type: 'group_update', conversation_id: 'c' },
            { type: 'call_key_request', call_id: UUID },
            { type: 'call_key', key_id: 'share', call_id: UUID, epoch: 2, e2ee_key_b64: 'AAAA', rotates_at: 'x' },
        ]) {
            expect(isControlContent(content)).toBe(true);
            const out = applyIncomingDmMessages({ c: [] }, { c: [row(content) as never] });
            expect(out.c, content.type).toEqual([]);
        }
    });
});

// ── Diagnostics: counted, never content ────────────────────────────────────

describe('unshowable messages are counted without content', () => {
    beforeEach(() => clearDelivery());

    it('type names are enums, never free text', () => {
        expect(contentTypeName({ type: 'edit' })).toBe('edit');
        expect(contentTypeName({ type: 'Hello there, alice' })).toBe('invalid');
        expect(contentTypeName({ type: 42 })).toBe('invalid');
        expect(contentTypeName({})).toBe('none');
        expect(contentTypeName('x')).toBe('none');
        expect(problemCode('edit.target_id must be a string id')).toBe('edit.target_id');
        expect(problemCode('content.type "secret words" is not accepted')).toBe('unknown_type');
        expect(problemCode(null)).toBeUndefined();
    });

    it('a recorded drop reaches beta diagnostics as reason + type only', () => {
        recordUnshowable({
            scope: 'dm', reason: 'malformed', outcome: 'dropped',
            content: { type: 'edit', target_id: 42, text: 'my secret words' },
            problem: 'edit.target_id must be a string id',
            ids: { envelope_id: UUID, conversation_id: UUID2 },
        });
        const [entry] = deliverySnapshot();
        expect(entry.kind).toBe('message_process');
        expect(entry.code).toBe('UNSHOWABLE');
        // Local entry keeps its ids (Settings → Advanced → Delivery diagnostics)…
        expect(entry.ctx.envelope_id).toBe(UUID);
        expect(entry.message).not.toContain('secret');
        // …the beta event carries none of them.
        const beta = deliveryEntryToBeta(entry);
        expect(beta).toEqual({
            kind: 'msg_fetch_gap',
            detail: { stage: 'unshowable', reason: 'malformed', ctype: 'edit', scope: 'dm', outcome: 'dropped', field: 'edit.target_id' },
        });
        expect(JSON.stringify(beta)).not.toContain(UUID);
        expect(JSON.stringify(beta)).not.toContain(UUID2);
    });

    it('an ordinary processing failure still maps to stage "process"', () => {
        expect(deliveryEntryToBeta({ kind: 'message_process', code: 'UNKNOWN', ctx: { envelope_id: UUID } }))
            .toEqual({ kind: 'msg_fetch_gap', detail: { stage: 'process', code: 'UNKNOWN' } });
    });
});

// ── Wiring: every receive path asks before it stores a stand-in ────────────

describe('Dashboard receive paths route unshowable content through unshowableDisposition', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'Dashboard.tsx'), 'utf8');

    it('no path builds the malformed stand-in inline any more', () => {
        expect(src).not.toMatch(/kind: UNDECRYPTABLE_KIND, data: \{ reason: 'malformed' \}/);
    });

    it('the DM pull, the live channel path and channel history each consult it', () => {
        // DM helper + live channel + channel history
        expect((src.match(/unshowableDisposition\(/g) ?? []).length).toBe(3);
        expect(src).toMatch(/recordUnshowable\(\{\s*scope: 'dm'/);
        expect(src).toMatch(/recordUnshowable\(\{\s*scope: 'channel',/);
        expect(src).toMatch(/recordUnshowable\(\{\s*scope: 'channel_history'/);
    });

    it('every DM stand-in for decrypted content goes through the helper; a drop is ACKed with nothing stored', () => {
        const dmBlock = src.slice(src.indexOf('const keepPlaceholder = '), src.indexOf('const commit = await commitPulledBatch'));
        expect(dmBlock).toMatch(/if \(disposition === 'drop'\) ackOnly\.push\(env\.envelope_id\);\s*else keepPlaceholder\(env, reason\);/);
        for (const reason of ['malformed', 'unverified_own_device', 'unprocessable']) {
            expect(dmBlock, reason).toMatch(new RegExp(`settleUnshowable\\(env, '${reason}', `));
            expect(dmBlock, reason).not.toMatch(new RegExp(`keepPlaceholder\\(env, '${reason}'\\)`));
        }
        // The only other keepPlaceholder is the decrypt-failure one (a message
        // whose type nobody can know).
        expect((dmBlock.match(/keepPlaceholder\(env, /g) ?? []).length).toBe(2);
    });

    it('the live channel path returns before a dropped control message reaches the thread', () => {
        const live = src.slice(src.indexOf("scope: 'channel', reason: 'malformed'"), src.indexOf('const moderatorDeleteTargets'));
        expect(live).toMatch(/if \(disposition === 'drop'\) return;/);
        const hist = src.slice(src.indexOf("scope: 'channel_history'"), src.indexOf("scope: 'channel_history'") + 400);
        expect(hist).toMatch(/if \(disposition === 'drop'\) return null;/);
    });
});
