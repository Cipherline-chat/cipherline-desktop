/**
 * Page snapshots in the renderer (2026-11-23):
 *   - prepareLinkEmbed marks a picture-less real page `snapshot: 'pending'`;
 *     a page with its own picture, a wall / minimal card, a post never;
 *   - snapshotPrepared turns main's PNG into the card's large WebP picture,
 *     and a refusal (login / bot wall / error / blank) into the designed card;
 *   - the late preview: which late previews are worth an edit, the merged
 *     embeds, "unchanged since send";
 *   - the embeds-only edit is NOT marked "(edited)" on any reader path (DM
 *     history, channel history / live), while a real text edit (flagged or
 *     not) always IS. POSITIVE CONTROLS throughout.
 */
import { describe, it, expect, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { isEmbedsOnlyEdit, type LinkEmbed } from '@cipherline/shared';

const thumbMock = vi.hoisted(() => ({ calls: [] as { edge?: number }[], ok: true }));
vi.mock('./thumb', async (orig) => {
    const real = await orig<typeof import('./thumb')>();
    return {
        ...real,
        reencodeThumb: vi.fn(async (_b: Uint8Array, edge?: number) => {
            thumbMock.calls.push({ edge });
            return thumbMock.ok ? { blob: new NodeBlob([new Uint8Array(90_000)]) as unknown as Blob, mime: 'image/webp', width: 1200, height: 675 } : null;
        }),
    };
});

import { prepareLinkEmbed, snapshotPrepared, type PreparedEmbed } from './prepare';
import { improvesOn, mergeLateEmbeds, runLateAttach, unchangedSinceSend, LATE_EMBED_WAIT_MS, type EmbedsOnlyEdit } from './lateAttach';
import { applyChannelEditDelete } from '../channelHistoryMerge';
import { applyIncomingDmMessages } from '../dmInbound';

const URL1 = 'https://www.bbc.com/news';
const card = (over: Partial<LinkEmbed> = {}): LinkEmbed => ({ url: URL1, kind: 'card', site: 'BBC News', title: 'BBC News - Breaking news', ...over } as LinkEmbed);

describe('prepareLinkEmbed: which cards wait for a snapshot', () => {
    it('a real page without a picture (main flagged it): pending', async () => {
        const p = await prepareLinkEmbed(URL1, vi.fn(async () => ({ ok: true as const, embed: card() as unknown as Record<string, unknown>, snapshot: true as const })));
        expect(p?.snapshot).toBe('pending');
        expect(p?.thumb).toBeUndefined();
    });
    it('POSITIVE CONTROL: not flagged (a wall / minimal card), or a page with its own picture: never', async () => {
        const wall = await prepareLinkEmbed('https://stackoverflow.com/q/1', vi.fn(async () => ({ ok: true as const, embed: { url: 'https://stackoverflow.com/q/1', kind: 'card', site: 'stackoverflow.com' } })));
        expect(wall?.snapshot).toBeUndefined();
        const pic = await prepareLinkEmbed(URL1, vi.fn(async () => ({ ok: true as const, embed: card() as unknown as Record<string, unknown>, image: { bytes: new Uint8Array([1]), mime: 'image/png' }, snapshot: true as const })));
        expect(pic?.thumb).toBeDefined();
        expect(pic?.snapshot).toBeUndefined();
    });
});

describe('snapshotPrepared', () => {
    const pending = (): PreparedEmbed => ({ url: URL1, embed: card(), snapshot: 'pending' });
    it('main\'s PNG → a 1200 px WebP thumbnail, the card marked large', async () => {
        thumbMock.ok = true;
        thumbMock.calls.length = 0;
        const snap = vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([0x89, 0x50]), mime: 'image/png' as const, width: 1200, height: 675, ms: 2100 }));
        const p = await snapshotPrepared(pending(), 'tokenaaaa', snap);
        expect(snap).toHaveBeenCalledWith(URL1, 'tokenaaaa');
        expect(thumbMock.calls).toEqual([{ edge: 1200 }]);
        expect(p.thumb).toMatchObject({ mime: 'image/webp', width: 1200, height: 675 });
        expect(p.embed.image_large).toBe(true);
        expect(p.snapshot).toBeUndefined();
        expect(p.snapshotResult).toBe('ok');
    });
    it('a refusal (login / bot wall / error / blank / cancelled) or a failure: the card without a picture', async () => {
        for (const reason of ['login', 'bot-wall', 'error', 'blank', 'cancelled', 'timeout']) {
            const p = await snapshotPrepared(pending(), 'tokenaaaa', vi.fn(async () => ({ ok: false as const, reason })));
            expect(p.thumb).toBeUndefined();
            expect(p.snapshotResult).toBe(reason);
            expect(p.embed).toEqual(card());
        }
        expect((await snapshotPrepared(pending(), 'tokenaaaa', vi.fn(async () => { throw new Error('x'); }))).snapshotResult).toBe('failed');
        thumbMock.ok = false;
        expect((await snapshotPrepared(pending(), 'tokenaaaa', vi.fn(async () => ({ ok: true as const, bytes: new Uint8Array([1]), mime: 'image/png' as const, width: 1, height: 1, ms: 1 })))).thumb).toBeUndefined();
        thumbMock.ok = true;
        // Not pending: no call at all.
        const snap = vi.fn();
        expect((await snapshotPrepared({ url: URL1, embed: card() }, 'tokenaaaa', snap)).thumb).toBeUndefined();
        expect(snap).not.toHaveBeenCalled();
    });
});

describe('late previews', () => {
    const thumb = { mime: 'image/webp' as const, width: 1200, height: 675, attachment_id: '11111111-1111-4111-8111-111111111111', file_key_b64: 'A'.repeat(43) + '=', file_nonce_b64: 'B'.repeat(16), byte_size: 90_000 };
    const withPic = (): PreparedEmbed => ({ url: URL1, embed: card({ image_large: true }), thumb: { blob: new NodeBlob(['x']) as unknown as Blob, mime: 'image/webp', width: 1200, height: 675 } });
    it('improvesOn: a picture where there was none, or a real card over the minimal one; nothing else', () => {
        expect(improvesOn(card(), withPic())).toBe(true);
        expect(improvesOn(undefined, withPic())).toBe(true);
        expect(improvesOn(card({ kind: 'card', title: undefined, site: 'bbc.com' }), { url: URL1, embed: card() })).toBe(true);
        // POSITIVE CONTROLS: same card again; a card that already had a picture.
        expect(improvesOn(card(), { url: URL1, embed: card() })).toBe(false);
        expect(improvesOn(card({ thumb } as Partial<LinkEmbed>), withPic())).toBe(false);
    });
    it('mergeLateEmbeds: link order, late replaces sent for its link, the rest kept, validated', () => {
        const text = `a https://x.example/1 b ${URL1}`;
        const x = { url: 'https://x.example/1', kind: 'card', site: 'x.example' } as LinkEmbed;
        const merged = mergeLateEmbeds(text, [x, card()], [card({ thumb } as Partial<LinkEmbed>)]);
        expect(merged.map((e) => [e.url, !!e.thumb])).toEqual([['https://x.example/1', false], [URL1, true]]);
        // A forged late embed for a link not in the text is dropped by the validator.
        expect(mergeLateEmbeds(text, [x], [card({ url: 'https://evil.example/' })]).map((e) => e.url)).toEqual(['https://x.example/1']);
    });
    it('unchangedSinceSend: the text and the previews as sent; an edit or a removed preview stops the attach', () => {
        const text = `see ${URL1}`;
        expect(unchangedSinceSend({ type: 'text', text, embeds: [card()] }, text, [card()])).toBe(true);
        expect(unchangedSinceSend({ type: 'text', text: `${text} (fixed typo)`, embeds: [card()] }, text, [card()])).toBe(false);
        expect(unchangedSinceSend({ type: 'text', text }, text, [card()])).toBe(false);
        expect(unchangedSinceSend(null, text, [])).toBe(false);
    });
});

describe('the embeds-only edit and the "(edited)" mark', () => {
    const text = `see ${URL1}`;
    const original = { type: 'text', text, client_msg_id: 'c1', embeds: [card()] };
    const late = card({ image_large: true, thumb: { mime: 'image/webp', width: 1200, height: 675, inline_b64: 'U'.repeat(40) } } as Partial<LinkEmbed>);
    const embedsOnly = { type: 'edit', target_id: 'm1', text, embeds: [late], embeds_only: true };

    it('isEmbedsOnlyEdit: only the flag + nothing but embeds changed + no preview removed', () => {
        const after = { ...original, embeds: [late] };
        expect(isEmbedsOnlyEdit(original, after, embedsOnly)).toBe(true);
        // POSITIVE CONTROLS: every way a real edit could try to hide.
        expect(isEmbedsOnlyEdit(original, after, { ...embedsOnly, embeds_only: undefined })).toBe(false);          // no flag
        expect(isEmbedsOnlyEdit(original, { ...after, text: 'different words' }, embedsOnly)).toBe(false);          // the words changed
        expect(isEmbedsOnlyEdit(original, { ...after, font: 'mono' }, embedsOnly)).toBe(false);                     // the font changed
        expect(isEmbedsOnlyEdit({ ...original, embeds: [card(), card({ url: 'https://x.example/1' })] }, after, embedsOnly)).toBe(false); // a preview removed
        expect(isEmbedsOnlyEdit(original, { ...after, embeds: undefined }, embedsOnly)).toBe(false);                // all previews removed
        expect(isEmbedsOnlyEdit({ type: 'text', text }, { type: 'text', text, embeds: [late] }, embedsOnly)).toBe(true); // a message that went without one
    });

    it('DM path (dmInbound): the late preview lands unmarked; a real text edit with the flag is still marked', () => {
        const row = { id: 'm1', content: original, sender_device_id: 'd1', sender_user_id: 'u1', timestamp: '2026-11-23T20:00:00.000Z' };
        const edit = (content: unknown) => ({ id: 'e1', content, sender_device_id: 'd1', sender_user_id: 'u1', timestamp: '2026-11-23T20:00:03.000Z' });
        const a = applyIncomingDmMessages({ conv: [row] } as never, { conv: [edit(embedsOnly)] } as never) as Record<string, { edited?: boolean; content: { embeds?: LinkEmbed[]; text: string } }[]>;
        expect(a.conv[0].edited).toBeUndefined();
        expect(a.conv[0].content.embeds?.[0].thumb).toBeDefined();
        const b = applyIncomingDmMessages({ conv: [row] } as never, { conv: [edit({ ...embedsOnly, text: 'see the other thing' })] } as never) as typeof a;
        expect(b.conv[0].edited).toBe(true);
        expect(b.conv[0].content.text).toBe('see the other thing');
        const c = applyIncomingDmMessages({ conv: [row] } as never, { conv: [edit({ type: 'edit', target_id: 'm1', text: `${text}!` })] } as never) as typeof a;
        expect(c.conv[0].edited).toBe(true);
    });

    it('channel path (history fold + live): the same rule', () => {
        const row = { id: 'm1', content: original, sender_device_id: 'd1', sender_user_id: 'u1', timestamp: '2026-11-23T20:00:00.000Z' };
        const act = (content: unknown) => ({ id: 'e1', content, sender_device_id: 'd1', sender_user_id: 'u1', timestamp: '2026-11-23T20:00:03.000Z' });
        const a = applyChannelEditDelete([row] as never[], act(embedsOnly) as never) as { edited?: boolean; content: { embeds?: LinkEmbed[] } }[];
        expect(a[0].edited).toBeUndefined();
        expect(a[0].content.embeds?.[0].thumb).toBeDefined();
        const b = applyChannelEditDelete([row] as never[], act({ ...embedsOnly, text: 'other words' }) as never) as typeof a;
        expect(b[0].edited).toBe(true);
        // A message that was already edited for real keeps its mark when a late preview lands.
        const c = applyChannelEditDelete([{ ...row, edited: true }] as never[], act(embedsOnly) as never) as typeof a;
        expect(c[0].edited).toBe(true);
    });
});

describe('runLateAttach', () => {
    const text = `see ${URL1}`;
    const snap = (): PreparedEmbed => ({ url: URL1, embed: card({ image_large: true }), thumb: { blob: new NodeBlob(['x']) as unknown as Blob, mime: 'image/webp', width: 1200, height: 675 } });
    const finalized = card({ image_large: true, thumb: { mime: 'image/webp', width: 1200, height: 675, inline_b64: 'U'.repeat(40) } } as Partial<LinkEmbed>);
    const job = { text, sent: [card()], late: [URL1], startedAt: 1_000, upload: null };
    function deps(row: { id: string; content?: unknown; send_state?: string } | null, final: PreparedEmbed | null = snap()) {
        const sent: EmbedsOnlyEdit[] = [];
        let t = 1_000;
        return {
            sent,
            d: {
                awaitFinal: vi.fn(async (_u: string, at: number) => { expect(at).toBe(1_000 + LATE_EMBED_WAIT_MS); return final; }),
                finalize: vi.fn(async () => [finalized]),
                findRow: () => row,
                send: async (e: EmbedsOnlyEdit) => { sent.push(e); },
                sleep: async (ms: number) => { t += ms; },
                now: () => t,
            },
        };
    }
    const delivered = { id: 'server-row-1', content: { type: 'text', text, client_msg_id: 'c1', embeds: [card()], font: 'mono' }, send_state: undefined };

    it('a snapshot that came late is attached by an embeds-only edit to the DELIVERED row (its server id), same text and font', async () => {
        const { d, sent } = deps(delivered);
        expect(await runLateAttach(job, d)).toBe('attached');
        expect(sent).toEqual([{ type: 'edit', target_id: 'server-row-1', text, font: 'mono', embeds: [finalized], embeds_only: true }]);
    });
    it('gives up without sending: nothing better, chat changed, never delivered, edited meanwhile, a preview removed', async () => {
        const cases: [ReturnType<typeof deps>, string][] = [
            [deps(delivered, null), 'nothing-better'],
            [deps(delivered, { url: URL1, embed: card() }), 'nothing-better'],
            [deps(null), 'moved-on'],
            [deps({ ...delivered, send_state: 'sending' }), 'undelivered'],
            [deps({ ...delivered, send_state: 'failed' }), 'undelivered'],
            [deps({ ...delivered, content: { ...delivered.content, text: `${text} edited` } }), 'changed'],
            [deps({ ...delivered, content: { ...delivered.content, embeds: [] } }), 'changed'],
        ];
        for (const [x, want] of cases) {
            expect(await runLateAttach(job, x.d)).toBe(want);
            expect(x.sent).toEqual([]);
        }
    });
});
