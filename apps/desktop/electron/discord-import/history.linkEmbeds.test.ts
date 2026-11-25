/**
 * Discord import, main side: the previews Discord made for links in a
 * person's message are handed over as `linkEmbeds` (the renderer maps them
 * into LinkEmbed, src/utils/discordImport/history/linkEmbeds.ts); bot / app
 * embeds keep the quoted-text path; the picture is Discord's copy (its media
 * hosts or its external-image proxy), never the linked site.
 */
import { describe, it, expect } from 'vitest';
import { checkEmbedProxyUrl } from './discord-client';
import { normalizeMessage, type MediaRegistry, type RawMessage } from './history';
import { MOCK_IDS, MOCK_TEXT_CHANNEL, PEOPLE } from './__fixtures__/mock-history';

describe('normalizeMessage: Discord\'s link previews (link embeds phase 4)', () => {
    const base = { id: MOCK_IDS.sf(901), type: 0, timestamp: new Date().toISOString(), author: PEOPLE.alex, mentions: [], attachments: [] };
    const article = {
        type: 'article', url: 'https://news.example/a', title: 'A headline', description: 'Body', color: 0xff4e00, provider: { name: 'News' }, author: { name: 'Someone' },
        thumbnail: { url: 'https://news.example/hero.jpg', proxy_url: 'https://images-ext-1.discordapp.net/external/AbC123/https/news.example/hero.jpg', width: 1200, height: 630 },
    };

    it('a link / article / video preview becomes a link preview (not quoted text), its picture Discord\'s proxy copy', () => {
        const reg: MediaRegistry = new Map();
        const n = normalizeMessage({ ...base, content: 'read https://news.example/a', embeds: [article] } as RawMessage, reg, MOCK_TEXT_CHANNEL)!;
        expect(n.embeds).toEqual([]);
        expect(n.files).toEqual([]);
        expect(n.linkEmbeds).toEqual([{
            url: 'https://news.example/a', type: 'article', title: 'A headline', description: 'Body', site: 'News', author: 'Someone', color: '#ff4e00',
            thumbRef: expect.stringMatching(/^[0-9a-f-]{36}$/), thumbWidth: 1200, thumbHeight: 630, videoUrl: null,
        }]);
        expect(new URL(reg.get(n.linkEmbeds![0].thumbRef!)!.url).hostname).toBe('images-ext-1.discordapp.net');
        // POSITIVE CONTROL: the linked site's own picture URL is never registered.
        expect([...reg.values()].some((e) => e.url.startsWith('https://news.example/'))).toBe(false);
    });

    it('a rich embed for a link in a person\'s words is a preview; a bot\'s rich embed (fields, footer) stays quoted text', () => {
        const tweet = { type: 'rich', url: 'https://x.com/jack/status/20', description: 'just setting up my twttr', author: { name: 'jack (@jack)' } };
        const person = normalizeMessage({ ...base, content: 'https://x.com/jack/status/20', embeds: [tweet] } as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!;
        expect(person.linkEmbeds?.map((e) => e.type)).toEqual(['rich']);
        expect(person.embeds).toEqual([]);
        const botEmbed = { type: 'rich', title: 'Daily stats', url: 'https://stats.example/', fields: [{ name: 'Users', value: '5' }], footer: { text: 'bot' } };
        const bot = normalizeMessage({ ...base, author: PEOPLE.farmbot, content: 'https://stats.example/', embeds: [botEmbed, tweet] } as RawMessage, new Map(), MOCK_TEXT_CHANNEL)!;
        expect(bot.linkEmbeds).toBeUndefined();
        expect(bot.embeds.map((e) => e.title)).toEqual(['Daily stats', null]);
    });

    it('a picture on a host that is neither Discord media nor its proxy: the preview comes over without one', () => {
        const reg: MediaRegistry = new Map();
        const n = normalizeMessage({ ...base, content: 'https://news.example/a', embeds: [{ ...article, thumbnail: { url: 'https://evil.example/x.png', proxy_url: 'https://evil.example/y.png' } }] } as RawMessage, reg, MOCK_TEXT_CHANNEL)!;
        expect(n.linkEmbeds?.[0].thumbRef).toBeNull();
        expect([...reg.values()].some((e) => e.url.includes('evil.example'))).toBe(false);
    });

    it('checkEmbedProxyUrl: the proxy hosts and the /external/ path only', () => {
        expect(checkEmbedProxyUrl('https://images-ext-2.discordapp.net/external/a_b/https/x.example/p.png?width=400&height=225')).not.toBeNull();
        for (const u of ['https://images-ext-1.discordapp.net/attachments/1/2/a.png', 'http://images-ext-1.discordapp.net/external/a', 'https://images-ext-1.discordapp.net.evil.example/external/a',
            'https://images-ext-1.discordapp.net/external/../x', 'https://images-ext-1.discordapp.net/external/a?redirect=https://evil.example']) {
            expect(checkEmbedProxyUrl(u), u).toBeNull();
        }
    });
});
