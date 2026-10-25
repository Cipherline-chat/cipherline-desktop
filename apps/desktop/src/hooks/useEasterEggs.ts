import { useEffect, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';
import { LATE_NIGHT_PLACEHOLDERS, pickRotating } from '../utils/eggPools';
import { costumeEggFor, recordEggFound } from '../utils/eggProgress';
import {
    claimEgg, eggCount, noteEgg, costumeFor, isHalloween, birthdayYears,
    isLateNight, dayNumber,
    type Costume, type EggPolicy,
} from '../utils/easterEggs';

/**
 * Binding of utils/easterEggs.ts to the app's encrypted local store (the seen
 * ledger), plus the calendar / clock hooks. There is no on/off switch: the
 * playful touches are always part of the app (see utils/easterEggs.ts).
 */

const store = {
    getItem: (k: string) => secureLocalStore.getItem(k),
    setItem: (k: string, v: string) => secureLocalStore.setItem(k, v),
};

/**
 * Rate limit + record in the seen-ledger, in one call. See claimEgg.
 * Deliberately does NOT count towards the Egg hunter badge: ledger ids are
 * rate-limit bookkeeping (some, like `keys-coffee`, are not registry eggs),
 * so each egg's payoff site calls recordEggFound with its registry id itself —
 * one explicit, greppable call per egg (eggProgress.test.ts asserts them).
 */
export function claimEggNow(id: string, policy?: EggPolicy): boolean {
    return claimEgg(store, id, Date.now(), policy);
}

export function eggCountNow(id: string): number {
    return eggCount(store, id);
}

export function noteEggNow(id: string): void {
    noteEgg(store, id, Date.now());
}

const HOUR_MS = 60 * 60 * 1000;

export interface EggCalendar {
    /** What Keys wears today (Halloween witch hat, New Year / birthday party hat). */
    costume: Costume | null;
    halloween: boolean;
    /** Years since launch on the birthday itself, else 0. */
    birthday: number;
}

function today(): EggCalendar {
    const d = new Date();
    return { costume: costumeFor(d), halloween: isHalloween(d), birthday: birthdayYears(d) };
}

/**
 * Today's calendar eggs. Re-checked hourly so a client left running over
 * midnight changes outfit on time, the same reasoning as SeasonalLayer.
 */
export function useEggCalendar(): EggCalendar {
    const [day, setDay] = useState<EggCalendar>(today);
    useEffect(() => {
        const t = setInterval(() => setDay(today()), HOUR_MS);
        return () => clearInterval(t);
    }, []);
    return day;
}

/** What Keys is wearing today (null = nothing). */
export function useEasterCostume(): Costume | null {
    const costume = useEggCalendar().costume;
    // Keys is on screen wearing the day's hat: that is the find (once per
    // HOLIDAY ever, not per year — see costumeEggFor).
    useEffect(() => {
        if (!costume) return;
        const id = costumeEggFor(new Date());
        if (id) recordEggFound(id);
    }, [costume]);
    return costume;
}

const FIVE_MIN_MS = 5 * 60 * 1000;

function lateNightLine(): string | null {
    const d = new Date();
    return isLateNight(d) ? pickRotating(LATE_NIGHT_PLACEHOLDERS, dayNumber(d)) : null;
}

/**
 * The composer's placeholder between 03:00 and 04:59 local ("Shouldn't you be
 * asleep?"), else null. One line per night (rotating by day), re-checked every
 * five minutes so it appears and clears on time without a render loop. It only
 * ever replaces the EMPTY composer's idle hint — the slot is already the
 * UI's own — and reads nothing but the clock.
 */
export function useLateNightPlaceholder(): string | null {
    const [line, setLine] = useState<string | null>(lateNightLine);
    useEffect(() => {
        const t = setInterval(() => setLine(lateNightLine()), FIVE_MIN_MS);
        return () => clearInterval(t);
    }, []);
    return line;
}

/**
 * A line for a UI slot that already exists: a pick from `pool` by `seed`
 * (rotating, never random per render, so a re-render never changes the joke
 * under someone's eyes). `plain` is the slot's original sentence, used only
 * if the pool is empty.
 */
export function usePlayfulLine(plain: string, pool: readonly string[], seed: number): string {
    return pool.length ? pickRotating(pool, seed) : plain;
}
