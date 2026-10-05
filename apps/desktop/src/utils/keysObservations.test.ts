import { describe, it, expect } from 'vitest';
import { pickObservation, pokeLine, sleepyLine, type KeysContext } from './keysObservations';
import {
    KEYS_QUIPS, KEYS_SLEEPY_POOL, KEYS_OBS_MENTIONS, KEYS_OBS_CALLS,
    KEYS_OBS_LATENIGHT, KEYS_OBS_NOBACKUP, KEYS_OBS_UNREADS, KEYS_OBS_QUIET,
    KEYS_OBS_FRIDAY, KEYS_OBS_SNOW, KEYS_OBS_EARLY,
} from './eggPools';

/** A boring Tuesday noon with everything fine — nothing to observe. */
const base: KeysContext = {
    hour: 12, dayOfWeek: 2, month: 5,
    mentions: 0, unreads: 0, friendsOnline: 2, friendsTotal: 4,
    callParticipants: 0, backupConfigured: true,
};

describe('pickObservation priority', () => {
    it('nothing notable → null (caller falls back to the generic pool)', () => {
        expect(pickObservation(base, 0)).toBeNull();
    });

    it('mentions outrank everything', () => {
        const line = pickObservation({ ...base, mentions: 2, callParticipants: 9, hour: 3, backupConfigured: false }, 0);
        expect(KEYS_OBS_MENTIONS).toContain(line);
    });

    it('calls outrank the clock, and the count is filled in', () => {
        const line = pickObservation({ ...base, callParticipants: 3, hour: 3 }, 0)!;
        expect(KEYS_OBS_CALLS.some(t => t.replace(/\{n\}/g, '3') === line)).toBe(true);
        expect(line).not.toContain('{n}');
    });

    it('deep night beats the backup nag; early morning sits below it', () => {
        expect(KEYS_OBS_LATENIGHT).toContain(pickObservation({ ...base, hour: 2, backupConfigured: false }, 0));
        expect(KEYS_OBS_NOBACKUP).toContain(pickObservation({ ...base, hour: 6, backupConfigured: false }, 0));
        expect(KEYS_OBS_EARLY).toContain(pickObservation({ ...base, hour: 6 }, 0));
    });

    it('unreads speak at 5+, with the count', () => {
        expect(pickObservation({ ...base, unreads: 4 }, 0)).toBeNull();
        const line = pickObservation({ ...base, unreads: 7 }, 1)!;
        expect(KEYS_OBS_UNREADS.some(t => t.replace(/\{n\}/g, '7') === line)).toBe(true);
    });

    it('quiet needs friends to exist but none online and nothing unread', () => {
        expect(KEYS_OBS_QUIET).toContain(pickObservation({ ...base, friendsOnline: 0 }, 0));
        expect(pickObservation({ ...base, friendsOnline: 0, friendsTotal: 0 }, 0)).toBeNull();
    });

    it('calendar small talk: December snow beats Friday', () => {
        expect(KEYS_OBS_SNOW).toContain(pickObservation({ ...base, month: 11, dayOfWeek: 5, friendsOnline: 1 }, 0));
        expect(KEYS_OBS_FRIDAY).toContain(pickObservation({ ...base, dayOfWeek: 5 }, 0));
    });

    it('rotation: consecutive seqs never repeat a line within a pool', () => {
        const a = pickObservation({ ...base, mentions: 1 }, 0);
        const b = pickObservation({ ...base, mentions: 1 }, 1);
        expect(a).not.toBe(b);
    });
});

describe('pokeLine + sleepyLine', () => {
    it('poke 1 prefers an observation; later speaking pokes go generic', () => {
        const ctx = { ...base, mentions: 1 };
        expect(KEYS_OBS_MENTIONS).toContain(pokeLine(ctx, 1, 0));
        expect(KEYS_QUIPS).toContain(pokeLine(ctx, 4, 0));
    });

    it('poke 1 with nothing notable falls back to the generic pool', () => {
        expect(KEYS_QUIPS).toContain(pokeLine(base, 1, 2));
    });

    it('sleepy protest comes from its own pool', () => {
        expect(KEYS_SLEEPY_POOL).toContain(sleepyLine(0));
    });
});
