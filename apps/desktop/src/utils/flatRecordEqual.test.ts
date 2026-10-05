import { describe, it, expect } from 'vitest';
import { flatRecordEqual } from './flatRecordEqual';

const st = (o: Partial<{ hasCamera: boolean; hasScreenShare: boolean; isSpeaking: boolean; isMuted: boolean }> = {}) =>
    ({ hasCamera: false, hasScreenShare: false, isSpeaking: false, isMuted: false, ...o });

describe('flatRecordEqual', () => {
    it('treats freshly built but identical snapshots as equal', () => {
        expect(flatRecordEqual({ a: st(), b: st({ isMuted: true }) }, { a: st(), b: st({ isMuted: true }) })).toBe(true);
        expect(flatRecordEqual({}, {})).toBe(true);
    });

    it('sees a single flag flip', () => {
        expect(flatRecordEqual({ a: st() }, { a: st({ isSpeaking: true }) })).toBe(false);
    });

    it('sees a participant joining, leaving, or being replaced by another identity', () => {
        expect(flatRecordEqual({ a: st() }, { a: st(), b: st() })).toBe(false);
        expect(flatRecordEqual({ a: st(), b: st() }, { a: st() })).toBe(false);
        expect(flatRecordEqual({ a: st() }, { b: st() })).toBe(false);
    });

    it('sees a field appearing or disappearing', () => {
        expect(flatRecordEqual({ a: { x: true } }, { a: { x: true, y: false } })).toBe(false);
        expect(flatRecordEqual({ a: { x: true, y: undefined } }, { a: { x: true, z: undefined } })).toBe(false);
    });

    it('handles null/undefined inputs', () => {
        expect(flatRecordEqual(null, null)).toBe(true);
        expect(flatRecordEqual(null, {})).toBe(false);
        expect(flatRecordEqual({}, undefined)).toBe(false);
    });

    it('compares nested values by identity (conservative: different object => changed)', () => {
        expect(flatRecordEqual({ a: { n: { v: 1 } } }, { a: { n: { v: 1 } } })).toBe(false);
    });
});
