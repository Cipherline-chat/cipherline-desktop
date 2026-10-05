import { describe, it, expect } from 'vitest';
import {
    formatBillingDate,
    formatBillingDateOr,
    cancellationKeepProSentence,
} from '@cipherline/shared';
import * as shared from '@cipherline/shared';

/**
 * These lock in the fix for a real rendering bug: the cancel confirmation read
 *
 *   "You'll keep Pro until — — the period you've already paid for"
 *
 * on desktop, and "You'll keep Pro until never — …" on the website. Neither was
 * a wrong field name — `current_period_end` is correct — it was each client's
 * own formatter returning a placeholder ('—' / 'never') that got interpolated
 * into the middle of a sentence whose next character was already an em dash.
 */
describe('formatBillingDate', () => {
    it('formats a real ISO timestamp', () => {
        // Pin the locale so the assertion is not machine-dependent.
        expect(formatBillingDate('2026-10-12T00:00:00.000Z', 'en-US')).toBe('Oct 12, 2026');
    });

    it('returns null — not a placeholder — when there is no date', () => {
        // The whole point of the fix: callers must be able to DETECT the gap.
        expect(formatBillingDate(null)).toBeNull();
        expect(formatBillingDate(undefined)).toBeNull();
        expect(formatBillingDate('')).toBeNull();
    });

    it('returns null for an unparseable value instead of "Invalid Date"', () => {
        expect(formatBillingDate('not-a-date')).toBeNull();
    });

    it('still offers a placeholder for standalone fields', () => {
        expect(formatBillingDateOr(null, '—')).toBe('—');
        expect(formatBillingDateOr('2026-10-12T00:00:00.000Z', '—', 'en-US')).toBe('Oct 12, 2026');
    });
});

describe('cancellationKeepProSentence', () => {
    it('names the date when one is known', () => {
        const s = cancellationKeepProSentence('2026-10-12T00:00:00.000Z', 'en-US');
        expect(s).toContain('You\'ll keep Pro until Oct 12, 2026 — the period you\'ve already paid for —');
        expect(s).toContain('move to the free tier');
    });

    // The regression itself, asserted directly.
    it('never renders a doubled em dash when the date is missing', () => {
        const s = cancellationKeepProSentence(null);
        expect(s).not.toContain('— —');
        expect(s).not.toContain('until —');
    });

    it('does not claim Pro lasts forever when the date is missing', () => {
        // The website's old 'never' sentinel produced "keep Pro until never",
        // which is not merely ugly — it promises the opposite of a cancellation.
        const s = cancellationKeepProSentence(null);
        expect(s).not.toContain('never');
        expect(s).toContain('until the end of the period you\'ve already paid for');
    });

    it('stays grammatical and complete in both branches', () => {
        for (const input of ['2026-10-12T00:00:00.000Z', null]) {
            const s = cancellationKeepProSentence(input);
            expect(s).toContain('Nothing is charged again');
            expect(s).toContain('backups aren\'t affected');
            expect(s.endsWith('.')).toBe(true);
        }
    });

    it('falls back rather than throwing on a malformed date', () => {
        const s = cancellationKeepProSentence('garbage');
        expect(s).not.toContain('Invalid Date');
        expect(s).toContain('until the end of the period');
    });
});

describe('server-loss grace policy is retired (2026-10-04)', () => {
    // Every plan may own servers and nothing is deleted when Pro ends, so the
    // helpers behind the old "your servers are deleted 60 days after Pro lapses"
    // copy must not exist for a client to quote.
    it.each(['SERVER_OWNER_GRACE_DAYS', 'daysLeftInServerGrace', 'serverDeletionDeadline'])(
        '@cipherline/shared no longer exports %s', (name) => {
            expect(Object.keys(shared)).not.toContain(name);
        });
});
