import { describe, it, expect, beforeEach } from 'vitest';
import {
    setCallParticipantSpeaking, clearCallSpeaking, isCallParticipantSpeaking,
    subscribeCallParticipantSpeaking, __callSpeakingListenerCount,
} from './callSpeakingStore';

/**
 * A speaking flip must notify ONLY the subscribers for that identity (the
 * whole point: one ring re-renders, not the server panel), never notify on a
 * no-op, and clearing must reach everyone who was speaking.
 */
describe('callSpeakingStore', () => {
    beforeEach(() => clearCallSpeaking());

    it('notifies only the flipped identity, and only on a real change', () => {
        const hits: string[] = [];
        const ua = subscribeCallParticipantSpeaking('a', () => hits.push('a'));
        const ub = subscribeCallParticipantSpeaking('b', () => hits.push('b'));
        setCallParticipantSpeaking('a', true);
        setCallParticipantSpeaking('a', true); // no-op
        setCallParticipantSpeaking('a', false);
        setCallParticipantSpeaking('c', false); // never spoke: no-op
        expect(hits).toEqual(['a', 'a']);
        expect(isCallParticipantSpeaking('a')).toBe(false);
        ua(); ub();
        expect(__callSpeakingListenerCount()).toBe(0);
    });

    it('clear notifies everyone who was speaking and resets them', () => {
        const hits: string[] = [];
        subscribeCallParticipantSpeaking('a', () => hits.push('a'));
        subscribeCallParticipantSpeaking('b', () => hits.push('b'));
        subscribeCallParticipantSpeaking('c', () => hits.push('c'));
        setCallParticipantSpeaking('a', true);
        setCallParticipantSpeaking('b', true);
        hits.length = 0;
        clearCallSpeaking();
        expect(hits.sort()).toEqual(['a', 'b']);
        expect(isCallParticipantSpeaking('a') || isCallParticipantSpeaking('b')).toBe(false);
    });
});
