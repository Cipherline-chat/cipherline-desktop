import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import {
    cleanDiscriminatorDraft, canChangeDiscriminatorMirror, discriminatorFieldState, discriminatorPreview,
    discriminatorSaveError, discriminatorCommitAction, DISCRIMINATOR_ZERO_MESSAGE, DISCRIMINATOR_FORMAT_MESSAGE, DISCRIMINATOR_TRIAL_MESSAGE, DISCRIMINATOR_PRO_MESSAGE,
    discriminatorWireValue,
} from './discriminatorField';

// The API and website sources only exist in the private monorepo; the public export (apps/desktop +
// packages/shared) skips the cross-repo cases below and still runs every other test in this file.
const API_DISCRIMINATOR_PATH = resolve(__dirname, '../../../api/src/auth/discriminator.util.ts');
const WEBSITE_PROFILE_CARD_PATH = resolve(__dirname, '../../../website/src/app/account/ProfileCard.tsx');

describe('cleanDiscriminatorDraft', () => {
    it('keeps digits only, max 4', () => {
        expect(cleanDiscriminatorDraft('#0042')).toBe('0042');
        expect(cleanDiscriminatorDraft('12a3b')).toBe('123');
        expect(cleanDiscriminatorDraft('123456')).toBe('1234');
        expect(cleanDiscriminatorDraft('')).toBe('');
    });
});

describe('canChangeDiscriminatorMirror', () => {
    const s = (subscription_status: string, effective_status: string) => ({ subscription_status, effective_status });
    it('allows paid / canceled_pending / past_due while entitled, comps (status active)', () => {
        expect(canChangeDiscriminatorMirror(s('active', 'active'))).toBe(true);
        expect(canChangeDiscriminatorMirror(s('canceled_pending', 'active'))).toBe(true);
        expect(canChangeDiscriminatorMirror(s('past_due', 'active'))).toBe(true);
    });
    it('refuses trial, expired, lapsed, and unknown', () => {
        expect(canChangeDiscriminatorMirror(s('trial', 'active'))).toBe(false);
        expect(canChangeDiscriminatorMirror(s('expired', 'expired'))).toBe(false);
        expect(canChangeDiscriminatorMirror(s('canceled_pending', 'expired'))).toBe(false);
        expect(canChangeDiscriminatorMirror(null)).toBe(false);
        expect(canChangeDiscriminatorMirror({})).toBe(false);
    });
});

describe('discriminatorFieldState', () => {
    const base = { current: 5, canChange: true };
    it('locks free accounts and gives trial its own copy', () => {
        expect(discriminatorFieldState({ ...base, canChange: false, draft: '0007' })).toMatchObject({ kind: 'locked', trial: false, message: DISCRIMINATOR_PRO_MESSAGE });
        expect(discriminatorFieldState({ ...base, canChange: false, isTrial: true, draft: '0007' })).toMatchObject({ kind: 'locked', trial: true, message: DISCRIMINATOR_TRIAL_MESSAGE });
    });
    it('empty or same value is unchanged ("0005" == 5)', () => {
        expect(discriminatorFieldState({ ...base, draft: '' }).kind).toBe('unchanged');
        expect(discriminatorFieldState({ ...base, draft: '0005' }).kind).toBe('unchanged');
    });
    it('rejects #0000 with its own message', () => {
        expect(discriminatorFieldState({ ...base, draft: '0000' })).toEqual({ kind: 'invalid', message: DISCRIMINATOR_ZERO_MESSAGE });
    });
    it('rejects fewer than 4 digits with the 4-digit message (no padding)', () => {
        for (const d of ['0', '00', '1', '7', '42', '123', '999']) {
            expect(discriminatorFieldState({ ...base, draft: d })).toEqual({ kind: 'invalid', message: DISCRIMINATOR_FORMAT_MESSAGE });
        }
        expect(DISCRIMINATOR_FORMAT_MESSAGE).toBe('Use all 4 digits, e.g. 0042 (0001-9999).');
    });
    it('rejects non-digits / too long (if they reach it)', () => {
        expect(discriminatorFieldState({ ...base, draft: 'ab' }).kind).toBe('invalid');
        expect(discriminatorFieldState({ ...base, draft: '12345' }).kind).toBe('invalid');
    });
    it('accepts 4-digit 0001..9999 incl. leading zeros', () => {
        expect(discriminatorFieldState({ ...base, draft: '0042' })).toEqual({ kind: 'ok', value: 42 });
        expect(discriminatorFieldState({ ...base, draft: '0001' })).toEqual({ kind: 'ok', value: 1 });
        expect(discriminatorFieldState({ ...base, draft: '9999' })).toEqual({ kind: 'ok', value: 9999 });
    });
});

describe('discriminatorPreview', () => {
    it('pads to 4', () => expect(discriminatorPreview('shinobi', 1)).toBe('shinobi#0001'));
});

describe('discriminatorSaveError', () => {
    const e = (status: number, message?: unknown) => ({ response: { status, data: { message } } });
    it('maps statuses', () => {
        expect(discriminatorSaveError(e(409, 'shinobi#0001 is taken. Try another number.'))).toEqual({ kind: 'taken', message: 'shinobi#0001 is taken. Try another number.' });
        expect(discriminatorSaveError(e(403))?.kind).toBe('pro');
        expect(discriminatorSaveError(e(400, ['bad']))).toEqual({ kind: 'invalid', message: 'bad' });
        expect(discriminatorSaveError(e(429))?.kind).toBe('throttled');
    });
    it('ignores everything else', () => {
        expect(discriminatorSaveError(e(500))).toBeNull();
        expect(discriminatorSaveError(new Error('net'))).toBeNull();
    });
});

describe('discriminatorCommitAction (Enter / leaving the inline segment)', () => {
    const st = (draft: string, canChange = true) => discriminatorFieldState({ draft, current: 1, canChange });
    it('saves a valid, different number', () => {
        expect(discriminatorCommitAction(st('0042'), '0042')).toBe('save');
        expect(discriminatorCommitAction(st('9999'), '9999', null)).toBe('save');
    });
    it('reverts an empty draft or the same number', () => {
        expect(discriminatorCommitAction(st(''), '')).toBe('revert');
        expect(discriminatorCommitAction(st('0001'), '0001')).toBe('revert');
    });
    it('never saves a short draft (it is invalid, so Enter/blur do nothing and the draft stays)', () => {
        for (const d of ['1', '42', '7', '123']) expect(discriminatorCommitAction(st(d), d)).toBe('none');
    });
    it('does nothing when untouched, invalid, locked, or already refused', () => {
        expect(discriminatorCommitAction(st(''), null)).toBe('none');
        expect(discriminatorCommitAction(st('0000'), '0000')).toBe('none');
        expect(discriminatorCommitAction(st('0042', false), '0042')).toBe('none');
        expect(discriminatorCommitAction(st('0007'), '0007', '0007')).toBe('none');
        expect(discriminatorCommitAction(st('0008'), '0008', '0007')).toBe('save');
    });
});

// Owner, 2026-11-16: "#0001 doesn't allow it, but 1111 works". The client sent
// String(1) = "1"; the API only accepts a 4-digit string (/^#?\d{4}$/).
describe('discriminatorWireValue: what POST /auth/discriminator is sent', () => {
    const API_FORMAT = /^#?\d{4}$/; // apps/api/src/auth/discriminator.util.ts DISCRIMINATOR_FORMAT_RE
    it('pads to 4 digits', () => {
        expect(discriminatorWireValue(1)).toBe('0001');
        expect(discriminatorWireValue(42)).toBe('0042');
        expect(discriminatorWireValue(999)).toBe('0999');
        expect(discriminatorWireValue(1111)).toBe('1111');
        expect(discriminatorWireValue(9999)).toBe('9999');
    });
    it('every valid number 1..9999 is accepted by the API format and parses back to itself', () => {
        for (let n = 1; n <= 9999; n++) {
            const w = discriminatorWireValue(n);
            expect(API_FORMAT.test(w)).toBe(true);
            expect(parseInt(w, 10)).toBe(n);
        }
    });
    it.skipIf(!existsSync(API_DISCRIMINATOR_PATH))('the API regex in the source is still the one mirrored here', () => {
        const api = readFileSync(API_DISCRIMINATOR_PATH, 'utf8');
        expect(api).toContain('export const DISCRIMINATOR_FORMAT_RE = /^#?\\d{4}$/;');
    });
    it.skipIf(!existsSync(WEBSITE_PROFILE_CARD_PATH))('desktop and website both send it', () => {
        const desk = readFileSync(resolve(__dirname, '../components/settings/panes/UsernameTagField.tsx'), 'utf8');
        const web = readFileSync(WEBSITE_PROFILE_CARD_PATH, 'utf8');
        expect(desk).toContain('{ discriminator: discriminatorWireValue(field.value) }');
        expect(web).toContain('{ discriminator: discriminatorWireValue(numField.value) }');
        expect(desk + web).not.toMatch(/discriminator: String\((field|numField)\.value\)/);
    });
});

// ── Owner 2026-11-16: 24 h cooldown, crown popover copy, Pro feature + cancel line ──
import {
    DISCRIMINATOR_COOLDOWN_ERROR, discriminatorCooldownRemainingMs, formatDiscriminatorCooldown,
    discriminatorCooldownFieldMessage, discriminatorCancelNotice, PRO_TAG_FEATURE_TITLE,
} from './discriminatorField';

describe('the #number cooldown mirror', () => {
    const NOW = Date.parse('2026-11-16T12:00:00Z');
    const H = 3_600_000;
    const fmt = { locale: 'en-US', timeZone: 'UTC' };
    it('remaining time: 0 for none / past / garbage', () => {
        expect(discriminatorCooldownRemainingMs(null, NOW)).toBe(0);
        expect(discriminatorCooldownRemainingMs(new Date(NOW - 1).toISOString(), NOW)).toBe(0);
        expect(discriminatorCooldownRemainingMs('not a date', NOW)).toBe(0);
        expect(discriminatorCooldownRemainingMs(new Date(NOW + 7 * H).toISOString(), NOW)).toBe(7 * H);
    });
    it('rounds UP (never promises earlier than the server allows)', () => {
        expect(formatDiscriminatorCooldown(6 * H + 1)).toBe('7 h');
        expect(formatDiscriminatorCooldown(59 * 60_000 + 1)).toBe('1 h');
        expect(formatDiscriminatorCooldown(45 * 60_000)).toBe('45 min');
        expect(formatDiscriminatorCooldown(1)).toBe('1 min');
    });
    it('the line says when, relative AND absolute', () => {
        expect(discriminatorCooldownFieldMessage(new Date(NOW + 7 * H).toISOString(), NOW, fmt))
            .toBe('You can change your #number again in 7 h (Mon 7:00 PM).');
    });
    it('Pro inside the cooldown -> cooldown state; after it -> editable; the Pro lock wins over both', () => {
        const next = new Date(NOW + 7 * H).toISOString();
        expect(discriminatorFieldState({ draft: '', current: 1, canChange: true, nextChangeAt: next, now: NOW, format: fmt }))
            .toEqual({ kind: 'cooldown', remainingMs: 7 * H, message: 'You can change your #number again in 7 h (Mon 7:00 PM).' });
        expect(discriminatorFieldState({ draft: '0042', current: 1, canChange: true, nextChangeAt: next, now: NOW + 7 * H }))
            .toEqual({ kind: 'ok', value: 42 });
        expect(discriminatorFieldState({ draft: '', current: 1, canChange: false, nextChangeAt: next, now: NOW }).kind).toBe('locked');
    });
    it('Enter / blur never saves inside the cooldown', () => {
        const st = discriminatorFieldState({ draft: '0042', current: 1, canChange: true, nextChangeAt: new Date(NOW + H).toISOString(), now: NOW });
        expect(discriminatorCommitAction(st, '0042')).toBe('none');
    });
    it('maps the cooldown 429 (with next_change_at) apart from the throttler 429', () => {
        const next = new Date(NOW + 23 * H).toISOString();
        expect(discriminatorSaveError({ response: { status: 429, data: { error: DISCRIMINATOR_COOLDOWN_ERROR, message: 'You can change your #number again in 23 h.', next_change_at: next } } }))
            .toEqual({ kind: 'cooldown', message: 'You can change your #number again in 23 h.', nextChangeAt: next });
        expect(discriminatorSaveError({ response: { status: 429, data: { message: 'ThrottlerException' } } })?.kind).toBe('throttled');
    });
    it.skipIf(!existsSync(API_DISCRIMINATOR_PATH))('the cooldown error code is the API\'s', () => {
        const api = readFileSync(API_DISCRIMINATOR_PATH, 'utf8');
        expect(api).toContain(`export const DISCRIMINATOR_COOLDOWN_ERROR = '${DISCRIMINATOR_COOLDOWN_ERROR}';`);
    });
});

describe('popover copy, Pro feature name, cancel line', () => {
    it('non-Pro and trial copy', () => {
        expect(DISCRIMINATOR_PRO_MESSAGE).toBe('Custom #numbers are a Pro feature.');
        expect(DISCRIMINATOR_TRIAL_MESSAGE).toMatch(/not included in the free trial/);
    });
    it('the features-list name', () => expect(PRO_TAG_FEATURE_TITLE).toBe('Custom #0001 tags'));
    it('cancel line names a CHOSEN number, otherwise the generic line', () => {
        expect(discriminatorCancelNotice({ discriminator: 1, custom: true }))
            .toBe('Your custom #number (#0001) will be replaced with a random one when Pro ends.');
        expect(discriminatorCancelNotice({ discriminator: 4821, custom: false })).not.toMatch(/4821|replaced/);
        expect(discriminatorCancelNotice({ discriminator: 4821 })).toMatch(/^Custom #number tags are Pro/);
        expect(discriminatorCancelNotice({ discriminator: null, custom: true })).toMatch(/^Custom #number tags are Pro/);
    });
});
