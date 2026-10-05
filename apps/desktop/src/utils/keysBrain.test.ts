import { describe, it, expect } from 'vitest';
import {
    INITIAL_BRAIN, onPoke, onWake, onRest, applySignal, shouldArmRest,
    nextBlinkDelay, browPath, BROWS, type BrainState,
} from './keysBrain';

function pokeTimes(n: number): BrainState {
    let s = INITIAL_BRAIN;
    for (let i = 0; i < n; i++) s = onPoke(s);
    return s;
}

describe('keysBrain mood machine', () => {
    it('pokes 1-5 are happy, 6-8 sleepy, 9+ asleep', () => {
        expect(pokeTimes(1).mood).toBe('happy');
        expect(pokeTimes(5).mood).toBe('happy');
        expect(pokeTimes(6).mood).toBe('sleepy');
        expect(pokeTimes(8).mood).toBe('sleepy');
        expect(pokeTimes(9).mood).toBe('asleep');
        expect(pokeTimes(20).mood).toBe('asleep');
    });

    it('hover wakes sleepy and asleep, resets the count; awake/happy untouched', () => {
        expect(onWake(pokeTimes(7))).toEqual({ mood: 'awake', pokes: 0 });
        expect(onWake(pokeTimes(10))).toEqual({ mood: 'awake', pokes: 0 });
        const happy = pokeTimes(2);
        expect(onWake(happy)).toBe(happy);
        expect(onWake(INITIAL_BRAIN)).toBe(INITIAL_BRAIN);
    });

    it('the rest timer settles happy/sleepy to awake but never ends a nap', () => {
        expect(onRest(pokeTimes(3))).toEqual({ mood: 'awake', pokes: 0 });
        expect(onRest(pokeTimes(7))).toEqual({ mood: 'awake', pokes: 0 });
        const asleep = pokeTimes(9);
        expect(onRest(asleep)).toBe(asleep);
    });

    it('alert signal wakes a sleeping Keys; other signals never touch mood', () => {
        expect(applySignal(pokeTimes(9), 'alert')).toEqual({ mood: 'awake', pokes: 0 });
        const asleep = pokeTimes(9);
        expect(applySignal(asleep, 'pulse')).toBe(asleep);
        expect(applySignal(asleep, 'idle')).toBe(asleep);
        const happy = pokeTimes(2);
        expect(applySignal(happy, 'alert')).toBe(happy);
    });

    it('rest timer arms for happy/sleepy only', () => {
        expect(shouldArmRest(pokeTimes(1))).toBe(true);
        expect(shouldArmRest(pokeTimes(7))).toBe(true);
        expect(shouldArmRest(pokeTimes(9))).toBe(false);
        expect(shouldArmRest(INITIAL_BRAIN)).toBe(false);
    });
});

describe('pokeReaction ladder', () => {
    it('escalates wiggle → hop → flail → spin → squish, then drowsy, then nothing', async () => {
        const { pokeReaction } = await import('./keysBrain');
        expect([1, 2, 3, 4, 5].map(pokeReaction)).toEqual(['wiggle', 'hop', 'flail', 'spin', 'squish']);
        expect(pokeReaction(6)).toBe('stir');
        expect(pokeReaction(8)).toBe('stir');
        expect(pokeReaction(9)).toBe('none');
        expect(pokeReaction(30)).toBe('none');
    });

    it('speaks on pokes 1, 4 and the sleepy protest only — the squish stays silent', async () => {
        const { shouldSpeak } = await import('./keysBrain');
        expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(shouldSpeak))
            .toEqual([true, false, false, true, false, true, false, false, false]);
    });
});

describe('blink + brows', () => {
    it('blink delay spans [2600, 5800)', () => {
        expect(nextBlinkDelay(0)).toBe(2600);
        expect(nextBlinkDelay(0.999999)).toBeLessThan(5800);
        expect(nextBlinkDelay(0.5)).toBe(2600 + 1600);
    });

    it('brow generator matches the mark geometry', () => {
        expect(browPath(33.5, 40, 5)).toBe('M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5');
        expect(BROWS.happyL).toBe('M33.5 37 l3.75 -6 l3.75 6 l3.75 -6 l3.75 6');
        expect(BROWS.closedL.startsWith('M33.5 39 q')).toBe(true);
        // The sad sag is OfflineScreen's original downcast face, verbatim.
        expect(BROWS.sadL).toBe('M33.5 37 Q40 43.5 46.5 37');
        expect(BROWS.sadR).toBe('M61.5 37 Q68 43.5 74.5 37');
    });
});
