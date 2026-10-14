import { describe, it, expect } from 'vitest';
import {
    USERNAME_NOT_ALLOWED_MESSAGE,
    USERNAME_COOLDOWN_ERROR,
    formatCooldownRemaining,
    usernameCooldownRemainingMs,
    isNameAllowed,
} from '@cipherline/shared';
import { usernameFieldState, usernameBlocksSave, usernameSaveError, USERNAME_FORMAT_MESSAGE } from './usernameField';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const base = { current: 'frodo_b', now: NOW };

describe('usernameFieldState — the states Settings and the website portal render', () => {
    it('unchanged: empty or the current name', () => {
        expect(usernameFieldState({ ...base, draft: 'frodo_b' })).toEqual({ kind: 'unchanged' });
        expect(usernameFieldState({ ...base, draft: '  frodo_b ' })).toEqual({ kind: 'unchanged' });
        expect(usernameFieldState({ ...base, draft: '' })).toEqual({ kind: 'unchanged' });
    });

    it('ok: a valid, clean new name', () => {
        expect(usernameFieldState({ ...base, draft: 'night_owl' })).toEqual({ kind: 'ok' });
        expect(usernameFieldState({ ...base, draft: 'Scunthorpe' })).toEqual({ kind: 'ok' });
    });

    it('invalid: the format rule, before the filter', () => {
        for (const d of ['ab', 'has space', 'x'.repeat(33), 'semi;colon']) {
            expect(usernameFieldState({ ...base, draft: d })).toEqual({ kind: 'invalid', message: USERNAME_FORMAT_MESSAGE });
        }
    });

    it('not_allowed: the shared profanity filter, with the neutral message (never the word)', () => {
        for (const d of ['sh1t_head', 'f_u_c_k', 'BigAss', 'n1gg3r']) {
            const s = usernameFieldState({ ...base, draft: d });
            expect(s).toEqual({ kind: 'not_allowed', message: USERNAME_NOT_ALLOWED_MESSAGE });
        }
    });

    it('a grandfathered profane CURRENT name is not flagged while unchanged', () => {
        expect(usernameFieldState({ current: 'shit_head', draft: 'shit_head', now: NOW })).toEqual({ kind: 'unchanged' });
    });

    it('locked: inside the cooldown, whatever is typed, with an "again in N h" message', () => {
        const s = usernameFieldState({ ...base, draft: 'night_owl', nextChangeAt: iso(NOW + 5 * H) });
        expect(s).toEqual({ kind: 'locked', message: 'You can change your username again in 5 h.', remainingMs: 5 * H });
    });

    it('locked rounds UP and switches to minutes under an hour', () => {
        expect((usernameFieldState({ ...base, draft: 'x', nextChangeAt: iso(NOW + 4 * H + 1) }) as { message: string }).message)
            .toBe('You can change your username again in 5 h.');
        expect((usernameFieldState({ ...base, draft: 'x', nextChangeAt: iso(NOW + 45 * 60_000) }) as { message: string }).message)
            .toBe('You can change your username again in 45 min.');
        expect((usernameFieldState({ ...base, draft: 'x', nextChangeAt: iso(NOW + 1) }) as { message: string }).message)
            .toBe('You can change your username again in 1 min.');
    });

    it('unlocks at the instant next_username_change_at passes, and for null / garbage', () => {
        expect(usernameFieldState({ ...base, draft: 'night_owl', nextChangeAt: iso(NOW) }).kind).toBe('ok');
        expect(usernameFieldState({ ...base, draft: 'night_owl', nextChangeAt: iso(NOW - 1) }).kind).toBe('ok');
        expect(usernameFieldState({ ...base, draft: 'night_owl', nextChangeAt: null }).kind).toBe('ok');
        expect(usernameFieldState({ ...base, draft: 'night_owl', nextChangeAt: 'not a date' }).kind).toBe('ok');
    });

    it('a pending (first-choice) name is never locked', () => {
        expect(usernameFieldState({ ...base, draft: 'night_owl', pending: true, nextChangeAt: iso(NOW + H) }).kind).toBe('ok');
    });

    it('only a bad name blocks saving; a locked field does not (the rest of the profile still saves)', () => {
        expect(usernameBlocksSave({ kind: 'invalid', message: '' })).toBe(true);
        expect(usernameBlocksSave({ kind: 'not_allowed', message: '' })).toBe(true);
        expect(usernameBlocksSave({ kind: 'locked', message: '', remainingMs: 1 })).toBe(false);
        expect(usernameBlocksSave({ kind: 'ok' })).toBe(false);
        expect(usernameBlocksSave({ kind: 'unchanged' })).toBe(false);
    });
});

describe('usernameSaveError — server rejections shown next to the field', () => {
    const axiosErr = (status: number, data: unknown) => ({ response: { status, data } });

    it('429 cooldown: the server sentence + when it lifts', () => {
        const next = iso(NOW + 3 * H);
        expect(usernameSaveError(axiosErr(429, {
            statusCode: 429, error: USERNAME_COOLDOWN_ERROR, message: 'You can change your username again in 3 h.', retry_after: 10800, next_change_at: next,
        }))).toEqual({ message: 'You can change your username again in 3 h.', nextChangeAt: next });
    });

    it('429 cooldown without a message still produces one from retry_after', () => {
        expect(usernameSaveError(axiosErr(429, { error: USERNAME_COOLDOWN_ERROR, retry_after: 7200 })))
            .toEqual({ message: 'You can change your username again in 2 h.', nextChangeAt: null });
    });

    it('a throttler 429 (no username error code) is NOT treated as the cooldown', () => {
        expect(usernameSaveError(axiosErr(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }))).toBeNull();
    });

    it('400 from the filter (the DTO array shape) and from the format rule', () => {
        expect(usernameSaveError(axiosErr(400, { statusCode: 400, message: [USERNAME_NOT_ALLOWED_MESSAGE], error: 'Bad Request' })))
            .toEqual({ message: USERNAME_NOT_ALLOWED_MESSAGE, nextChangeAt: null });
        expect(usernameSaveError(axiosErr(400, { message: ['Username must be 3–32 chars: letters, digits, underscore.'] }))?.message)
            .toMatch(/^Username must be/);
    });

    it('a 400 about something else, network errors and 5xx -> null (generic error path)', () => {
        expect(usernameSaveError(axiosErr(400, { message: ['bio must be shorter than or equal to 160 characters'] }))).toBeNull();
        expect(usernameSaveError(new Error('Network Error'))).toBeNull();
        expect(usernameSaveError(axiosErr(500, { message: 'Internal server error' }))).toBeNull();
        expect(usernameSaveError(null)).toBeNull();
    });

    it('409 name clash', () => {
        expect(usernameSaveError(axiosErr(409, { message: 'That name was just taken. Please try again.' }))?.message)
            .toBe('That name was just taken. Please try again.');
    });
});

describe('shared helpers the clients rely on', () => {
    it('remaining ms and formatting', () => {
        expect(usernameCooldownRemainingMs(iso(NOW + 90_000), NOW)).toBe(90_000);
        expect(usernameCooldownRemainingMs(undefined, NOW)).toBe(0);
        expect(formatCooldownRemaining(24 * 3_600_000)).toBe('24 h');
        expect(formatCooldownRemaining(59 * 60_000 + 1)).toBe('1 h');
        expect(formatCooldownRemaining(0)).toBe('1 min');
    });

    it('the desktop bundle runs the same filter as the API (spot check)', () => {
        expect(isNameAllowed('Scunthorpe')).toBe(true);
        expect(isNameAllowed('ｆｕｃｋ')).toBe(false);
    });
});
