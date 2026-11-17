import { describe, it, expect } from 'vitest';
import {
    DONT_ASK_AFTER, ECHO_PROMPT_COPY, afterDismiss, afterNever, mayPromptForEcho, offerDontAskAgain, parseEchoPromptStore,
    type PromptContext,
} from './echoPrompt';

const base: PromptContext = { aecOn: false, micOpen: true, deafened: false, dismissedThisCall: false, store: { dismissals: 0, never: false } };

describe('when the echo prompt may show', () => {
    it('AEC off, mic open, not deafened, not dismissed -> yes', () => expect(mayPromptForEcho(base)).toBe(true));
    it('never with echo cancellation already on', () => expect(mayPromptForEcho({ ...base, aecOn: true })).toBe(false));
    it('never while the mic is closed (muted, or push-to-talk with the key up)', () => expect(mayPromptForEcho({ ...base, micOpen: false })).toBe(false));
    it('never while deafened', () => expect(mayPromptForEcho({ ...base, deafened: true })).toBe(false));
    it('never after a dismissal in this call', () => expect(mayPromptForEcho({ ...base, dismissedThisCall: true })).toBe(false));
    it('never once the user said never', () => expect(mayPromptForEcho({ ...base, store: { dismissals: 3, never: true } })).toBe(false));
    it('earlier dismissals in OTHER calls do not stop it', () => expect(mayPromptForEcho({ ...base, store: { dismissals: 1, never: false } })).toBe(true));
});

describe('dismissals', () => {
    it("\"Don't ask again\" is offered after two dismissals, not before", () => {
        let s = { dismissals: 0, never: false };
        expect(offerDontAskAgain(s)).toBe(false);
        s = afterDismiss(s); expect(offerDontAskAgain(s)).toBe(false);
        s = afterDismiss(s); expect(s.dismissals).toBe(DONT_ASK_AFTER);
        expect(offerDontAskAgain(s)).toBe(true);
    });

    it('never is sticky', () => expect(afterNever({ dismissals: 2, never: false }).never).toBe(true));
});

describe('the stored record', () => {
    it('round-trips and tolerates garbage', () => {
        expect(parseEchoPromptStore(JSON.stringify({ dismissals: 2, never: true }))).toEqual({ dismissals: 2, never: true });
        for (const bad of [null, undefined, '', 'nope', '{"dismissals":"x"}', '[]', '{"dismissals":-4,"never":"yes"}']) {
            expect(parseEchoPromptStore(bad as string | null)).toEqual({ dismissals: 0, never: false });
        }
        expect(parseEchoPromptStore('{"dismissals":1e9}').dismissals).toBe(1000);
    });
});

describe('copy', () => {
    it('is the agreed wording', () => {
        expect(`${ECHO_PROMPT_COPY.title} — ${ECHO_PROMPT_COPY.body}`).toBe('Echo detected — people may hear themselves. Turn on echo cancellation?');
        expect([ECHO_PROMPT_COPY.turnOn, ECHO_PROMPT_COPY.dismiss]).toEqual(['Turn on', 'Dismiss']);
    });
});
