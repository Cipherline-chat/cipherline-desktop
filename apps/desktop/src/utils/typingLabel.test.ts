import { describe, it, expect } from 'vitest';
import { typingLabel, TYPING_EVERYONE, TYPING_SEVERAL } from './typingLabel';

const names = (n: number) => Array.from({ length: n }, (_, i) => `User${i + 1}`);

describe('typingLabel', () => {
    it('is empty when nobody is typing', () => {
        expect(typingLabel([])).toBe('');
    });

    it('names one, two and three people', () => {
        expect(typingLabel(['Ada'])).toBe('Ada is typing…');
        expect(typingLabel(['Ada', 'Bo'])).toBe('Ada and Bo are typing…');
        expect(typingLabel(['Ada', 'Bo', 'Cy'])).toBe('Ada, Bo, and Cy are typing…');
    });

    it('says "Several people" from four up to seven', () => {
        for (const n of [4, 5, 6, 7]) expect(typingLabel(names(n)), String(n)).toBe(TYPING_SEVERAL);
        expect(TYPING_SEVERAL).toBe('Several people are typing…');
    });

    it('says "Everyone" from eight, however many more there are', () => {
        for (const n of [8, 9, 20, 150]) expect(typingLabel(names(n)), String(n)).toBe(TYPING_EVERYONE);
        expect(TYPING_EVERYONE).toBe('Everyone is typing. Brace yourself.');
    });

    it('says "Everyone" for the whole of a small room (4+ typing and nobody else left)', () => {
        expect(typingLabel(names(4), 4)).toBe(TYPING_EVERYONE);
        expect(typingLabel(names(5), 5)).toBe(TYPING_EVERYONE);
        expect(typingLabel(names(6), 5)).toBe(TYPING_EVERYONE); // roster briefly behind the typing set
    });

    it('does not say "Everyone" while someone in the room is not typing', () => {
        expect(typingLabel(names(4), 5)).toBe(TYPING_SEVERAL);
        expect(typingLabel(names(7), 40)).toBe(TYPING_SEVERAL);
    });

    it('keeps names for one to three even when they are everyone', () => {
        expect(typingLabel(['Ada', 'Bo', 'Cy'], 3)).toBe('Ada, Bo, and Cy are typing…');
        expect(typingLabel(['Ada'], 1)).toBe('Ada is typing…');
    });

    it('ignores an unknown or empty room size', () => {
        expect(typingLabel(names(5), undefined)).toBe(TYPING_SEVERAL);
        expect(typingLabel(names(5), 0)).toBe(TYPING_SEVERAL);
    });
});
