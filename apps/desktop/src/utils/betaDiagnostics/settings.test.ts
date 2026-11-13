import { describe, it, expect, beforeEach, vi } from 'vitest';

// Beta diagnostics are account-linked, so the toggle is OPT-IN: nothing is on
// until the user explicitly said yes on this device.

const store = new Map<string, string>();
let throwOnRead = false;
vi.mock('../secureLocalStore', () => {
    const api = {
        getItem: (k: string) => { if (throwOnRead) throw new Error('locked'); return store.get(k) ?? null; },
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

const { getBetaDiagEnabled, setBetaDiagEnabled, getBetaNoticeSeen, markBetaNoticeSeen } = await import('./settings');

describe('beta diagnostics consent (opt-in)', () => {
    beforeEach(() => { store.clear(); throwOnRead = false; });

    it('is OFF for a user who never answered', () => {
        expect(getBetaDiagEnabled('u1')).toBe(false);
    });

    it('is OFF for a user who only saw the old "diagnostics are on" notice', () => {
        // Pre-opt-in builds wrote this key and left the toggle unset (= on).
        store.set('cipherline_beta_diag_notice_u1', '1');
        expect(getBetaDiagEnabled('u1')).toBe(false);
        // ...and they are asked again under the opt-in rule.
        expect(getBetaNoticeSeen('u1')).toBe(false);
    });

    it('is ON only after an explicit yes, and OFF again after no', () => {
        setBetaDiagEnabled('u1', true);
        expect(getBetaDiagEnabled('u1')).toBe(true);
        setBetaDiagEnabled('u1', false);
        expect(getBetaDiagEnabled('u1')).toBe(false);
    });

    it('is per account', () => {
        setBetaDiagEnabled('u1', true);
        expect(getBetaDiagEnabled('u2')).toBe(false);
    });

    it('fails closed: no user or an unreadable store is OFF', () => {
        expect(getBetaDiagEnabled(null)).toBe(false);
        store.set('cipherline_beta_diag_u1', '1');
        throwOnRead = true;
        expect(getBetaDiagEnabled('u1')).toBe(false);
    });

    it('remembers that the consent ask was answered', () => {
        expect(getBetaNoticeSeen('u1')).toBe(false);
        markBetaNoticeSeen('u1');
        expect(getBetaNoticeSeen('u1')).toBe(true);
    });
});
