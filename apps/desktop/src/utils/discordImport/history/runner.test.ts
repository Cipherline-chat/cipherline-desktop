import { describe, it, expect, vi } from 'vitest';
import { parseImportedFrom } from '@cipherline/shared';
import { HistoryAborted, newHistoryState, runHistoryImport, type HistoryDeps } from './runner';
import type { ChannelHistory, ImportMessage } from '../types';

const AUTH = (n: number) => `4444444${n}-4444-4444-8444-444444444444`;
const CH = '22222222-2222-4222-8222-222222222222';

const msg = (id: string, o: Partial<ImportMessage> = {}): ImportMessage => ({
    id, ts: `2026-11-0${Math.min(9, Number(id.slice(-1)) || 1)}T10:00:00.000Z`, edited: false,
    author: { id: '900000000000000001', name: 'Alex', username: 'alex_92', kind: 'user', avatarRef: 'av-1' },
    content: `text ${id}`, mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], poll: null, pinned: false, ...o,
});

function harness(history: ChannelHistory, o: { failBatchOnce?: boolean; abortAfterBatch?: AbortController } = {}) {
    const posted: Array<{ seq_start: number; rows: Array<Record<string, unknown>> }> = [];
    const sealed: string[] = [];
    const saves: Array<{ pin: boolean; items: Array<{ message_id: string; attachment_ids: string[] }> }> = [];
    let next = 0;
    let failed = false;
    const api: HistoryDeps['api'] = {
        createSession: vi.fn(async () => ({ id: 'imp-1' })),
        registerAuthors: vi.fn(async (_i: string, authors: unknown[]) => ({ author_ids: authors.map((_a: unknown, k: number) => AUTH(k + 1)) })),
        postBatch: vi.fn(async (_i: string, body: { seq_start: number; rows: Array<Record<string, unknown>> }) => {
            if (o.failBatchOnce && !failed) { failed = true; throw Object.assign(new Error('network'), { response: undefined }); }
            if (body.seq_start !== next) throw Object.assign(new Error('seq'), { response: { status: 409 } });
            posted.push({ seq_start: body.seq_start, rows: body.rows });
            const ids = body.rows.map((_r: unknown, k: number) => `row-${next + k}`);
            next += body.rows.length;
            if (o.abortAfterBatch) o.abortAfterBatch.abort();
            return { ids, seq_next: next };
        }),
        initiateFiles: vi.fn(async (_i: string, _c: string, files: unknown[]) => files.map((_f: unknown, k: number) => ({ attachment_id: crypto.randomUUID() + (k ? "" : ""), upload_url: 'https://minio.local/put' }))),
        save: vi.fn(async (_i: string, body: { pin: boolean; items: Array<{ message_id: string; attachment_ids: string[] }> }) => { saves.push(body); return { results: body.items.map((x: { message_id: string }) => ({ message_id: x.message_id, status: 'pinned' })), used_bytes: 0, limit_bytes: 0 }; }),
        complete: vi.fn(async () => ({})),
    };
    const deps: HistoryDeps = {
        api,
        readChannel: async () => history,
        fetchMedia: async (ref) => (ref === 'too-big' ? { ok: false, code: 'too_large', message: 'too large' } : { ok: true, mime: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]) }),
        encryptFile: async (bytes) => ({ blob: new Blob([bytes as BlobPart]), keyB64: 'a2V5', nonceB64: 'bm9uY2U=', sha256B64: null }),
        upload: async () => undefined,
        sealRow: async (json) => { sealed.push(json); return { epoch: 1, nonce_b64: 'bg==', ciphertext_b64: btoa(unescape(encodeURIComponent(json))).slice(0, 40), signature_b64: 'c2ln' }; },
        deviceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        maxFileBytes: 100 * 1024 * 1024,
        sleep: async () => undefined,
        newId: (() => { let i = 0; return () => `cm-${i++}`; })(),
    };
    return { deps, api, posted, sealed, saves };
}

const hist = (messages: ImportMessage[], pins: ImportMessage[] = []): ChannelHistory => ({ messages, pins, truncated: false, names: { roles: {}, channels: {} } });

describe('runHistoryImport: Discord\'s link previews (link embeds phase 4)', () => {
    it('become the text row\'s embeds with their picture uploaded through the import path; an untied one stays quoted text', async () => {
        const { deps, sealed, posted, api } = harness(hist([msg('900000000000000301', {
            content: 'look https://news.example/a',
            linkEmbeds: [
                { url: 'https://news.example/a', type: 'article', title: 'A headline', description: 'Body', site: 'News', author: null, color: '#ff4e00', thumbRef: 'thumb-1', thumbWidth: 1200, thumbHeight: 630, videoUrl: null },
                { url: 'https://gone.example/x', type: 'link', title: 'Elsewhere', description: null, site: null, author: null, color: null, thumbRef: null, thumbWidth: null, thumbHeight: null, videoUrl: null },
            ],
        })]));
        deps.encryptFile = async (bytes) => ({ blob: new Blob([bytes as BlobPart, new Uint8Array(28)]), keyB64: 'A'.repeat(43) + '=', nonceB64: 'B'.repeat(16), sha256B64: null });
        deps.reencodeThumb = async () => ({ blob: new Blob([new Uint8Array(30_000).fill(5)]), mime: 'image/webp', width: 920, height: 483 });
        const st = await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        const row = JSON.parse(sealed[0]);
        expect(row.type).toBe('text');
        expect(row.embeds).toHaveLength(1);
        expect(row.embeds[0]).toMatchObject({ url: 'https://news.example/a', kind: 'card', title: 'A headline', site: 'News', color: '#ff4e00', thumb: { mime: 'image/webp', byte_size: 30_000 } });
        expect(row.text).toContain('Elsewhere');
        expect(row.text).not.toContain('A headline');
        // avatar + the preview picture went up through initiateFiles; the picture is attached to the row.
        expect((api.initiateFiles as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
        expect(posted[0].rows).toHaveLength(1);
        expect(st.reports[0].linkPreviews).toBe(1);
    });
});

describe('runHistoryImport', () => {
    it('posts rows in order with gap-free seqs, every row carrying a VALID imported_from for its author', async () => {
        const { deps, posted, sealed } = harness(hist(Array.from({ length: 230 }, (_, i) => msg(`9000000000000${String(i).padStart(5, '0')}`))));
        const st = await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        expect(posted.map(p => p.seq_start)).toEqual([0, 100, 200]);
        expect(posted.flatMap(p => p.rows)).toHaveLength(230);
        const firstContent = JSON.parse(sealed[0]);
        const block = parseImportedFrom(firstContent.imported_from);
        expect(block).toMatchObject({ author_ref: AUTH(1), name: 'Alex', original_ts: '2026-11-01T10:00:00.000Z' });
        expect(posted[0].rows[0].author_ref).toBe(AUTH(1));
        // The plaintext never leaves except through sealRow: the posted row has only ciphertext fields.
        expect(Object.keys(posted[0].rows[0]).sort()).toEqual(['author_ref', 'ciphertext_b64', 'nonce_b64', 'signature_b64']);
        expect(st.reports[0]).toMatchObject({ messages: 230, rows: 230, error: null });
    });

    it('files: one attachment row per file after the text row; avatars uploaded once per author; too-large files become a note', async () => {
        const { deps, sealed, api } = harness(hist([
            msg('900000000000000101', { files: [{ ref: 'f1', filename: 'a.png', size: 9, mime: 'image/png', voice: false }, { ref: 'too-big', filename: 'b.bin', size: 9, mime: 'application/octet-stream', voice: false }] }),
            msg('900000000000000102', { content: '', files: [{ ref: 'v1', filename: 'voice.ogg', size: 9, mime: 'audio/ogg', voice: true }] }),
        ]));
        const st = await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        const contents = sealed.map(s => JSON.parse(s));
        // the voice message is now an ordinary audio attachment row (it has no words, so no text row)
        expect(contents.map(c => c.type)).toEqual(['text', 'attachment', 'attachment']);
        expect(contents[0].text).toContain('File couldn’t be copied: b.bin · 9 B (too large to copy, the limit is 100.0 MB)');
        expect(contents[2]).toMatchObject({ type: 'attachment', filename: 'voice.ogg' });
        expect(JSON.stringify(contents)).not.toContain('Voice message (not imported)');
        expect(contents[1]).toMatchObject({ type: 'attachment', filename: 'a.png', enc_alg: 'aes256gcm' });
        expect(contents.every(c => c.imported_from?.avatar?.attachment_id)).toBe(true);
        // avatar (1) + a.png (1) + voice (1); the too-large file never uploaded
        expect((api.initiateFiles as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
        expect(st.reports[0].filesSkipped).toEqual([{ filename: 'b.bin', reason: 'too large to copy, the limit is 100.0 MB', code: 'too_large', size: 9 }]);
    });

    it('replies: a reply waits for its parent\'s id (the batch is flushed first) and points at it', async () => {
        const { deps, sealed, posted } = harness(hist([msg('900000000000000201'), msg('900000000000000202', { replyTo: '900000000000000201' }), msg('900000000000000203', { replyTo: '800000000000000999' })]));
        await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        expect(posted.map(p => p.rows.length)).toEqual([1, 2]);
        expect(JSON.parse(sealed[1]).reply_to_id).toBe('row-0');
        expect(posted[1].rows[0].reply_to_id).toBe('row-0');
        expect(JSON.parse(sealed[2]).text).toContain('Replying to a message that was not imported');
    });

    it('pins: saved and pinned newest-pin-first, with each row\'s files and the avatar declared', async () => {
        const p1 = msg('900000000000000301', { pinned: true });
        const old = msg('900000000000000050', { ts: '2026-06-01T00:00:00.000Z', pinned: true });
        const { deps, saves } = harness(hist([msg('900000000000000300'), p1], [p1, old]));
        const st = await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        expect(saves).toHaveLength(1);
        expect(saves[0].pin).toBe(true);
        // old pin posted first (row-0), the window rows next (row-1, row-2 = p1); save order newest pin first.
        expect(saves[0].items.map(i => i.message_id)).toEqual(['row-2', 'row-0']);
        expect(saves[0].items.every(i => i.attachment_ids.length === 1)).toBe(true); // the avatar
        expect(st.reports[0].pinsSaved).toBe(2);
    });

    it('a lost answer is retried with the SAME seq (the server replays it)', async () => {
        const { deps, posted } = harness(hist([msg('900000000000000401')]), { failBatchOnce: true });
        await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        expect(posted.map(p => p.seq_start)).toEqual([0]);
    });

    it('cancel stops between batches and throws HistoryAborted; the session id is kept for "delete what was posted"', async () => {
        const ctl = new AbortController();
        const { deps, api } = harness(hist(Array.from({ length: 150 }, (_, i) => msg(`9000000000001${String(i).padStart(5, '0')}`))), { abortAfterBatch: ctl });
        const st = newHistoryState();
        await expect(runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, st, () => {}, ctl.signal)).rejects.toBeInstanceOf(HistoryAborted);
        expect(st.importId).toBe('imp-1');
        expect(api.complete).not.toHaveBeenCalled();
    });

    it('one failing channel is reported and the others still run', async () => {
        const { deps } = harness(hist([msg('900000000000000501')]));
        let n = 0;
        deps.readChannel = async () => { if (n++ === 0) throw new Error('The bot is not allowed to see that.'); return hist([msg('900000000000000502')]); };
        const st = await runHistoryImport(deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'a' }, { channel: 2, channelId: '22222222-2222-4222-8222-333333333333', name: 'b' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
        expect(st.reports.map(r => [r.name, r.error, r.messages])).toEqual([['a', 'The bot is not allowed to see that.', 0], ['b', null, 1]]);
    });
});

describe('imported reactions in the posted block', () => {
    it('reactors are registered as authors too; the FIRST row carries the reactions (refs, names); a foreign custom emoji is left out and counted', async () => {
        const reactions = [
            { emoji: { id: null, name: '🎉', animated: false }, count: 3, users: [{ id: '900000000000000002', name: 'Sam', kind: 'user' as const }, { id: '900000000000000077', name: 'helper', kind: 'app' as const }] },
            { emoji: { id: '800000000000000040', name: 'party_parrot', animated: true }, count: 1, users: [{ id: '900000000000000003', name: 'Riley', kind: 'user' as const }] },
            { emoji: { id: '800000000000000041', name: 'Tractor', animated: false }, count: 1, users: [] },
        ];
        const h = harness(hist([msg('700000000000000001', { reactions })]));
        const r = await runHistoryImport(h.deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: { emojiIds: { tractor: '99999999-9999-4999-8999-999999999999' } } }, newHistoryState(), () => {}, new AbortController().signal);
        const reg = (h.api.registerAuthors as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<{ discord_user_id: string; kind: string }>;
        expect(reg.map(a => [a.discord_user_id, a.kind])).toEqual([
            ['900000000000000001', 'user'], ['900000000000000002', 'user'], ['900000000000000077', 'app'], ['900000000000000003', 'user'],
        ]);
        const block = parseImportedFrom(JSON.parse(h.sealed[0]).imported_from)!;
        expect(block.reactions).toEqual([
            { emoji: '🎉', count: 3, reactors: [{ ref: AUTH(2), name: 'Sam' }, { ref: AUTH(3), name: 'helper' }] },
            { emoji: '<:Tractor:99999999-9999-4999-8999-999999999999>', count: 1, reactors: [] },
        ]);
        expect(r.reports[0].error).toBeNull();
        expect(r.reports.map(x => x.reactionsSkipped)).toEqual([1]); // :party_parrot: is not on this server
        expect(JSON.stringify(h.sealed)).not.toContain('900000000000000002'); // no Discord id inside content either
    });
});


describe('content: role / channel mentions, forwards, embed pictures', () => {
    const ROLE = '33333333-3333-4333-8333-333333333333';
    const CHAN = '44444444-4444-4444-8444-555555555555';
    const run = (h: ReturnType<typeof harness>) => runHistoryImport(h.deps, {
        serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }],
        roleRefs: { 'r:3': ROLE }, channelRefs: { 'c:7': CHAN }, convert: {},
    }, newHistoryState(), () => {}, new AbortController().signal);

    it('role and channel mentions become real tokens / channel_refs of the created ones, never a ping field', async () => {
        const h = harness({
            messages: [msg('700000000000000010', { content: 'ping <@&800000000000000003> in <#800000000000000011> @everyone' })], pins: [], truncated: false,
            names: { roles: { '800000000000000003': 'Mods' }, channels: { '800000000000000011': 'rules' }, roleNums: { '800000000000000003': 3 }, channelNums: { '800000000000000011': 7 } },
        });
        await run(h);
        const c = JSON.parse(h.sealed[0]);
        expect(c.text).toContain(`<@r:${ROLE}:Mods>`);
        expect(c.mentions).toEqual([{ type: 'role', id: ROLE }]);
        expect(c.channel_refs).toEqual([{ id: CHAN, name: 'rules' }]);
        expect(c.text).not.toContain('@everyone'); // still defused
        expect(h.posted[0].rows[0]).not.toHaveProperty('mentions_everyone');
    });

    it('a forward posts its original words (quoted) and its files as attachment rows', async () => {
        const h = harness(hist([msg('700000000000000011', { content: '', forwarded: { content: 'original words', ts: '2026-10-01T00:00:00.000Z' }, files: [{ ref: 'f1', filename: 'pic.png', size: 9, mime: 'image/png', voice: false }] })]));
        await run(h);
        const cs = h.sealed.map(x => JSON.parse(x));
        expect(cs.map(c => c.type)).toEqual(['text', 'attachment']);
        expect(cs[0].text).toContain('Forwarded message');
        expect(cs[0].text).toContain('> original words');
    });

    it('an embed picture that cannot be copied leaves no "not imported" note; an attachment that cannot does', async () => {
        const h = harness(hist([msg('700000000000000012', { files: [{ ref: 'too-big', filename: 'embed-image', size: 0, mime: 'application/octet-stream', voice: false, embedImage: true }, { ref: 'too-big', filename: 'real.bin', size: 0, mime: 'application/octet-stream', voice: false }] })]));
        await run(h);
        const t = JSON.parse(h.sealed[0]).text as string;
        expect(t).toContain('real.bin');
        expect(t).not.toContain('embed-image');
    });
});

describe('stickers in imported messages', () => {
    const SID = '55555555-5555-4555-8555-555555555555';
    const STICKER = '66666666-6666-4666-8666-666666666666';
    const run = (h: ReturnType<typeof harness>, stickerRefs: Record<string, { id: string; name: string }> = {}) =>
        runHistoryImport(h.deps, { serverId: SID, channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: { stickerRefs } }, newHistoryState(), () => {}, new AbortController().signal);

    it('a sticker of THIS guild (imported as a server sticker) becomes a real sticker row pointing at it; the words keep their own row', async () => {
        const h = harness(hist([
            msg('900000000000000301', { content: '', stickers: ['Wave Hello'], stickerItems: [{ id: '800000000000000060', name: 'Wave Hello', format: 1, ref: 'st-1' }] }),
            msg('900000000000000302', { content: 'look at this', stickers: ['Wave Hello'], stickerItems: [{ id: '800000000000000060', name: 'Wave Hello', format: 1, ref: 'st-1' }] }),
        ]));
        const st = await run(h, { '800000000000000060': { id: STICKER, name: 'wave_hello' } });
        const c = h.sealed.map(s => JSON.parse(s));
        expect(c.map(x => x.type)).toEqual(['text', 'text', 'text']);
        expect(c[0]).toMatchObject({ text: '[Sticker: wave_hello]', sticker: { source: 'server', id: STICKER, server_id: SID, name: 'wave_hello' } });
        expect(c[1].text).toContain('look at this');
        expect(c[1].text).not.toContain('Sticker:');
        expect(c[2].sticker).toMatchObject({ id: STICKER });
        expect(c.every(x => x.imported_from)).toBe(true);
        expect(st.reports[0].stickers).toBe(2);
        expect(c.some(x => x.type === 'attachment')).toBe(false); // no sticker bytes uploaded
    });

    it('another server\'s / Discord\'s own sticker rides as an image attachment; a Lottie sticker stays a text line and is counted', async () => {
        const h = harness(hist([
            msg('900000000000000311', { content: '', stickers: ['Nitro Cat', 'Spinny'], stickerItems: [{ id: '700000000000000001', name: 'Nitro Cat', format: 4, ref: 'st-ext' }, { id: '700000000000000002', name: 'Spinny', format: 3, ref: null }] }),
        ]));
        const st = await run(h);
        const c = h.sealed.map(s => JSON.parse(s));
        expect(c.map(x => x.type)).toEqual(['text', 'attachment']);
        expect(c[0].text).toBe('-# Sticker: Spinny');
        expect(c[1]).toMatchObject({ type: 'attachment', filename: 'Nitro_Cat.gif' });
        expect(c.some(x => x.sticker)).toBe(false);
        expect(st.reports[0].stickersSkipped).toBe(1);
    });

    it('POSITIVE CONTROL: without the structure import\'s sticker map the same guild sticker is an attachment, never a dangling reference', async () => {
        const h = harness(hist([msg('900000000000000321', { content: '', stickers: ['Wave Hello'], stickerItems: [{ id: '800000000000000060', name: 'Wave Hello', format: 1, ref: 'st-1' }] })]));
        await run(h);
        const c = h.sealed.map(s => JSON.parse(s));
        expect(c.map(x => x.type)).toEqual(['attachment']);
        expect(c[0].filename).toBe('Wave_Hello.png');
    });
});

describe('runHistoryImport: one bad message never costs the channel; the report counts what the SERVER accepted', () => {
    const ids = (n: number, base = 900000000000400000n) => Array.from({ length: n }, (_, i) => String(base + BigInt(i)));
    const go = (h: ReturnType<typeof harness>) =>
        runHistoryImport(h.deps, { serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {} }, newHistoryState(), () => {}, new AbortController().signal);
    const refuse = (message: string, status = 400, code?: string) => Object.assign(new Error(String(status)), { response: { status, data: { message, ...(code ? { code } : {}) } } });

    it('a message that throws while it is prepared (encrypt / seal) is left out and counted; every other message is posted', async () => {
        const h = harness(hist(ids(150).map(id => msg(id))));
        const seal = h.deps.sealRow;
        h.deps.sealRow = async (json, ch) => { if (json.includes('text 900000000000400007')) throw new Error('Could not encrypt this message'); return seal(json, ch); };
        const st = await go(h);
        expect(h.posted.flatMap(p => p.rows)).toHaveLength(149);
        expect(st.reports[0]).toMatchObject({ error: null, messages: 149, rows: 149, messagesSkipped: 1, skipReason: 'Could not encrypt this message' });
    });

    it('a row the server refuses (400) is found by halving the batch: the rest of the batch and channel still post', async () => {
        const h = harness(hist(ids(150).map(id => msg(id))));
        const seal = h.deps.sealRow;
        h.deps.sealRow = async (json, ch) => (json.includes('text 900000000000400042') ? { epoch: 1, nonce_b64: 'bg==', ciphertext_b64: 'QkFE', signature_b64: 'c2ln' } : seal(json, ch));
        const post = h.api.postBatch;
        h.api.postBatch = vi.fn(async (i: string, body: Parameters<typeof post>[1]) => {
            if (body.rows.some(r => r.ciphertext_b64 === 'QkFE')) throw refuse('rows.42.ciphertext_b64 must be base64');
            return post(i, body);
        });
        const st = await go(h);
        expect(h.posted.flatMap(p => p.rows)).toHaveLength(149);
        expect(h.posted.flatMap(p => p.rows).some(r => r.ciphertext_b64 === 'QkFE')).toBe(false);
        expect(st.reports[0]).toMatchObject({ error: null, rows: 149, messages: 149, messagesSkipped: 1, skipReason: 'rows.42.ciphertext_b64 must be base64' });
        // bounded: the bad 100-row batch costs ~2 x log2(100) extra requests, not 100
        expect((h.api.postBatch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(20);
    });

    it('a refusal that is about the CHANNEL (every row 400) fails the channel after a few tries: no request storm, never "0 messages"', async () => {
        const h = harness(hist(ids(300).map(id => msg(id))));
        h.api.postBatch = vi.fn(async () => { throw refuse('That channel is not part of this import'); });
        const st = await go(h);
        expect(st.reports[0].error).toBe('That channel is not part of this import');
        expect(st.reports[0]).toMatchObject({ rows: 0, messages: 0 });
        expect((h.api.postBatch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThan(20);
    });

    it('every message failing one by one is a FAILED channel with the reason, and the session stays open for a retry', async () => {
        const h = harness(hist(ids(5).map(id => msg(id))));
        h.deps.sealRow = async () => { throw new Error('No key for this channel yet'); };
        const st = await go(h);
        expect(st.reports[0].error).toMatch(/None of its messages could be copied \(No key for this channel yet\)/);
        expect(h.api.complete).not.toHaveBeenCalled();
    });

    it('a channel that stops after its first batch reports the messages the server accepted, not the ones read', async () => {
        const h = harness(hist(ids(250).map(id => msg(id))));
        const post = h.api.postBatch;
        let n = 0;
        h.api.postBatch = vi.fn(async (i: string, body: Parameters<typeof post>[1]) => {
            if (n++ >= 1) throw refuse('This channel reached the most messages one import can bring over.', 413, 'IMPORT_CAP_REACHED');
            return post(i, body);
        });
        const st = await go(h);
        expect(st.reports[0]).toMatchObject({ rows: 100, messages: 100 });
        expect(st.reports[0].error).toBeTruthy();
        // partly posted: kept and reported as stopped (no blind retry), the session closes normally
        expect(h.api.complete).toHaveBeenCalledTimes(1);
    });
});

describe('channel sources ("Copy messages from Discord": the API\'s no-duplicates rule)', () => {
    const run = (deps: HistoryDeps, sources?: Record<string, string>) => runHistoryImport(deps, {
        serverId: 's', channels: [{ channel: 1, channelId: CH, name: 'general' }], convert: {}, ...(sources ? { channelSources: sources } : {}),
    }, newHistoryState(), () => {}, new AbortController().signal);

    it('sends each channel\'s source key with the session; none when there are none', async () => {
        const a = harness(hist([msg('900000000000000101')]));
        await run(a.deps, { [CH]: 'e'.repeat(64) });
        expect(a.api.createSession).toHaveBeenCalledWith(expect.objectContaining({ channel_ids: [CH], channel_sources: [{ channel_id: CH, source_key: 'e'.repeat(64) }] }));
        const b = harness(hist([msg('900000000000000101')]));
        await run(b.deps);
        expect((b.api.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('channel_sources');
    });

    it('an API older than channel sources (400 "property channel_sources should not exist"): imports without them', async () => {
        const h = harness(hist([msg('900000000000000101')]));
        const create = h.api.createSession as ReturnType<typeof vi.fn>;
        create.mockRejectedValueOnce(Object.assign(new Error('400'), { response: { status: 400, data: { message: ['property channel_sources should not exist'] } } }));
        const st = await run(h.deps, { [CH]: 'e'.repeat(64) });
        expect(create).toHaveBeenCalledTimes(2);
        expect(create.mock.calls[1][0]).not.toHaveProperty('channel_sources');
        expect(st.reports[0]).toMatchObject({ messages: 1, error: null });
    });

    it('POSITIVE CONTROL: any other refusal (409 already copied) is NOT retried without sources', async () => {
        const h = harness(hist([msg('900000000000000101')]));
        const create = h.api.createSession as ReturnType<typeof vi.fn>;
        create.mockRejectedValueOnce(Object.assign(new Error('409'), { response: { status: 409, data: { code: 'IMPORT_ALREADY_COPIED', message: 'Messages from that Discord channel are already in this server.' } } }));
        await expect(run(h.deps, { [CH]: 'e'.repeat(64) })).rejects.toThrow('409');
        expect(create).toHaveBeenCalledTimes(1);
    });
});
