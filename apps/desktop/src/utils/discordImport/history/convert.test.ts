import { describe, it, expect } from 'vitest';
import { convertDiscordText, importedMessageText, postingOrder, sizeLabel, ZWSP } from './convert';
import type { ImportMessage } from '../types';

const ctx = { roles: { '800000000000000003': 'Moderator' }, channels: { '800000000000000011': 'rules' }, emojiIds: { tractor: '9b0f6a1e-1111-4111-8111-111111111111' } };
const m = (o: Partial<ImportMessage> = {}): ImportMessage => ({
    id: '900000000000000100', ts: '2026-11-01T10:00:00.000Z', edited: false,
    author: { id: '900000000000000001', name: 'Alex', username: 'alex_92', kind: 'user', avatarRef: null },
    content: '', mentionNames: {}, replyTo: null, files: [], embeds: [], stickers: [], poll: null, pinned: false, ...o,
});

describe('Discord tokens become text; nothing can become a Cipherline mention or a ping', () => {
    it('user, role and channel mentions are plain text', () => {
        const out = convertDiscordText('hi <@900000000000000002> and <@!900000000000000002>, see <#800000000000000011>, ask <@&800000000000000003>', { mentionNames: { '900000000000000002': 'Sam' } }, ctx);
        expect(out).toBe('hi @Sam and @Sam, see #rules, ask @Moderator');
    });
    it('custom emoji: this server\'s imported emoji by name, else :name:', () => {
        expect(convertDiscordText('<:Tractor:800000000000000041> <a:party:800000000000000040>', { mentionNames: {} }, ctx))
            .toBe('<:Tractor:9b0f6a1e-1111-4111-8111-111111111111> :party:');
    });
    it('@everyone / @here are defused', () => {
        const out = convertDiscordText('@everyone look @here', { mentionNames: {} }, ctx);
        expect(out).toBe(`@${ZWSP}everyone look @${ZWSP}here`);
        expect(out.includes('@everyone')).toBe(false);
    });
    it('text typed to LOOK like a Cipherline mention token is defused', () => {
        const out = convertDiscordText('<@u:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:dawson> <@r:x:Mods> <#c:y:z>', { mentionNames: {} }, ctx);
        expect(out).not.toContain('<@u:');
        expect(out).not.toContain('<@r:');
        expect(out).not.toContain('<#c:');
    });
    it('timestamps are written out', () => {
        expect(convertDiscordText('<t:1700000000:D>', { mentionNames: {} }, ctx)).toBe('November 14, 2023 UTC');
    });
    it('markdown is kept as written (the grammar is shared)', () => {
        expect(convertDiscordText('**bold** _it_ ~~s~~ `c` ||spoiler|| > q', { mentionNames: {} }, ctx)).toBe('**bold** _it_ ~~s~~ `c` ||spoiler|| > q');
    });
});

describe('role / channel mentions as real ones (no ping), forwards', () => {
    const RID = '33333333-3333-4333-8333-333333333333';
    const CID = '44444444-4444-4444-8444-555555555555';
    const c2 = { ...ctx, roleIds: { '800000000000000003': RID }, channelIds: { '800000000000000011': CID } };
    it('maps a role to <@r:id:name> + a mentions entry, a channel to #name + channel_refs', () => {
        const sink = { mentions: [], channelRefs: [] } as { mentions: Array<{ type: 'role'; id: string }>; channelRefs: Array<{ id: string; name: string }> };
        const out = convertDiscordText('<@&800000000000000003> see <#800000000000000011>', { mentionNames: {} }, c2, sink);
        expect(out).toBe(`<@r:${RID}:Moderator> see #rules`);
        expect(sink.mentions).toEqual([{ type: 'role', id: RID }]);
        expect(sink.channelRefs).toEqual([{ id: CID, name: 'rules' }]);
    });
    it('without a mapping (or a sink) they stay plain text', () => {
        expect(convertDiscordText('<@&800000000000000003>', { mentionNames: {} }, ctx)).toBe('@Moderator');
        expect(convertDiscordText('<@&800000000000000003>', { mentionNames: {} }, c2)).toBe('@Moderator');
    });
    it('POSITIVE CONTROL: a token typed by a Discord user (even with a valid role id) is defused, only ours survives', () => {
        const sink = { mentions: [], channelRefs: [] };
        const out = convertDiscordText(`<@r:${RID}:x> <@&800000000000000003> \u0001 0\u0001 @everyone @here`, { mentionNames: {} }, c2, sink);
        expect(out.split(`<@r:${RID}:`)).toHaveLength(2); // exactly one real token
        expect(out).toContain(`<${ZWSP}@r:${RID}:x>`);
        expect(out).not.toMatch(/@(everyone|here)/);
    });
    it('a forward reads as a quoted block with a heading; its @everyone is defused', () => {
        const t = importedMessageText(m({ forwarded: { content: 'hi @everyone <@900000000000000002>', ts: '2026-10-01T00:00:00.000Z' }, mentionNames: { '900000000000000002': 'Sam' } }), ctx, [], false);
        expect(t).toContain('-# Forwarded message (originally Oct 1, 2026)');
        expect(t).toContain(`> hi @${ZWSP}everyone @Sam`);
    });
});

describe('the full imported text', () => {
    it('embeds as a quote, polls as results, stickers and notes as subtext, the missing-reply line first', () => {
        const t = importedMessageText(m({
            content: 'look',
            embeds: [{ title: 'Tomorrow', description: 'Sunny', url: null, fields: [{ name: 'Wind', value: '8 km/h' }], author: null, footer: 'FarmBot' }],
            poll: { question: 'Next crop?', answers: [{ text: 'Corn', votes: 4 }, { text: 'Beans', votes: 1 }] },
            stickers: ['wave'],
        }), ctx, ['File not imported: big.zip (3.0 GB, too large)'], true);
        expect(t.split('\n')[0]).toBe('-# Replying to a message that was not imported');
        expect(t).toContain('> **Tomorrow**\n> Sunny\n> **Wind**: 8 km/h\n> -# FarmBot');
        expect(t).toContain('**Poll: Next crop?**\n- Corn: 4 votes\n- Beans: 1 vote\n-# 5 votes in total');
        expect(t).toContain('-# Sticker: wave');
        expect(t).toContain('-# File not imported: big.zip (3.0 GB, too large)');
    });
    it('an embed link is only kept when it is https', () => {
        const t = importedMessageText(m({ embeds: [{ title: 'Site', description: null, url: 'javascript:alert(1)', fields: [], author: null, footer: null }] }), ctx, [], false);
        expect(t).not.toContain('javascript:');
    });
    it('sizes', () => { expect(sizeLabel(3 * 1024 ** 3)).toBe('3.0 GB'); expect(sizeLabel(2048)).toBe('2 KB'); });
});

describe('posting order (plan B4.2)', () => {
    it('pins older than the window first (oldest to newest), then the window; a pin inside the window posted once in place', () => {
        const w1 = m({ id: '1', ts: '2026-11-10T00:00:00.000Z' });
        const w2 = m({ id: '2', ts: '2026-11-11T00:00:00.000Z' });
        const oldPinA = m({ id: 'a', ts: '2026-08-01T00:00:00.000Z', pinned: true });
        const oldPinB = m({ id: 'b', ts: '2026-07-01T00:00:00.000Z', pinned: true });
        const inWindowPin = m({ id: '2', ts: '2026-11-11T00:00:00.000Z', pinned: true });
        const order = postingOrder([w1, w2], [inWindowPin, oldPinA, oldPinB]);
        expect(order.map(x => x.id)).toEqual(['b', 'a', '1', '2']);
        expect(order[3].pinned).toBe(true);
    });
});
