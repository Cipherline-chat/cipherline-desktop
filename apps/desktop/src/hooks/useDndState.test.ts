// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeDnd } from './useDndState';
import { DEFAULT_PREFS } from '../contexts/NotificationContext';
import type { NotificationPrefs } from '../contexts/NotificationContext';

/**
 * `computeDnd` decides whether an incoming alert is SWALLOWED. Its result is
 * the `dndActive` input to resolveNotification, where `dndSwallows` gates
 * `playsSound` and `showsToast` together — so anything that makes this
 * function return `active: true` takes the sound away as well as the toast.
 *
 * That is why `desktop_notifications_enabled` must not be one of those
 * things. See the note on computeDnd itself.
 */
const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs =>
    ({ ...DEFAULT_PREFS, ...over });

const CALM = { userStatus: 'online', activeCall: false, screensharing: false, gameActive: false };

describe('computeDnd', () => {
    it('is inactive for a default, undisturbed user', () => {
        expect(computeDnd(prefs(), CALM)).toEqual({ active: false, reason: '' });
    });

    it('turning OFF desktop toasts does not put the user in DND', () => {
        // THE REGRESSION. This used to return { active: true, reason: 'disabled' },
        // which swallowed every notification SOUND as well — for a toggle the
        // settings screen describes as "Show OS toasts when new messages
        // arrive", sitting directly above a separate "Notification sounds"
        // toggle that the user had left ON.
        expect(computeDnd(prefs({ desktop_notifications_enabled: false }), CALM))
            .toEqual({ active: false, reason: '' });
    });

    it('is still inactive with toasts off and sounds on — the exact reported combination', () => {
        expect(computeDnd(
            prefs({ desktop_notifications_enabled: false, sounds_enabled: true }),
            CALM,
        ).active).toBe(false);
    });

    it('does not read sounds_enabled either — that is the dispatcher\'s own gate', () => {
        // Symmetry check. Neither delivery channel's on/off switch belongs in
        // a function about whether the user is to be disturbed at all.
        expect(computeDnd(prefs({ sounds_enabled: false }), CALM).active).toBe(false);
    });

    describe('the genuine triggers still fire', () => {
        it('manual DND', () => {
            expect(computeDnd(prefs({ dnd_manual: true }), CALM))
                .toEqual({ active: true, reason: 'manual' });
        });

        it('status set to Do Not Disturb', () => {
            expect(computeDnd(prefs(), { ...CALM, userStatus: 'dnd' }))
                .toEqual({ active: true, reason: 'status_dnd' });
        });

        it('screen sharing — on by default, because a toast leaks to the audience', () => {
            expect(computeDnd(prefs(), { ...CALM, screensharing: true }))
                .toEqual({ active: true, reason: 'screensharing' });
        });

        it('in a call and in a game only when the user opted in', () => {
            expect(computeDnd(prefs(), { ...CALM, activeCall: true }).active).toBe(false);
            expect(computeDnd(prefs(), { ...CALM, gameActive: true }).active).toBe(false);
            expect(computeDnd(
                prefs({ dnd_auto: { ...DEFAULT_PREFS.dnd_auto, when_in_call: true } }),
                { ...CALM, activeCall: true },
            )).toEqual({ active: true, reason: 'in_call' });
            expect(computeDnd(
                prefs({ dnd_auto: { ...DEFAULT_PREFS.dnd_auto, when_in_game: true } }),
                { ...CALM, gameActive: true },
            )).toEqual({ active: true, reason: 'gaming' });
        });

        it('a real trigger still fires with toasts switched off', () => {
            // Removing the toast toggle from this function must not have made
            // it ignore the reasons that genuinely mean "do not disturb me".
            expect(computeDnd(
                prefs({ desktop_notifications_enabled: false, dnd_manual: true }),
                CALM,
            )).toEqual({ active: true, reason: 'manual' });
        });
    });

    it('never reports the retired `disabled` reason, whatever the prefs', () => {
        for (const desktop_notifications_enabled of [true, false]) {
            for (const sounds_enabled of [true, false]) {
                for (const dnd_manual of [true, false]) {
                    const r = computeDnd(
                        prefs({ desktop_notifications_enabled, sounds_enabled, dnd_manual }),
                        CALM,
                    );
                    expect(r.reason).not.toBe('disabled');
                }
            }
        }
    });
});
