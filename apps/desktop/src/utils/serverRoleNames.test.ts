import { describe, it, expect } from 'vitest';
import { roleNameDraftError, serverNameDraftError, nameCounter, ROLE_NAME_INPUT_MAX_UNITS } from './serverRoleNames';
import { serverAbbreviation, serverInitial } from './serverAbbreviation';
import { rankMentionCandidates, foldForMatch, type MentionMatchable } from './mentionSuggestions';
import { mentionTokenLabel, parseMentionToken, findMentionTokens } from './mentionTokens';
import { buildWireText, tokenMapsFromWireText } from './composerWireText';
import { deriveMentionRoster } from './mentionRoster';
import { filterRolesByQuery } from '../components/server/roles/rolePickerModel';
import type { Roster } from './serverRosterCache';

describe('draft errors (inputs)', () => {
    it('empty draft is not an error (the button gates it)', () => {
        expect(serverNameDraftError('   ')).toBeNull();
        expect(roleNameDraftError('')).toBeNull();
    });
    it.each(['✦ ꒰ Moonlit ꒱ ✦', '🌙✨ Club', '『 Aesthetic 』', '𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬', 'ᴀᴇsᴛʜᴇᴛɪᴄ', 'Ⓐ Ⓔ'])('accepts %s', s => {
        expect(serverNameDraftError(s)).toBeNull();
        expect(roleNameDraftError(s)).toBeNull();
    });
    it('trims outer whitespace before judging', () => {
        expect(roleNameDraftError('  ☾ Night  ')).toBeNull();
    });
    it('reports hidden characters, never strips them', () => {
        expect(roleNameDraftError('a‮b')).toMatch(/hidden|direction/i);
        expect(serverNameDraftError('a​b')).not.toBeNull();
        expect(roleNameDraftError('à́̂̃̄')).toMatch(/stacked/i);
    });
    it('server names need 2 graphemes', () => {
        expect(serverNameDraftError('✦')).not.toBeNull();
        expect(serverNameDraftError('🌙🌙')).toBeNull();
    });
    it('counter is in graphemes and the paste guard fits 50 maths letters', () => {
        expect(nameCounter('🌙✨', 50)).toBe('2/50');
        expect('𝓐'.repeat(50).length).toBeLessThanOrEqual(ROLE_NAME_INPUT_MAX_UNITS);
    });
});

describe('serverAbbreviation (no icon)', () => {
    it('plain names behave as before', () => {
        expect(serverAbbreviation('Moon Club')).toBe('MC');
        expect(serverAbbreviation('Moonlit')).toBe('MO');
        expect(serverAbbreviation('   ')).toBe('?');
    });
    it('never splits a surrogate pair', () => {
        expect(serverAbbreviation('🌙 Moon')).toBe('🌙M');
        expect(serverInitial('🌙 Moon')).toBe('🌙');
        expect(serverAbbreviation('𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬')).toBe('𝓐𝓮');
    });
    it('skips pure decoration when a real word exists', () => {
        expect(serverAbbreviation('✦ Moonlit Café ✦')).toBe('MC');
        expect(serverAbbreviation('『Aesthetic』')).toBe('AE');
        expect(serverAbbreviation('✦ ⋆ ☾')).toBe('✦⋆');
    });
});

describe('@role mentions with decorative names', () => {
    const fancy = '𝓐𝓮𝓼𝓽𝓱𝓮𝓽𝓲𝓬 ✦';
    const small = 'ᴀᴇsᴛʜᴇᴛɪᴄ';
    const cands: Array<MentionMatchable & { id: string }> = [
        { id: 'r1', type: 'role', label: fancy },
        { id: 'r2', type: 'role', label: small },
        { id: 'r3', type: 'role', label: '『 Mods 』' },
        { id: 'r4', type: 'role', label: 'Ⓐdmin' },
    ];
    it('plain typing finds styled-letter names (folding)', () => {
        expect(foldForMatch(fancy)).toBe('aesthetic ✦');
        expect(rankMentionCandidates(cands, 'aesth').map(c => c.id)).toEqual(['r1', 'r2']);
        expect(rankMentionCandidates(cands, 'mods').map(c => c.id)).toEqual(['r3']);
        expect(rankMentionCandidates(cands, 'admin').map(c => c.id)).toEqual(['r4']);
    });
    it('POSITIVE CONTROL: an ordinary role still matches', () => {
        expect(rankMentionCandidates([{ id: 'x', type: 'role', label: 'Mods' }], 'mo').map(c => c.id)).toEqual(['x']);
    });
    it('role-search in settings uses the same folding', () => {
        const roles = [{ name: fancy }, { name: 'Plain' }];
        expect(filterRolesByQuery(roles, 'aes')).toEqual([{ name: fancy }]);
        expect(filterRolesByQuery(roles, 'plain')).toEqual([{ name: 'Plain' }]);
    });

    const roster = (name: string): Roster => ({
        members: [], roles: [{ role_id: 'rid', name, color: 1, mentionable: true, is_everyone: false }],
    } as unknown as Roster);

    it('round trip: composer text -> wire token -> parsed label, for a fancy name', () => {
        const map = deriveMentionRoster(roster(fancy), null).tokenMap;
        const wire = buildWireText(`hey @${fancy} look`, map);
        expect(wire).toBe(`hey <@r:rid:${fancy}> look`);
        const tokens = findMentionTokens(wire);
        expect(tokens).toHaveLength(1);
        expect(parseMentionToken(tokens[0][0])).toEqual({ kind: 'role', id: 'rid', label: fancy });
        expect(tokenMapsFromWireText(wire).mentions[fancy]).toBe(`<@r:rid:${fancy}>`);
    });
    it('a role name containing ">" still yields a parseable token', () => {
        const name = '⇢> VIP';
        expect(mentionTokenLabel(name)).toBe('⇢› VIP');
        const map = deriveMentionRoster(roster(name), null).tokenMap;
        const wire = buildWireText(`@${name} hi`, map);
        expect(parseMentionToken(findMentionTokens(wire)[0][0])).toMatchObject({ kind: 'role', id: 'rid', label: '⇢› VIP' });
    });
    it('POSITIVE CONTROL: the raw name with ">" breaks the grammar (why the label is made safe)', () => {
        expect(parseMentionToken('<@r:rid:⇢> VIP>')).toBeNull();
    });
    it('a long emoji-sequence name is clipped on a grapheme boundary within the label bound', () => {
        const long = '👩🏽‍💻'.repeat(30); // 30 graphemes, 210 UTF-16 units
        const label = mentionTokenLabel(long);
        expect(label.length).toBeLessThanOrEqual(128);
        expect(label.length % 7).toBe(0);
        expect(parseMentionToken(`<@r:rid:${label}>`)).toMatchObject({ kind: 'role', label });
    });
    it('ordinary names are unchanged', () => {
        expect(mentionTokenLabel('Moderators')).toBe('Moderators');
    });
});
