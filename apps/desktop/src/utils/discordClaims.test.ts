// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
    CLAIMS_UNAVAILABLE_MESSAGE, ackDiscordMovedNotice, claimErrorMessage, fetchDiscordLink, importerLabel, isOurDiscordStartUrl, messageCountLabel, parseSeen,
    pendingClaimNotices, parseGrants, claimContentsLabel, type ClaimableAuthor,
} from './discordClaims';

const API = 'https://api.cipherline.chat/v1';
const STATE = 'A'.repeat(43);

const axiosErr = (status: number, data: unknown = {}) => Object.assign(new Error('x'), { isAxiosError: true, response: { status, data } });

const author = (over: Partial<ClaimableAuthor> = {}): ClaimableAuthor => ({
    author_id: 'a1', server_id: 's1', server_name: 'Old Guild', claimed: false, claim_source: null, claimed_at: null,
    message_count: 3, imports: [], member: true, grants: null, ...over,
});

describe('fetchDiscordLink / ackDiscordMovedNotice (phase 3b, the link move)', () => {
    it('moved_away_at only when NOT linked and a real date; nothing else about the other account is read', async () => {
        const axios = (await import('axios')).default;
        const get = vi.spyOn(axios, 'get');
        const del = vi.spyOn(axios, 'delete').mockResolvedValue({ data: { ok: true } } as never);
        const at = '2026-11-21T18:30:00.000Z';
        get.mockResolvedValueOnce({ data: { available: true, linked: false, auto_claim: true, verified_at: null, moved_away_at: at, to_user: 'x' } } as never);
        const s = await fetchDiscordLink('jwt');
        expect(s).toEqual({ available: true, linked: false, auto_claim: true, verified_at: null, moved_away_at: at });
        get.mockResolvedValueOnce({ data: { available: true, linked: true, moved_away_at: at } } as never);
        expect((await fetchDiscordLink('jwt')).moved_away_at).toBeNull();
        get.mockResolvedValueOnce({ data: { available: true, linked: false, moved_away_at: 'soon' } } as never);
        expect((await fetchDiscordLink('jwt')).moved_away_at).toBeNull();
        await ackDiscordMovedNotice('jwt');
        expect(del.mock.calls[0][0]).toMatch(/\/discord\/link\/moved-notice$/);
        get.mockRestore(); del.mockRestore();
    });
});

describe('isOurDiscordStartUrl: only OUR sign-in start page is ever opened', () => {
    it('accepts the exact start URL on the API host', () => {
        expect(isOurDiscordStartUrl(`https://api.cipherline.chat/v1/discord/oauth/start?state=${STATE}`, API)).toBe(true);
    });
    it.each([
        ['http (downgrade)', `http://api.cipherline.chat/v1/discord/oauth/start?state=${STATE}`],
        ['another host', `https://evil.example/v1/discord/oauth/start?state=${STATE}`],
        ['a look-alike host', `https://api.cipherline.chat.evil.example/v1/discord/oauth/start?state=${STATE}`],
        ['Discord directly (skips the browser binding)', `https://discord.com/oauth2/authorize?state=${STATE}`],
        ['another path', `https://api.cipherline.chat/v1/steam/openid/start?state=${STATE}`],
        ['extra params', `https://api.cipherline.chat/v1/discord/oauth/start?state=${STATE}&next=https://evil.example`],
        ['a short state', 'https://api.cipherline.chat/v1/discord/oauth/start?state=abc'],
        ['credentials in the URL', `https://u:p@api.cipherline.chat/v1/discord/oauth/start?state=${STATE}`],
        ['a fragment', `https://api.cipherline.chat/v1/discord/oauth/start?state=${STATE}#x`],
        ['javascript:', 'javascript:alert(1)'],
        ['not a string', 42],
    ])('refuses %s', (_label, url) => {
        expect(isOurDiscordStartUrl(url, API)).toBe(false);
    });
});

describe('claimErrorMessage', () => {
    it('503 = the clear "not available yet" line (the server fails closed)', () => {
        expect(claimErrorMessage(axiosErr(503, { message: 'internal detail' }), 'fallback')).toBe(CLAIMS_UNAVAILABLE_MESSAGE);
    });
    it('a 4xx shows the server message; a 5xx or non-HTTP error shows the fallback', () => {
        expect(claimErrorMessage(axiosErr(403, { message: 'These messages do not belong to your linked Discord account.' }), 'fb'))
            .toBe('These messages do not belong to your linked Discord account.');
        expect(claimErrorMessage(axiosErr(500, { message: 'stack trace' }), 'fb')).toBe('fb');
        expect(claimErrorMessage(new Error('boom'), 'fb')).toBe('fb');
        expect(claimErrorMessage(axiosErr(429), 'fb')).toMatch(/Too many/);
    });
});

describe('pendingClaimNotices: which notices to raise', () => {
    it('an unseen AUTO claim -> "now show as you"; an unseen claimable in a server you are in -> "you can claim"', () => {
        const auto = author({ author_id: 'auto', claimed: true, claim_source: 'auto' });
        const can = author({ author_id: 'can' });
        expect(pendingClaimNotices([auto, can], new Set()).map(n => [n.kind, n.author.author_id])).toEqual([['auto', 'auto'], ['claimable', 'can']]);
    });
    it('never for: an acknowledged one, a manual claim, a claimable outside your servers, an author with no messages left', () => {
        const list = [
            author({ author_id: 'seen', claimed: true, claim_source: 'auto' }),
            author({ author_id: 'manual', claimed: true, claim_source: 'manual' }),
            author({ author_id: 'outside', member: false }),
            author({ author_id: 'empty', claimed: true, claim_source: 'auto', message_count: 0 }),
        ];
        expect(pendingClaimNotices(list, new Set(['seen']))).toEqual([]);
    });
    it('parseSeen tolerates junk and keeps only strings', () => {
        expect([...parseSeen('["a",1,"b"]')]).toEqual(['a', 'b']);
        expect(parseSeen('{oops').size).toBe(0);
        expect(parseSeen(null).size).toBe(0);
        expect(parseSeen('{"a":1}').size).toBe(0);
    });
});

describe('labels', () => {
    it('importer and counts', () => {
        expect(importerLabel({ import_id: 'i', imported_at: '', importer: { user_id: 'u', username: 'admin', discriminator: 7 } })).toBe('@admin#0007');
        expect(importerLabel({ import_id: 'i', imported_at: '', importer: { user_id: 'u', username: 'admin', discriminator: null } })).toBe('@admin');
        expect(importerLabel({ import_id: 'i', imported_at: '', importer: null })).toBe('a former member');
        expect(messageCountLabel(1)).toBe('1 message');
        expect(messageCountLabel(1200)).toBe('1,200 messages');
    });
});

describe('imported grants (D5b): roles / channel permissions / nickname / ban the claim brings', () => {
    const raw = { roles: [{ role_id: 'r1', name: 'Boss', color: 0xff0000, position: 3000, administrator: true, state: 'pending' }, { role_id: 'x' }],
        overrides: 2, nickname: 'Sammy', banned: false, granted_by: { user_id: 'u', username: 'owner', discriminator: null }, granted_at: '2026-11-22T00:00:00Z', given: false };
    it('parses what the server says; junk roles dropped; nothing at all -> null', () => {
        const g = parseGrants(raw)!;
        expect(g.roles.map(r => [r.name, r.administrator])).toEqual([['Boss', true]]);
        expect(g).toMatchObject({ overrides: 2, nickname: 'Sammy', banned: false });
        expect(parseGrants({ roles: [], overrides: 0 })).toBeNull();
        expect(parseGrants('x')).toBeNull();
    });
    it('a person with roles but NO messages still gets a notice (it used to be skipped as "no messages left")', () => {
        const rolesOnly = author({ author_id: 'r', message_count: 0, grants: parseGrants(raw) });
        expect(pendingClaimNotices([rolesOnly], new Set()).map(n => n.kind)).toEqual(['claimable']);
        expect(pendingClaimNotices([author({ author_id: 'z', message_count: 0 })], new Set())).toEqual([]); // positive control
    });
    it('labels: "2 roles" for roles only, "3 messages · 2 roles" for both', () => {
        const g = { ...parseGrants(raw)!, roles: [...parseGrants(raw)!.roles, { ...parseGrants(raw)!.roles[0], role_id: 'r2', name: 'Mods' }] };
        expect(claimContentsLabel({ message_count: 0, grants: g })).toBe('2 roles');
        expect(claimContentsLabel({ message_count: 3, grants: g })).toBe('3 messages · 2 roles');
        expect(claimContentsLabel({ message_count: 3, grants: null })).toBe('3 messages');
    });
});

