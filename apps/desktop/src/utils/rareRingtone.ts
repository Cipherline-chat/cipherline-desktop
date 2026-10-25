/**
 * The rare alternate ringtone. About one incoming call in a thousand rings with
 * a different tune instead of the usual one (the way Discord does).
 *
 * Everything that decides whether you hear it is the NORMAL ringtone's own
 * path: the roll happens inside `playLoopingSound` only AFTER the 'call'
 * category has been resolved against your sound settings (master switch,
 * category switch, volume, Do Not Disturb), so a muted or silenced ring stays
 * silent and never rolls. The alternate then plays at exactly the volume the
 * normal ring would have.
 *
 * Two more rules, both in `playLoopingSound`:
 *   - Only when you have not picked your own call sound. A custom ringtone is a
 *     choice, and a one-in-a-thousand swap would override it.
 *   - The egg is counted when the alternate actually starts playing, not when
 *     it is rolled.
 *
 * The file is synthesised (apps/desktop/scripts/gen-rare-ringtone.mjs), so it
 * is ours to ship. Client-only: nothing about the roll or the result leaves
 * the device.
 */
import { recordEggFound } from './eggProgress';

/** public/sounds/call_sound_rare.wav, loaded like every bundled cue. */
export const RARE_RINGTONE_FILE = './sounds/call_sound_rare.wav';
/** One in this many incoming calls. */
export const RARE_RINGTONE_ODDS = 1000;
/** The egg id: counted when the rare ring plays. */
export const RARE_RINGTONE_EGG = 'rare-ringtone';

/** True for one roll in RARE_RINGTONE_ODDS. `rng` returns [0, 1). */
export function rareRingtoneRoll(rng: () => number = Math.random): boolean {
    return Math.floor(rng() * RARE_RINGTONE_ODDS) === 0;
}

/** The alternate for `playLoopingSound('call', prefs, { alternate })`. */
export function rareRingtoneAlternate(rng: () => number = Math.random) {
    return {
        file: RARE_RINGTONE_FILE,
        roll: () => rareRingtoneRoll(rng),
        onPlay: () => recordEggFound('rare-ringtone'),
    };
}
