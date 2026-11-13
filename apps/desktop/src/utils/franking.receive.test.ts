import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyIncomingDmMessages } from './dmInbound';
import { applyChannelEditDelete } from './channelHistoryMerge';
import type { StoredFranking } from './franking';

const f = (tag: string) => ({ v: 1, t_b64: tag, sender_user_id: 'u-1' }) as unknown as StoredFranking;

describe('DM edits move the franking with the text', () => {
    const original = { id: 'm1', sender_user_id: 'u-1', sender_device_id: 'd-1', content: { type: 'text', text: 'old' }, franking: f('orig'), timestamp: '2026-01-01T00:00:00Z' };
    const edit = (franking?: StoredFranking) => ({
        id: 'e1', sender_user_id: 'u-1', sender_device_id: 'd-1', timestamp: '2026-01-01T00:01:00Z',
        content: { type: 'edit', target_id: 'm1', text: 'new' }, ...(franking ? { franking } : {}),
    });

    it('an edit that carries its own franking REPLACES the original\'s', () => {
        const out = applyIncomingDmMessages({ c: [original] }, { c: [edit(f('edit'))] });
        expect(out.c[0].content.text).toBe('new');
        expect(out.c[0].edited).toBe(true);
        expect(out.c[0].franking).toEqual(f('edit'));
    });

    it('an edit from a client that does not frank DROPS the original\'s (stale proof must not vouch for new text)', () => {
        const out = applyIncomingDmMessages({ c: [original] }, { c: [edit()] });
        expect(out.c[0].content.text).toBe('new');
        expect('franking' in out.c[0]).toBe(false);
    });

    it('an unrelated message is untouched', () => {
        const other = { ...original, id: 'm2' };
        const out = applyIncomingDmMessages({ c: [original, other] }, { c: [edit(f('edit'))] });
        expect(out.c.find((m: { id: string }) => m.id === 'm2').franking).toEqual(f('orig'));
    });
});

describe('channel edits move the franking with the text', () => {
    const row = { id: 'r1', sender_user_id: 'u-1', sender_device_id: 'd-1', timestamp: '2026-01-01T00:00:00Z', content: { type: 'text', text: 'old', client_msg_id: 'c1' }, franking: f('orig') };
    const action = (franking?: StoredFranking) => ({
        id: 'r2', sender_user_id: 'u-1', sender_device_id: 'd-1', timestamp: '2026-01-01T00:01:00Z',
        content: { type: 'edit', target_id: 'r1', text: 'new' }, ...(franking ? { franking } : {}),
    });

    it('replaces with the edit\'s own', () => {
        const out = applyChannelEditDelete([row], action(f('edit')));
        expect(out[0].franking).toEqual(f('edit'));
        expect(out[0].content.text).toBe('new');
    });

    it('drops when the edit is not franked', () => {
        const out = applyChannelEditDelete([row], action());
        expect('franking' in out[0]).toBe(false);
        expect(out[0].content.text).toBe('new');
    });

    it('a rejected edit (another author) changes nothing, franking included', () => {
        const forged = { ...action(f('edit')), sender_user_id: 'u-2', sender_device_id: 'd-2' };
        const out = applyChannelEditDelete([row], forged);
        expect(out[0].franking).toEqual(f('orig'));
        expect(out[0].content.text).toBe('old');
    });
});

/**
 * Static wiring checks: every place a reportable message is encrypted and sent
 * seals a franking key and sends the commitment; every place a message is
 * decrypted and stored lifts the sealed key out first. A new send path that
 * forgets either would silently stop being verifiable, and nothing else would
 * notice.
 */
describe('wiring', () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    const chat = read('../components/ChatPane.tsx');
    const dash = read('../components/Dashboard.tsx');
    const count = (src: string, needle: string) => src.split(needle).length - 1;

    it('ChatPane franks all eight reportable send paths and sends the header on each', () => {
        // attachments (DM + channel), sendClientContent (DM + channel), queued text (DM + channel), text with files (DM + channel)
        expect(count(chat, 'await frankForSend(')).toBe(8);
        // 6 inline (...frankingHeaders(franked)) + the two queued paths, which Object.assign them onto their job's headers.
        expect(count(chat, 'frankingHeaders(franked)')).toBe(8);
    });

    it('nothing in ChatPane encrypts reportable content without going through frankForSend', () => {
        // The only direct encrypt calls left are the control messages (pins, call keys).
        const direct = chat.split('\n').filter(l => /encryptAndAddress\(JSON\.stringify\(content\)/.test(l));
        expect(direct.length).toBe(2);
        for (const l of direct) expect(l).toMatch(/callDevices|devs/);
    });

    it('the quick-reply send in Dashboard is franked on both branches', () => {
        expect(count(dash, 'await frankForSend(')).toBe(2);
        expect(count(dash, 'frankingHeaders(franked)')).toBe(2);
    });

    it('all three decrypt-and-store paths lift the sealed key out before anything else', () => {
        expect(count(dash, 'liftSealedFranking(')).toBe(3);
        expect(count(dash, 'buildStoredFranking({')).toBe(3);
    });

    it('attachments carry the plaintext hash on both upload paths', () => {
        expect(count(chat, 'await hashFileForCommitment(file)')).toBe(2);
        expect(count(chat, 'content_sha256_b64: fileSha256')).toBe(2);
    });
});
