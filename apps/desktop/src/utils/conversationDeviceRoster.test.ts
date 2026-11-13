import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { hasConversationDeviceRoster } from './conversationDeviceRoster';

describe('hasConversationDeviceRoster', () => {
    it('DMs and groups have a roster', () => {
        expect(hasConversationDeviceRoster({ id: 'c1', type: 'dm' })).toBe(true);
        expect(hasConversationDeviceRoster({ id: 'c1', type: 'group' })).toBe(true);
        expect(hasConversationDeviceRoster({ id: 'c1' })).toBe(true);
    });
    it('a server channel shown as a chat does not (its id is a channel id)', () => {
        expect(hasConversationDeviceRoster({ id: '506b825c', type: 'channel' })).toBe(false);
    });
    it('no chat / no id -> no roster', () => {
        expect(hasConversationDeviceRoster(null)).toBe(false);
        expect(hasConversationDeviceRoster(undefined)).toBe(false);
        expect(hasConversationDeviceRoster({ id: '', type: 'dm' })).toBe(false);
    });
});

// ChatPane is too heavy to mount here; pin the wiring instead. Both effects
// that fetch the roster for the OPEN chat must consult the predicate first
// (these were the two callers that fired for channels).
describe('ChatPane wiring', () => {
    const src = readFileSync(new URL('../components/ChatPane.tsx', import.meta.url), 'utf8');
    it('the deviceId->username effect returns early for a chat without a roster', () => {
        const at = src.indexOf('axios.get(apiUrl`/conversations/${cid}/devices`,');
        expect(at).toBeGreaterThan(0);
        expect(src.slice(at - 600, at)).toMatch(/if \([^\n]*!hasConversationDeviceRoster\(\{ id: activeChat\.id, type: activeChat\.type \}\)\) return;/);
    });
    it('the avatar-refresh effect skips the roster fetch for a chat without one', () => {
        const at = src.indexOf('axios.get(apiUrl`/conversations/${activeChat.id}/devices`,');
        expect(at).toBeGreaterThan(0);
        expect(src.slice(at - 400, at)).toMatch(/if \(!hasRoster\) return;/);
        expect(src).toMatch(/const hasRoster = hasConversationDeviceRoster\(\{ id: activeChat\.id, type: activeChat\.type \}\);/);
    });
});
