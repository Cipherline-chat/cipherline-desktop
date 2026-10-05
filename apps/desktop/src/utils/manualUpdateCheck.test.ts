import { describe, it, expect } from 'vitest';
import {
    beginCheck,
    observeUpdaterState,
    settleCheck,
    failCheck,
    dismissResult,
    describeCheckError,
    describeManualCheck,
    type ManualCheckState,
    type UpdaterStateLike,
} from './manualUpdateCheck';

const IDLE: ManualCheckState = { kind: 'idle' };
const CHECKING: ManualCheckState = { kind: 'checking' };

const updaterIdle: UpdaterStateLike = { phase: 'idle' };
const updaterAvailable: UpdaterStateLike = { phase: 'available', version: '1.0.13' };
const updaterDownloading: UpdaterStateLike = { phase: 'downloading', version: '1.0.13' };
const updaterManual: UpdaterStateLike = { phase: 'manual', version: '1.0.13' };

describe('beginCheck', () => {
    it('moves an idle row into checking', () => {
        expect(beginCheck(IDLE)).toEqual({ kind: 'checking' });
    });

    it('restarts from a finished result', () => {
        expect(beginCheck({ kind: 'up-to-date' })).toEqual({ kind: 'checking' });
        expect(beginCheck({ kind: 'error', message: 'boom' })).toEqual({ kind: 'checking' });
        expect(beginCheck({ kind: 'found', version: '1.0.13' })).toEqual({ kind: 'checking' });
    });

    it('is a no-op while a check is already in flight (no stacked timers)', () => {
        expect(beginCheck(CHECKING)).toBe(CHECKING);
    });
});

describe('observeUpdaterState', () => {
    it('reports an update the moment the updater leaves idle', () => {
        expect(observeUpdaterState(CHECKING, updaterAvailable)).toEqual({ kind: 'found', version: '1.0.13' });
        expect(observeUpdaterState(CHECKING, updaterDownloading)).toEqual({ kind: 'found', version: '1.0.13' });
        expect(observeUpdaterState(CHECKING, updaterManual)).toEqual({ kind: 'found', version: '1.0.13' });
    });

    it('stays in checking while the updater is idle', () => {
        expect(observeUpdaterState(CHECKING, updaterIdle)).toBe(CHECKING);
    });

    it('never overwrites a result the user has already been shown', () => {
        const settled: ManualCheckState = { kind: 'up-to-date' };
        // A background check four hours later must not silently rewrite the
        // row into "update found" long after the click it belonged to.
        expect(observeUpdaterState(settled, updaterAvailable)).toBe(settled);
        expect(observeUpdaterState(IDLE, updaterAvailable)).toBe(IDLE);
    });

    it('tolerates a versionless updater state', () => {
        expect(observeUpdaterState(CHECKING, { phase: 'available' })).toEqual({ kind: 'found', version: '' });
    });
});

describe('settleCheck', () => {
    it('concludes up-to-date when the updater is still idle', () => {
        expect(settleCheck(CHECKING, true, updaterIdle)).toEqual({ kind: 'up-to-date' });
    });

    it('concludes found when the updater moved while the check was in flight', () => {
        expect(settleCheck(CHECKING, true, updaterDownloading)).toEqual({ kind: 'found', version: '1.0.13' });
    });

    it('reports unsupported when no check was dispatched (dev/smoke build)', () => {
        // Distinct from up-to-date on purpose: we never asked, so we do not
        // get to claim there is nothing new.
        expect(settleCheck(CHECKING, false, updaterIdle)).toEqual({ kind: 'unsupported' });
    });

    it('ignores a settle that arrives when no check is in flight', () => {
        expect(settleCheck(IDLE, true, updaterIdle)).toBe(IDLE);
        const found: ManualCheckState = { kind: 'found', version: '1.0.13' };
        expect(settleCheck(found, true, updaterIdle)).toBe(found);
    });
});

describe('failCheck', () => {
    it('surfaces the failure while checking', () => {
        expect(failCheck(CHECKING, new Error('net::ERR_NAME_NOT_RESOLVED')))
            .toEqual({ kind: 'error', message: 'net::ERR_NAME_NOT_RESOLVED' });
    });

    it('ignores a late rejection once a result is displayed', () => {
        const ok: ManualCheckState = { kind: 'up-to-date' };
        expect(failCheck(ok, new Error('too late'))).toBe(ok);
    });
});

describe('dismissResult', () => {
    it('returns a finished result to rest', () => {
        expect(dismissResult({ kind: 'up-to-date' })).toEqual({ kind: 'idle' });
        expect(dismissResult({ kind: 'found', version: '1.0.13' })).toEqual({ kind: 'idle' });
        expect(dismissResult({ kind: 'error', message: 'x' })).toEqual({ kind: 'idle' });
        expect(dismissResult({ kind: 'unsupported' })).toEqual({ kind: 'idle' });
    });

    it('leaves an in-flight check alone', () => {
        expect(dismissResult(CHECKING)).toBe(CHECKING);
        expect(dismissResult(IDLE)).toBe(IDLE);
    });
});

describe('describeCheckError', () => {
    it("strips Electron's remote-method wrapper", () => {
        expect(describeCheckError(new Error(
            "Error invoking remote method 'updater:check-now': Error: HttpError: 404 Not Found",
        ))).toBe('Error: HttpError: 404 Not Found');
    });

    it('accepts a bare string rejection', () => {
        expect(describeCheckError('offline')).toBe('offline');
    });

    it('falls back to a real sentence for an empty or unknown failure', () => {
        expect(describeCheckError(new Error(''))).toBe("Couldn't reach the update server.");
        expect(describeCheckError(undefined)).toBe("Couldn't reach the update server.");
        expect(describeCheckError({})).toBe("Couldn't reach the update server.");
        expect(describeCheckError(new Error("Error invoking remote method 'updater:check-now': ")))
            .toBe("Couldn't reach the update server.");
    });

    it('truncates a wall-of-text error to one readable line', () => {
        const long = 'x'.repeat(500);
        const out = describeCheckError(new Error(long));
        expect(out).toHaveLength(160);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('describeManualCheck', () => {
    it('is quiet at rest', () => {
        const d = describeManualCheck(IDLE);
        expect(d).toEqual({ label: 'Check now', detail: null, tone: 'neutral', busy: false });
    });

    it('marks the in-flight state busy', () => {
        const d = describeManualCheck(CHECKING);
        expect(d.busy).toBe(true);
        expect(d.label).toBe('Checking…');
        expect(d.detail).toBeTruthy();
    });

    it('names the version it found, and copes without one', () => {
        expect(describeManualCheck({ kind: 'found', version: '1.0.13' }).detail)
            .toBe('Update found — downloading v1.0.13 in the background.');
        expect(describeManualCheck({ kind: 'found', version: '' }).detail)
            .toBe('Update found — downloading in the background.');
    });

    it('offers a retry, not a fresh check, after an error', () => {
        const d = describeManualCheck({ kind: 'error', message: 'HttpError: 404' });
        expect(d.label).toBe('Try again');
        expect(d.detail).toBe('HttpError: 404');
        expect(d.tone).toBe('error');
    });

    it('distinguishes up-to-date from unsupported', () => {
        expect(describeManualCheck({ kind: 'up-to-date' }).detail).toBe("You're up to date.");
        expect(describeManualCheck({ kind: 'unsupported' }).detail)
            .toBe('Update checks only run in a packaged build.');
    });

    it('never leaves the button unlabelled in any state', () => {
        const all: ManualCheckState[] = [
            { kind: 'idle' },
            { kind: 'checking' },
            { kind: 'up-to-date' },
            { kind: 'found', version: '1.0.13' },
            { kind: 'unsupported' },
            { kind: 'error', message: 'x' },
        ];
        for (const s of all) expect(describeManualCheck(s).label.length).toBeGreaterThan(0);
    });
});
