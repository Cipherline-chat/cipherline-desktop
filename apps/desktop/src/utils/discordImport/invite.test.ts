import { describe, it, expect } from 'vitest';
import { ADMINISTRATOR_BIT, BOT_PERMISSIONS, botPageUrl, buildInviteUrl } from './invite';
import * as invite from './invite';

describe('invite URL builder', () => {
    it('asks for Administrator (permissions=8), per the owner: the import reads private channels, roles and per-member overwrites', () => {
        expect(ADMINISTRATOR_BIT).toBe(8);
        expect(BOT_PERMISSIONS).toBe(8);
    });
    it('builds a guild-install authorize URL from the application id main derived from the token', () => {
        expect(buildInviteUrl('800000000000000900')).toBe('https://discord.com/oauth2/authorize?client_id=800000000000000900&scope=bot&permissions=8&integration_type=0');
    });
    it('refuses anything that is not a snowflake (nothing else can reach the URL)', () => {
        for (const bad of ['', 'abc', '123', ' 800000000000000001 ', '800000000000000001&scope=applications.commands', '../x', null, undefined, 5]) {
            expect(buildInviteUrl(bad)).toBeNull();
        }
    });
    it('there is no parser for a hand-typed application id any more (the root cause of "bot is not in any server")', () => {
        expect((invite as Record<string, unknown>).parseApplicationId).toBeUndefined();
    });
    it('bot page link goes to that application, or the portal home', () => {
        expect(botPageUrl('800000000000000900')).toBe('https://discord.com/developers/applications/800000000000000900/bot');
        expect(botPageUrl(null)).toBe('https://discord.com/developers/applications');
        expect(botPageUrl('x/../y')).toBe('https://discord.com/developers/applications');
    });
});

describe('"Watch a video" address (DISCORD_IMPORT_VIDEO_URL, opened with shell.openExternal through main)', () => {
    it('is the walkthrough video and passes the validator unchanged', () => {
        expect(invite.DISCORD_IMPORT_VIDEO_URL).toBe('https://www.youtube.com/watch?v=Cm_mfwcGLIU');
        expect(invite.videoUrlToOpen(invite.DISCORD_IMPORT_VIDEO_URL)).toBe(invite.DISCORD_IMPORT_VIDEO_URL);
        expect(invite.videoUrlToOpen('')).toBeNull(); // empty still hides the card
    });
    it('accepts https links on youtube.com, www.youtube.com and youtu.be, returning the parsed href', () => {
        expect(invite.videoUrlToOpen('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
        expect(invite.videoUrlToOpen('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s');
        expect(invite.videoUrlToOpen('  https://youtu.be/dQw4w9WgXcQ  ')).toBe('https://youtu.be/dQw4w9WgXcQ');
        expect(invite.videoUrlToOpen('https://YouTu.be/dQw4w9WgXcQ')).toBe('https://youtu.be/dQw4w9WgXcQ');
    });
    it('refuses every other scheme, host, credentials, port, control characters and non-strings', () => {
        for (const bad of [
            'http://www.youtube.com/watch?v=x', 'ftp://youtube.com/x', 'javascript:alert(1)', 'file:///etc/passwd',
            'https://evil.example/watch?v=x', 'https://youtube.com.evil.example/x', 'https://m.youtube.com/watch?v=x',
            'https://youtube-nocookie.com/embed/x', 'https://user:pw@youtube.com/x', 'https://youtube.com@evil.example/x',
            'https://youtube.com:8443/x', 'https://youtu.be/x\nhttps://evil.example', 'https://you tube.com/x',
            'youtube.com/watch?v=x', '', `https://youtu.be/${'a'.repeat(400)}`, null, undefined, 42, {},
        ]) expect(invite.videoUrlToOpen(bad)).toBeNull();
    });
});
