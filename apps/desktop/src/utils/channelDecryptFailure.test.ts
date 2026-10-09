import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as crypto from 'crypto';
import {
    classifyChannelDecryptFailure, channelPlaceholderContent, placeholderReason, placeholderWantsKey,
    placeholderRetryable, placeholderLabel, isChannelTombstone,
} from './channelDecryptFailure';
import { pageNeedsKeyRequest } from './channelHistoryRetention';
import { foldChannelHistory, editedContent, isUndecryptablePlaceholder, type ChannelRow } from './channelHistoryMerge';
import { isStaleEpochError, sendFailureReason } from './pendingSend';

/**
 * "A 'waiting on channel keys' row in the middle of messages everyone else can
 * read" (owner, 2026-10-09). Each failure kind is produced by the REAL engine
 * (electron/e2ee-engine.ts; only SecureStore stubbed) and classified, each with
 * a control — so the pill can only claim "waiting on this channel's key" when
 * a key is genuinely what is missing.
 */

const store = new Map<string, string>();
vi.mock('../../electron/storage', () => ({
    secureStore: {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => { store.set(k, v); },
        setDeferred: (k: string, v: string) => { store.set(k, v); },
        setMany: (entries: Record<string, string>) => { for (const [k, v] of Object.entries(entries)) store.set(k, v); },
        delete: (k: string) => { store.delete(k); },
        deleteDeferred: (k: string) => { store.delete(k); },
        batch: <T>(fn: () => T): T => fn(),
        keys: () => [...store.keys()],
    },
}));

type Engine = typeof import('../../electron/e2ee-engine');
type Keys = typeof import('../../electron/channel-keys');
let engine: Engine;
let keys: Keys;
let pub = '';
const CH = 'cccccccc-0000-4000-8000-0000000000aa';
const ROTATES = new Date(Date.now() + 7 * 864e5);
const SENDER = { user_id: 'aaaaaaaa-0000-4000-8000-000000000001', device_id: 'aaaaaaaa-0000-4000-8000-0000000000d1' };
const k1 = crypto.randomBytes(32).toString('base64');
const k2 = crypto.randomBytes(32).toString('base64');

beforeAll(async () => {
    vi.resetModules();
    store.clear();
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    store.set('identity_priv', Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url').toString('hex'));
    pub = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64');
    store.set('identity_pub', pub);
    keys = await import('../../electron/channel-keys');
    engine = await import('../../electron/e2ee-engine');
});

/** Encrypt as the sender under `epoch` with `key`, then decrypt as a reader holding `held`. */
function attempt(opts: { epoch: number; key: string; held: Record<number, string>; senderPub?: string; tamperSig?: boolean; id: string }): unknown {
    const ch = `${CH.slice(0, -2)}${opts.id.slice(-2)}`;
    keys.setChannelKey(ch, opts.epoch, opts.key, ROTATES);
    const enc = engine.encryptChannelMessage(JSON.stringify({ type: 'text', text: 'hi' }), ch, SENDER);
    keys.discardChannelKey(ch, opts.epoch);
    for (const [e, k] of Object.entries(opts.held)) keys.setChannelKey(ch, Number(e), k, ROTATES);
    let sig = enc.signature_b64;
    if (opts.tamperSig) { const b = Buffer.from(sig, 'base64'); b[0] ^= 0xff; sig = b.toString('base64'); }
    try {
        engine.decryptChannelMessage({
            channel_id: ch, epoch: enc.epoch, nonce_b64: enc.nonce_b64, ciphertext_b64: enc.ciphertext_b64, signature_b64: sig,
            sender_identity_pub_b64: opts.senderPub ?? pub, message_id: opts.id, sender_user_id: SENDER.user_id, sender_device_id: SENDER.device_id,
        });
        return null;
    } catch (e) { return e; }
}

describe('classifyChannelDecryptFailure — real engine errors', () => {
    it('control: a reader holding the epoch decrypts (no failure to classify)', () => {
        expect(attempt({ epoch: 2, key: k2, held: { 2: k2 }, id: 'x01' })).toBeNull();
    });

    it('a row under an epoch this reader does NOT hold (a stale sender\'s epoch 1) → key_missing (the only "waiting")', () => {
        const err = attempt({ epoch: 1, key: k1, held: { 2: k2 }, id: 'x02' });
        expect(classifyChannelDecryptFailure(err, { epoch: 1, latestKnownEpoch: 2, canReadHistory: true })).toBe('key_missing');
    });

    it('same row, reader WITHOUT Read Message History → history_restricted (the server withholds old epochs from them)', () => {
        const err = attempt({ epoch: 1, key: k1, held: { 2: k2 }, id: 'x03' });
        expect(classifyChannelDecryptFailure(err, { epoch: 1, latestKnownEpoch: 2, canReadHistory: false })).toBe('history_restricted');
        // control: the CURRENT epoch is never withheld, so it still waits
        expect(classifyChannelDecryptFailure(err, { epoch: 2, latestKnownEpoch: 2, canReadHistory: false })).toBe('key_missing');
    });

    it('a divergent key for the SAME epoch (GCM auth fails) → key_mismatch, not "waiting"', () => {
        const err = attempt({ epoch: 3, key: k1, held: { 3: k2 }, id: 'x04' });
        expect(classifyChannelDecryptFailure(err)).toBe('key_mismatch');
    });

    it('sender key gone (revoked device, empty identity key) → unverified', () => {
        const err = attempt({ epoch: 2, key: k2, held: { 2: k2 }, senderPub: '', id: 'x05' });
        expect(classifyChannelDecryptFailure(err)).toBe('unverified');
    });

    it('a bad signature → unverified', () => {
        const err = attempt({ epoch: 2, key: k2, held: { 2: k2 }, tamperSig: true, id: 'x06' });
        expect(classifyChannelDecryptFailure(err)).toBe('unverified');
    });

    it('the pinned-sender-key mismatch Dashboard throws → unverified', () => {
        expect(classifyChannelDecryptFailure(new Error('[E2EE] Channel message rejected: sender key mismatch for u1'))).toBe('unverified');
    });

    it('errors as they cross Electron IPC (wrapped text) classify the same', () => {
        expect(classifyChannelDecryptFailure(new Error("Error invoking remote method 'channel:decrypt-message': Error: Unsupported state or unable to authenticate data"))).toBe('key_mismatch');
    });
});

describe('placeholders — what they say and whether they ask for a key', () => {
    const ph = (reason?: string): ChannelRow => ({ id: `p-${reason}`, timestamp: '2026-10-09T00:00:00Z', content: reason ? channelPlaceholderContent(reason as never, 1) : { type: 'system', kind: 'encrypted', data: { reason: 'key_missing' } } });

    it('only key_missing says "waiting" and asks for a key; every reason stays a placeholder the heal path can upgrade', () => {
        for (const r of ['key_missing', 'key_mismatch', 'unverified', 'history_restricted'] as const) {
            const m = ph(r);
            expect(isUndecryptablePlaceholder(m)).toBe(true);
            expect(placeholderReason(m)).toBe(r);
            expect(placeholderWantsKey(m)).toBe(r === 'key_missing');
            expect(/waiting/i.test(placeholderLabel(r))).toBe(r === 'key_missing');
        }
        expect(placeholderRetryable(ph('history_restricted'))).toBe(false);
        expect(placeholderRetryable(ph('unverified'))).toBe(true);
    });

    it('a legacy placeholder (cached before reasons existed) keeps its old meaning', () => {
        const legacy: ChannelRow = { id: 'l', timestamp: '2026-10-09T00:00:00Z', content: { type: 'system', kind: 'encrypted' } };
        expect(placeholderReason(legacy)).toBe('key_missing');
    });

    it('pageNeedsKeyRequest: an unverifiable or withheld row never files a request (control: a missing key does)', () => {
        expect(pageNeedsKeyRequest([ph('unverified'), ph('history_restricted'), ph('key_mismatch')], new Set())).toBe(false);
        expect(pageNeedsKeyRequest([ph('unverified'), ph('key_missing')], new Set())).toBe(true);
    });
});

describe('edits whose original this reader cannot decrypt', () => {
    const at = (s: number) => new Date(Date.parse('2026-10-09T00:00:00Z') + s * 1000).toISOString();
    const placeholder: ChannelRow = { id: 'orig', timestamp: at(1), sender_user_id: 'u1', content: channelPlaceholderContent('key_missing', 1) };
    const edit: ChannelRow = { id: 'e1', timestamp: at(9), sender_user_id: 'u1', content: { type: 'edit', target_id: 'orig', text: 'latest text' } };

    it('the edit carries the whole new text → the row becomes that text, not a pill', () => {
        const out = foldChannelHistory([placeholder], [edit]);
        expect(out).toHaveLength(1);
        expect(out[0].content).toEqual({ type: 'text', text: 'latest text' });
        expect(out[0].edited).toBe(true);
        expect(isUndecryptablePlaceholder(out[0])).toBe(false);
    });

    it('control: the old merge ({...placeholder, text}) left it a "waiting" pill', () => {
        const old = { ...(placeholder.content as object), text: 'latest text' };
        expect(isUndecryptablePlaceholder({ content: old })).toBe(true);
    });

    it('a later real decrypt of the ORIGINAL does not roll the edit back', () => {
        const edited = foldChannelHistory([placeholder], [edit]);
        const out = foldChannelHistory(edited, [{ id: 'orig', timestamp: at(1), content: { type: 'text', text: 'original' } }]);
        expect(out[0].content.text).toBe('latest text');
    });

    it('control: an edit of a readable message keeps its other fields', () => {
        expect(editedContent({ type: 'text', text: 'a', mentions: [1] }, 'b')).toEqual({ type: 'text', text: 'b', mentions: [1] });
    });
});

describe('an ACTION row that was cached as a pill heals when it decrypts', () => {
    const at = (s: number) => new Date(Date.parse('2026-10-09T00:00:00Z') + s * 1000).toISOString();
    const target: ChannelRow = { id: 't', timestamp: at(1), content: { type: 'text', text: 'hello' } };
    // a reaction that arrived before its epoch key: cached as a placeholder under its own id
    const pill: ChannelRow = { id: 'r1', timestamp: at(5), content: channelPlaceholderContent('key_missing', 1) };
    const reaction: ChannelRow = { id: 'r1', timestamp: at(5), sender_user_id: 'u2', content: { type: 'reaction', target_id: 't', emoji: '👍', action: 'add' } };

    it.each([
        ['reaction', reaction],
        ['edit', { ...reaction, content: { type: 'edit', target_id: 't', text: 'edited' } }],
        ['delete', { ...reaction, content: { type: 'delete', target_id: 't' } }],
    ])('a %s: the pill goes, the action applies', (_n, decrypted) => {
        const out = foldChannelHistory([target, pill], [decrypted as ChannelRow]);
        expect(out.some(m => m.id === 'r1')).toBe(false);
        expect(out.some(isUndecryptablePlaceholder)).toBe(false);
    });

    it('control: a plain message pill is upgraded in place (unchanged behaviour)', () => {
        const out = foldChannelHistory([target, pill], [{ id: 'r1', timestamp: at(5), content: { type: 'text', text: 'now readable' } }]);
        expect(out.find(m => m.id === 'r1')?.content.text).toBe('now readable');
    });

    it('control: a pill whose row STILL cannot be decrypted stays (it is still waiting)', () => {
        const out = foldChannelHistory([target, pill], [pill]);
        expect(out.some(m => m.id === 'r1' && isUndecryptablePlaceholder(m))).toBe(true);
    });
});

describe('deleted messages and stale-epoch sends', () => {
    it('isChannelTombstone: the API flag, or cleared ciphertext from an API that predates the flag', () => {
        expect(isChannelTombstone({ deleted: true, nonce_b64: 'n', ciphertext_b64: 'c' })).toBe(true);
        expect(isChannelTombstone({ nonce_b64: '', ciphertext_b64: '' })).toBe(true);
        expect(isChannelTombstone({ deleted: false, nonce_b64: 'n', ciphertext_b64: 'c' })).toBe(false);
    });

    it('409 STALE_EPOCH is recognised and worded as a key wait (control: other 409s are not)', () => {
        const stale = { response: { status: 409, data: { code: 'STALE_EPOCH' } } };
        expect(isStaleEpochError(stale)).toBe(true);
        expect(sendFailureReason(stale)).toMatch(/key/);
        expect(isStaleEpochError({ response: { status: 409, data: { code: 'ALREADY_SAVED' } } })).toBe(false);
    });
});
