import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    FIRST_TODAY_CHANCE, FIRST_TODAY_LINES, RARE_SEND_CHIME_CHANCE, RARE_SEND_LINE_CHANCE, RARE_SEND_LINES,
    pickLine, rollRare,
} from './composerFun';

describe('rare composer touches', () => {
    it('the odds are what the docs say', () => {
        expect(FIRST_TODAY_CHANCE).toBe(1 / 8);
        expect(RARE_SEND_LINE_CHANCE).toBe(1 / 400);
        expect(RARE_SEND_CHIME_CHANCE).toBe(1 / 900);
    });

    it('rollRare: under the chance hits, at or over it misses', () => {
        expect(rollRare(0.25, () => 0.24)).toBe(true);
        expect(rollRare(0.25, () => 0.25)).toBe(false);
    });

    it('rollRare comes out near its odds over many days', () => {
        let seed = 1;
        const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
        let hits = 0;
        for (let i = 0; i < 80000; i++) if (rollRare(FIRST_TODAY_CHANCE, rand)) hits++;
        expect(hits / 80000).toBeGreaterThan(0.115);
        expect(hits / 80000).toBeLessThan(0.135);
    });

    it('pickLine reaches every line and never runs off the end', () => {
        expect(pickLine(RARE_SEND_LINES, () => 0)).toBe(RARE_SEND_LINES[0]);
        expect(pickLine(RARE_SEND_LINES, () => 0.9999)).toBe(RARE_SEND_LINES[RARE_SEND_LINES.length - 1]);
        expect(FIRST_TODAY_LINES).toContain(pickLine(FIRST_TODAY_LINES));
    });
});

describe('wiring', () => {
    const src = readFileSync(join(__dirname, '..', 'components/ChatPane.tsx'), 'utf8');

    it('the day is claimed before the dice, so a miss cannot re-roll on the next send', () => {
        expect(src).toContain('if (claimFirstSendOfDay(now) && rollRare(FIRST_TODAY_CHANCE)) {');
    });

    it('at most one rare touch a session, and never over another line', () => {
        expect(src).toContain('if (!line && !rareSendFired.current) {');
    });
});
