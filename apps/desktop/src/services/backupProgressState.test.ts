import { describe, it, expect } from 'vitest';
import type { DriveBackupProgress } from './driveBackup';
import {
    initProgressRows, advanceProgressRows, finishProgressRows, rowStatusText,
    type ProgressRows,
} from './backupProgressState';

const run = (rows: ProgressRows, events: DriveBackupProgress[]) =>
    events.reduce(advanceProgressRows, rows);

describe('advanceProgressRows', () => {
    it('starts every active destination as waiting, and only those', () => {
        expect(initProgressRows(['drive'])).toEqual({ drive: { stage: 'waiting', pct: null } });
    });

    it('shows shared preparation on every destination, with attachment progress', () => {
        const r = run(initProgressRows(['local', 'drive']), [
            { phase: 'export' },
            { phase: 'encrypt', attachments: { done: 1, total: 4 } },
        ]);
        expect(r.local).toEqual({ stage: 'preparing', pct: 25 });
        expect(r.drive).toEqual({ stage: 'preparing', pct: 25 });
    });

    it('tracks Drive upload bytes as a percentage, and local as indeterminate', () => {
        const start = initProgressRows(['local', 'drive']);
        const writing = run(start, [{ phase: 'local', destination: 'local' }]);
        expect(writing.local).toEqual({ stage: 'writing', pct: null });
        const up = run(start, [
            { phase: 'upload', destination: 'drive' },
            { phase: 'upload', destination: 'drive', transfer: { done: 50, total: 200 } },
        ]);
        expect(up.drive).toEqual({ stage: 'uploading', pct: 25 });
        expect(rowStatusText(up.drive!)).toBe('Uploading 25%');
    });

    it('does not walk the upload bar backwards on a message-only event', () => {
        const r = run(initProgressRows(['drive']), [
            { phase: 'upload', destination: 'drive', transfer: { done: 80, total: 100 } },
            { phase: 'upload', destination: 'drive' },
        ]);
        expect(r.drive?.pct).toBe(80);
    });

    it('marks a destination done when the next one starts (destinations run in sequence)', () => {
        const r = run(initProgressRows(['local', 'drive']), [
            { phase: 'local', destination: 'local' },
            { phase: 'verify', destination: 'local' },
            { phase: 'upload', destination: 'drive' },
        ]);
        expect(r.local).toEqual({ stage: 'done', pct: 100 });
        expect(r.drive?.stage).toBe('uploading');
    });

    it('ignores events for a destination that is not part of this run', () => {
        const start = initProgressRows(['local']);
        expect(run(start, [{ phase: 'upload', destination: 'drive' }])).toEqual(start);
    });

    it('leaves settling to finishProgressRows on done/error events', () => {
        const start = initProgressRows(['drive']);
        expect(run(start, [{ phase: 'done' }, { phase: 'error', message: 'x' }])).toEqual(start);
    });
});

describe('finishProgressRows', () => {
    const mid = (): ProgressRows => run(initProgressRows(['local', 'drive']), [
        { phase: 'local', destination: 'local' },
        { phase: 'verify', destination: 'local' },
        { phase: 'upload', destination: 'drive' },
        { phase: 'verify', destination: 'drive' },
    ]);

    it('marks everything done on a clean run', () => {
        const r = finishProgressRows(mid(), {});
        expect(r.local?.stage).toBe('done');
        expect(r.drive?.stage).toBe('done');
    });

    it('marks only the failed destination as failed (partial failure)', () => {
        const r = finishProgressRows(mid(), { errors: { drive: 'HTTP 403' } });
        expect(r.local?.stage).toBe('done');
        expect(r.drive?.stage).toBe('error');
    });

    it('marks a skipped (unchanged) destination as up to date, not done', () => {
        const r = finishProgressRows(initProgressRows(['drive']), { drive: { skipped: true } });
        expect(r.drive?.stage).toBe('skipped');
        expect(rowStatusText(r.drive!)).toBe('Already up to date');
    });

    it('fails everything still running when the run threw', () => {
        const r = finishProgressRows(
            run(initProgressRows(['local', 'drive']), [
                { phase: 'local', destination: 'local' },
                { phase: 'verify', destination: 'local' },
                { phase: 'upload', destination: 'drive' },
            ]),
            null,
        );
        expect(r.local?.stage).toBe('done');
        expect(r.drive?.stage).toBe('error');
    });
});
