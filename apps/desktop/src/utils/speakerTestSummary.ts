import type { SinkOutcome } from './audioOutput';

/**
 * The sentence the settings "Test speakers" button shows. Pure so the wording
 * rules are testable (VoiceVideoSettings is a .tsx and vitest here is node-only).
 *
 * The rules, in order:
 *  - the picked output is the system default: nothing was routed, so the only
 *    claim is that the sound played;
 *  - either routing path failed or did not land: say which, with the error
 *    enum (never a device name or id), and that the sound went to the
 *    default - the user who heard it from the wrong device now knows why;
 *  - both landed: "Played on your selected speakers."
 */
export interface SpeakerTestSummaryInput {
    element: SinkOutcome;
    context: SinkOutcome;
    played: boolean;
}

export function describeSpeakerTest(
    r: SpeakerTestSummaryInput,
    followsDefault: boolean,
): { ok: boolean; text: string } {
    if (!r.played) {
        return { ok: false, text: "Couldn't play the test sound (no audio device, or playback was blocked)." };
    }
    if (followsDefault) return { ok: true, text: 'Played on your system default speakers.' };

    const bad = (o: SinkOutcome) => !o.ok || !o.landed;
    if (bad(r.element) || bad(r.context)) {
        const what = bad(r.element) && bad(r.context) ? 'audio'
            : bad(r.element) ? 'voices and sounds' : 'noise-suppressed voices';
        const err = (bad(r.element) ? r.element.error : r.context.error) ?? 'unknown';
        return {
            ok: false,
            text: `Couldn't route ${what} to the selected speakers (${err}) — it plays on the system default.`,
        };
    }
    return { ok: true, text: 'Played on your selected speakers.' };
}
