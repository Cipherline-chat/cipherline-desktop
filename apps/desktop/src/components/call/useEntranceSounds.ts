import { useEffect, useRef, useState } from 'react';
import { createEntranceGate, type EntranceGate } from '../../utils/entranceSoundGate';
import { getEntrancePrefs } from '../../utils/entrancePrefs';
import { freshCallPersonalization } from '../../utils/callPersonalizationStore';
import { playCustomEntranceSound, playEntranceSound } from '../../utils/entrancePlayback';
import { handleEntranceJoin } from '../../utils/entranceJoin';
import { receivedSounds } from '../../utils/customEntranceSound/receivedCache';
import type { SoundsPrefs } from '../../utils/notificationSounds';

/**
 * Plays other people's entrance sounds as they join the call this component
 * lives in. `remoteIds` is the room roster minus yourself; `ready()` is false
 * during the initial roster sync (people already in the call are not
 * "joining"), same grace window the join/leave cues use.
 *
 * Order matters: the cheap listener checks come first, then the joiner's
 * CURRENT sound is read (someone may have just changed it), and only a person
 * who actually has a playable sound goes through the gate - so a joiner with
 * no sound never uses up the 2 s slot. The per-join decision, built-in and
 * custom alike, is utils/entranceJoin.ts; the gate itself (rejoin window,
 * global gap) is utils/entranceSoundGate.ts. A custom sound plays only if it
 * already reached this device, verified (components/call/EntranceSoundTransport.tsx).
 */
export function useEntranceSounds(
    remoteIds: readonly string[],
    ready: () => boolean,
    getSoundsPrefs: () => SoundsPrefs | null | undefined,
): void {
    const [gate] = useState<EntranceGate>(createEntranceGate);
    // Starts empty: `ready()` is false through the initial roster sync, so the
    // first pass only records who is already here.
    const prev = useRef<Set<string>>(new Set());
    const key = [...remoteIds].sort().join(',');

    useEffect(() => {
        const next = new Set(remoteIds);
        const joined = ready() ? remoteIds.filter(id => !prev.current.has(id)) : [];
        prev.current = next;
        for (const id of joined) {
            const prefs = getEntrancePrefs();
            if (!prefs.enabled || prefs.muted.includes(id)) continue;
            void handleEntranceJoin(id, {
                getPrefs: getEntrancePrefs,
                personalization: freshCallPersonalization,
                waitForCustom: (contentId, ms) => receivedSounds.waitFor(contentId, ms),
                gate,
                now: () => Date.now(),
                playBuiltin: soundId => playEntranceSound(soundId, getSoundsPrefs()),
                playCustom: (url, gain) => playCustomEntranceSound(url, gain, getSoundsPrefs()),
            });
        }
    // keyed on the sorted roster; the callbacks are stable closures over refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    // A new call is a new room: forget who rejoined when.
    useEffect(() => () => gate.reset(), [gate]);
}
