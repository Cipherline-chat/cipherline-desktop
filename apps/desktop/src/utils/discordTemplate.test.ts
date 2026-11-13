import { describe, it, expect } from 'vitest';
import {
    buildPreviewTree,
    looksLikeTemplateLink,
    roleColorCss,
    rolesForDisplay,
    sanitizeServerNameInput,
    templateErrorMessage,
    type DiscordTemplatePreview,
} from './discordTemplate';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The API's real preview of discord.new/BX8jqYy8vu3y — kept in sync by
 *  apps/api discord-template.mapper.spec.ts. */
const preview = JSON.parse(readFileSync(
    fileURLToPath(new URL('./__fixtures__/discordTemplatePreview.BX8.json', import.meta.url)), 'utf8',
)) as DiscordTemplatePreview;

describe('looksLikeTemplateLink (UX mirror of the API parser)', () => {
    it.each([
        'BX8jqYy8vu3y',
        'https://discord.new/BX8jqYy8vu3y',
        'discord.new/BX8jqYy8vu3y',
        'https://discord.com/template/BX8jqYy8vu3y',
        'https://www.discord.com/template/BX8jqYy8vu3y/',
    ])('accepts %s', (s) => expect(looksLikeTemplateLink(s)).toBe(true));

    it.each([
        '',
        'http://discord.new/BX8jqYy8vu3y',
        'https://discord.com.evil.tld/template/BX8jqYy8vu3y',
        'https://discord.com@evil.tld/template/BX8jqYy8vu3y',
        'https://discord.gg/BX8jqYy8vu3y',
        'https://discord.new:444/BX8jqYy8vu3y',
        'https://discord.new/abc-def',
        'javascript:alert(1)',
        'not a link',
    ])('refuses %s', (s) => expect(looksLikeTemplateLink(s)).toBe(false));
});

describe('templateErrorMessage', () => {
    const axiosErr = (status: number, data: unknown) => ({ response: { status, data } });
    it.each([
        ['INVALID_TEMPLATE_LINK', 400, /doesn’t look like a Discord template link/],
        ['TEMPLATE_NOT_FOUND', 404, /doesn’t exist or was deleted/],
        ['DISCORD_UNREACHABLE', 502, /Couldn’t reach Discord/],
        ['TEMPLATE_UNREADABLE', 502, /couldn’t read/],
        ['DISCORD_BUSY', 503, /Discord is busy/],
    ])('maps %s', (code, status, re) => {
        expect(templateErrorMessage(axiosErr(status, { code, message: 'server text' }))).toMatch(re);
    });
    it('maps the throttle, validation, offline and unknown cases', () => {
        expect(templateErrorMessage(axiosErr(429, {}))).toMatch(/Too many tries/);
        expect(templateErrorMessage(axiosErr(400, { message: ['name must be longer'] }))).toBe('name must be longer');
        expect(templateErrorMessage(new Error('Network Error'))).toMatch(/Couldn’t reach Cipherline/);
        expect(templateErrorMessage(axiosErr(500, {}))).toMatch(/Something went wrong/);
    });
});

describe('buildPreviewTree', () => {
    it('arranges the fixture like the sidebar and Calls panel will', () => {
        const tree = buildPreviewTree(preview.blueprint);
        const flat = (groups: ReturnType<typeof buildPreviewTree>['text']) =>
            groups.map(g => [g.category?.name ?? '(none)', g.channels.map(c => c.name)]);
        expect(flat(tree.text)).toEqual([
            ['(none)', ['join_and_leave']],
            ['Primary Channels', ['general_chat', 'files_pictures', 'bot_commands']],
            ['Media', ['self_promotion', 'game_clips', 'yt_videos']],
            ['Special Channels', ['car_discussions', 'memes']],
            ['Voice Channels', ['music_commands']],
            ['Admin stuff', ['private_chat', 'logs']],
        ]);
        expect(flat(tree.calls)).toEqual([
            ['Voice Channels', ['New Channel']],
            ['Admin stuff', ['Private Voice']],
        ]);
    });

    it('lists roles most-powerful first with CSS colors', () => {
        expect(rolesForDisplay(preview.blueprint).map(r => [r.name, roleColorCss(r.color)])).toEqual([
            ['Admin', '#fc5353'],
            ['Bots', '#3498db'],
        ]);
        expect(roleColorCss(-1)).toBeNull();
        expect(roleColorCss(0)).toBeNull();
    });

    it('filters a typed server name to the plain-text rule', () => {
        expect(sanitizeServerNameInput('Fusion 🔥 Club!')).toBe('Fusion  Club');
    });
});
