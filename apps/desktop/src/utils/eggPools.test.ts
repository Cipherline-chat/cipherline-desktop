import { describe, it, expect } from 'vitest';
import {
    ALL_POOLS,
    CHANNEL_NAME_EGGS,
    CHANNEL_NAME_IMPATIENCE,
    ENCRYPTING_POOL,
    UPLOAD_STREAK_POOL,
    UPLOAD_STREAK_AT,
    channelNameEgg,
    pickEscalating,
    pickRotating,
    uploadLabel,
} from './eggPools';

/**
 * The personality doctrine (docs/personality.md), enforced as tests.
 *
 * The catalog drifted out of sync with the code once already — eggs documented
 * as shipped that no component implemented, and pools that shipped under the
 * minimum line count. These tests close the half of that gap a machine can
 * check: any pool added to ALL_POOLS is held to rules 3 and 4 automatically,
 * whether or not the author remembers to test it.
 */

describe('doctrine rule 3 — a pool needs at least three lines', () => {
    it.each(Object.entries(ALL_POOLS))('%s has ≥3 lines', (_name, pool) => {
        expect(pool.length).toBeGreaterThanOrEqual(3);
    });

    // Rule 3's actual intent: "never the same line twice."
    it.each(Object.entries(ALL_POOLS))('%s has no duplicate lines', (_name, pool) => {
        expect(new Set(pool).size).toBe(pool.length);
    });

    it.each(Object.entries(ALL_POOLS))('%s has no empty lines', (_name, pool) => {
        for (const line of pool) expect(line.trim()).not.toBe('');
    });
});

describe('doctrine rule 4 — banned vocabulary', () => {
    // "sealed" is banned outright, along with any phrasing that dresses
    // encryption up as ritual. The retired list exists because these shipped
    // once already ("Server sealed. Go be weird together.").
    it.each(Object.entries(ALL_POOLS))('%s never says "sealed"', (_name, pool) => {
        for (const line of pool) expect(line).not.toMatch(/\bseal(ed|s|ing)?\b/i);
    });
});

describe('pickRotating', () => {
    it('cycles and never repeats on consecutive seq', () => {
        const pool = ['a', 'b', 'c'] as const;
        const seen = [0, 1, 2, 3, 4].map(i => pickRotating(pool, i));
        expect(seen).toEqual(['a', 'b', 'c', 'a', 'b']);
        for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    });

    it('handles a negative seq without going out of bounds', () => {
        expect(pickRotating(['a', 'b', 'c'], -1)).toBe('c');
    });
});

describe('pickEscalating', () => {
    it('walks the pool then stays on the last line', () => {
        const pool = ['one', 'two', 'three'] as const;
        expect([0, 1, 2, 3, 99].map(i => pickEscalating(pool, i)))
            .toEqual(['one', 'two', 'three', 'three', 'three']);
    });

    it('clamps a negative step to the first line', () => {
        expect(pickEscalating(['one', 'two'], -5)).toBe('one');
    });
});

describe('channelNameEgg', () => {
    it('matches the four catalog names', () => {
        for (const name of Object.keys(CHANNEL_NAME_EGGS)) {
            expect(channelNameEgg(name, 0)).not.toBeNull();
        }
    });

    it('normalizes the way people actually type', () => {
        expect(channelNameEgg('General', 0)).not.toBeNull();
        expect(channelNameEgg('#general', 0)).not.toBeNull();
        expect(channelNameEgg('  general  ', 0)).not.toBeNull();
        expect(channelNameEgg('##General ', 0)).not.toBeNull();
        // spaces become the hyphens the name will end up with anyway
        expect(channelNameEgg('  ', 0)).toBeNull();
    });

    it('does not match a name that merely contains a trigger word', () => {
        expect(channelNameEgg('generalist', 0)).toBeNull();
        expect(channelNameEgg('general-chat', 0)).toBeNull();
        expect(channelNameEgg('randomize', 0)).toBeNull();
    });

    it('returns null for an empty or unknown name', () => {
        expect(channelNameEgg('', 0)).toBeNull();
        expect(channelNameEgg('dev-team', 0)).toBeNull();
    });

    it('rotates within a matched pool', () => {
        const a = channelNameEgg('general', 0);
        const b = channelNameEgg('general', 1);
        expect(a).not.toBe(b);
    });
});

describe('uploadLabel', () => {
    it('is deterministic per filename below the streak threshold', () => {
        // The shipped implementation hashed the filename precisely so a
        // re-render mid-upload could not reroll the line.
        for (const streak of [0, 1, 2]) {
            expect(uploadLabel('holiday.png', streak)).toBe(uploadLabel('holiday.png', streak));
        }
        expect(ENCRYPTING_POOL).toContain(uploadLabel('holiday.png', 0));
    });

    it('switches to the streak pool from the third upload on', () => {
        expect(UPLOAD_STREAK_POOL).toContain(uploadLabel('a.png', UPLOAD_STREAK_AT));
        expect(UPLOAD_STREAK_POOL).toContain(uploadLabel('a.png', UPLOAD_STREAK_AT + 1));
    });

    it('escalates through the streak pool and holds at the last line', () => {
        expect(uploadLabel('a.png', UPLOAD_STREAK_AT)).toBe(UPLOAD_STREAK_POOL[0]);
        expect(uploadLabel('a.png', UPLOAD_STREAK_AT + 1)).toBe(UPLOAD_STREAK_POOL[1]);
        expect(uploadLabel('a.png', UPLOAD_STREAK_AT + 999))
            .toBe(UPLOAD_STREAK_POOL[UPLOAD_STREAK_POOL.length - 1]);
    });

    it('ignores the filename once the streak has taken over', () => {
        expect(uploadLabel('a.png', UPLOAD_STREAK_AT)).toBe(uploadLabel('zzzz.pdf', UPLOAD_STREAK_AT));
    });

    it('does not crash on an empty filename', () => {
        expect(typeof uploadLabel('', 0)).toBe('string');
    });
});

describe('channel-name impatience placeholders', () => {
    // Rule 5: an egg may not cost the user anything. This placeholder still
    // has to read as a usable channel-name suggestion.
    it('are all valid channel names', () => {
        for (const line of CHANNEL_NAME_IMPATIENCE) {
            expect(line).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        }
    });
});
