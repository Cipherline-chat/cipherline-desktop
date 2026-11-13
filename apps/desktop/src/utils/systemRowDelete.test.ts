import { describe, it, expect } from 'vitest';
import {
    systemRowDeleteMode, systemRowDeleteLabel, parseHiddenSystemRows, addHiddenSystemRow,
    hiddenSystemRowsKey, HIDDEN_SYSTEM_ROWS_CAP,
} from './systemRowDelete';
import { KV_RULES } from '../services/backupRegistry';

const persisted = { id: 'row-1', content: { type: 'system', kind: 'member_event', event: 'member_join', subject_user_id: 'u1', actor_user_id: null } };
const ephemeral = { id: 'legacy-sys:member_join:u1:1700000000000', content: persisted.content };
const groupLine = { id: 'system-1-abc', content: { type: 'system', text: 'A added B' } };
const placeholder = { id: 'p', content: { type: 'system', kind: 'encrypted', data: { reason: 'x' } } };
const mod = { canManageMessages: true, isServerChannel: true };
const plain = { canManageMessages: false, isServerChannel: true };

describe('systemRowDeleteLabel', () => {
    it('stored row reads "Delete message"; a client-only line reads as a local hide', () => {
        expect(systemRowDeleteLabel('server')).toBe('Delete message');
        expect(systemRowDeleteLabel('local')).toBe('Remove from my view');
    });
    it('owner/admin/mod (MANAGE_MESSAGES) get the server delete on a persisted row; a plain member gets nothing', () => {
        expect(systemRowDeleteMode(persisted, mod)).toBe('server');
        expect(systemRowDeleteMode(persisted, plain)).toBeNull();
    });
});

describe('systemRowDeleteMode', () => {
    it('persisted row: server delete only with MANAGE_MESSAGES', () => {
        expect(systemRowDeleteMode(persisted, mod)).toBe('server');
        expect(systemRowDeleteMode(persisted, plain)).toBeNull();
    });
    it('persisted row outside a server channel is never deletable', () => {
        expect(systemRowDeleteMode(persisted, { canManageMessages: true, isServerChannel: false })).toBeNull();
    });
    it('ephemeral and group text lines hide locally for any viewer', () => {
        for (const p of [mod, plain, { canManageMessages: false, isServerChannel: false }]) {
            expect(systemRowDeleteMode(ephemeral, p)).toBe('local');
            expect(systemRowDeleteMode(groupLine, p)).toBe('local');
        }
    });
    it('negative controls: placeholders, normal messages, junk', () => {
        expect(systemRowDeleteMode(placeholder, mod)).toBeNull();
        expect(systemRowDeleteMode({ id: 'm', content: { type: 'text', text: 'hi' } }, mod)).toBeNull();
        expect(systemRowDeleteMode({ id: 'e', content: { type: 'system', text: '' } }, mod)).toBeNull();
        expect(systemRowDeleteMode(null, mod)).toBeNull();
        expect(systemRowDeleteMode({ content: groupLine.content }, mod)).toBeNull();
    });
});

describe('hidden list persistence helpers', () => {
    it('round-trips, dedupes and caps', () => {
        let l: string[] = [];
        l = addHiddenSystemRow(l, 'a'); l = addHiddenSystemRow(l, 'b'); l = addHiddenSystemRow(l, 'a');
        expect(l).toEqual(['b', 'a']);
        expect(parseHiddenSystemRows(JSON.stringify(l))).toEqual(l);
        let big: string[] = [];
        for (let i = 0; i < HIDDEN_SYSTEM_ROWS_CAP + 5; i++) big = addHiddenSystemRow(big, `id${i}`);
        expect(big).toHaveLength(HIDDEN_SYSTEM_ROWS_CAP);
        expect(big[big.length - 1]).toBe(`id${HIDDEN_SYSTEM_ROWS_CAP + 4}`);
    });
    it('malformed storage reads as empty', () => {
        expect(parseHiddenSystemRows('{bad')).toEqual([]);
        expect(parseHiddenSystemRows('{"a":1}')).toEqual([]);
        expect(parseHiddenSystemRows(null)).toEqual([]);
        expect(parseHiddenSystemRows('[1,"x"]')).toEqual(['x']);
    });
});

describe('backupRegistry classification', () => {
    it('the hidden-rows key has an explicit rule', () => {
        const key = hiddenSystemRowsKey('USER');
        const hit = KV_RULES.find(r => r.pattern.replace('{uid}', 'USER') === key);
        expect(hit).toBeDefined();
    });
});
