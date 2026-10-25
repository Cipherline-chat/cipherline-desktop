import { GROUP_OF_TWO_BODIES, GROUP_OF_TWO_TITLES, fillLine, pickRotating } from './eggPools';

/**
 * Egg: creating a "group chat" that is just you and one other person.
 *
 * Pure decision + copy, so the rules are testable without a DOM:
 *   - exactly ONE other person picked (zero is a normal validation error, two+
 *     is a real group);
 *   - stops asking once the user has insisted twice ("Make the group
 *     anyway"): they clearly mean it, and a dialog that never learns is a
 *     nag, not a joke. The dialog itself always lets them proceed.
 */

/** Ledger ids (utils/easterEggs.ts). */
export const GROUP_OF_TWO_SHOWN = 'group-of-two';
export const GROUP_OF_TWO_INSISTED = 'group-of-two-anyway';
/** "Make the group anyway" this many times and the egg retires for good. */
export const GROUP_OF_TWO_INSIST_LIMIT = 2;

export interface GroupOfTwoPerson {
    user_id: string;
    username: string;
    avatar_url?: string | null;
}

export function groupOfTwoTarget(input: {
    selectedIds: readonly string[];
    /** Everyone the picker knows about (friends + pre-selected), any order. */
    people: readonly GroupOfTwoPerson[];
    insistedCount: number;
}): GroupOfTwoPerson | null {
    if (input.insistedCount >= GROUP_OF_TWO_INSIST_LIMIT) return null;
    if (input.selectedIds.length !== 1) return null;
    const id = input.selectedIds[0];
    return input.people.find(p => p.user_id === id) ?? null;
}

/** Title and body for the `shownCount`-th showing (0-based). */
export function groupOfTwoCopy(shownCount: number, name: string): { title: string; body: string } {
    return {
        title: pickRotating(GROUP_OF_TWO_TITLES, shownCount),
        body: fillLine(pickRotating(GROUP_OF_TWO_BODIES, shownCount), { name }),
    };
}
