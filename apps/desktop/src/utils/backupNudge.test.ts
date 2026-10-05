import { describe, it, expect } from 'vitest';
import { computeBackupNudge } from './backupNudge';

// computeBackupNudge decides the home screen's backup tile. It used to take a
// single input — the last-backup timestamp — and treat "no timestamp" as
// "you have no backup yet". That reported the same thing for three very
// different situations, two of which were self-inflicted:
//   - a genuinely un-configured account (correct)
//   - backups fully configured whose first scheduled run hadn't fired yet
//   - automatic backups on but permanently stalled because no passphrase was
//     cached, so the scheduler bailed silently on every tick forever
// These lock the decision table down.

const DAY = 86_400_000;
const NOW = Date.parse('2026-08-13T12:00:00Z');
const daysAgo = (n: number) => NOW - n * DAY;

describe('computeBackupNudge', () => {
    describe('no backup has ever completed', () => {
        it('tells an un-configured account it has no backup', () => {
            const n = computeBackupNudge(null, { configured: false, now: NOW });
            expect(n?.title).toBe('You have no backup yet');
            expect(n?.critical).toBe(false);
        });

        it('does NOT claim "no backup" when backups are configured and simply pending', () => {
            const n = computeBackupNudge(null, { configured: true, now: NOW });
            expect(n).not.toBeNull();
            expect(n?.title).not.toBe('You have no backup yet');
            expect(n?.chip).toBe('Pending');
            expect(n?.critical).toBe(false);
        });

        it('flags a stalled schedule as actionable rather than as "no backup"', () => {
            const n = computeBackupNudge(null, { configured: true, blocked: 'no-passphrase', now: NOW });
            expect(n?.title).toBe("Automatic backups aren't running");
            expect(n?.critical).toBe(true);
            expect(n?.chip).toBe('Action needed');
        });
    });

    describe('a backup exists', () => {
        it('says nothing at all when the last backup is recent', () => {
            expect(computeBackupNudge(daysAgo(0), { configured: true, now: NOW })).toBeNull();
            expect(computeBackupNudge(daysAgo(6), { configured: true, now: NOW })).toBeNull();
        });

        it('nudges once a backup is a week old', () => {
            const n = computeBackupNudge(daysAgo(7), { configured: true, now: NOW });
            expect(n?.title).toBe('Last backup was 7 days ago');
            expect(n?.critical).toBe(false);
            expect(n?.chip).toBe('Needs attention');
        });

        it('escalates to critical at 30 days', () => {
            expect(computeBackupNudge(daysAgo(29), { configured: true, now: NOW })?.critical).toBe(false);
            const n = computeBackupNudge(daysAgo(30), { configured: true, now: NOW });
            expect(n?.critical).toBe(true);
            expect(n?.chip).toBe('Action needed');
        });

        it('still surfaces a stalled schedule even though an older backup exists', () => {
            // Everything since that backup is unprotected and silently staying
            // that way — a recent-enough timestamp must not suppress this.
            const n = computeBackupNudge(daysAgo(1), { configured: true, blocked: 'no-passphrase', now: NOW });
            expect(n?.title).toBe("Automatic backups aren't running");
            expect(n?.critical).toBe(true);
        });

        it('a failed last run alone does not nag while backups are still fresh', () => {
            // Transient failures retry on the next tick; only a passphrase
            // stall is permanent without user action.
            expect(computeBackupNudge(daysAgo(1), { configured: true, blocked: 'last-run-failed', now: NOW })).toBeNull();
        });
    });

    it('defaults to the un-configured reading when no options are passed', () => {
        expect(computeBackupNudge(null)?.title).toBe('You have no backup yet');
    });
});
