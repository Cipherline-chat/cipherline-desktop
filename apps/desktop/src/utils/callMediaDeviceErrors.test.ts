import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMediaDeviceUnavailableError, describeMediaDeviceUnavailable } from './callMediaDeviceErrors';

/**
 * No microphone must not end the call (Linux VM matrix 2026-11-09, staging.213:
 * Fedora 44 / Ubuntu 24.04 with no capture device — every DM call ended at 0:00
 * with "Requested device not found" although the room had connected).
 */
const dom = (name: string, message = '') => Object.assign(new Error(message), { name });

describe('isMediaDeviceUnavailableError', () => {
    it.each(['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'DevicesNotFoundError', 'TrackStartError'])('%s is a device problem', (n) => {
        expect(isMediaDeviceUnavailableError(dom(n, 'Requested device not found'))).toBe(true);
    });

    it('permission refusal keeps its own meaning (not swallowed)', () => {
        expect(isMediaDeviceUnavailableError(dom('NotAllowedError'))).toBe(false);
    });

    it('connection / signalling / E2EE failures still fail the call', () => {
        expect(isMediaDeviceUnavailableError(dom('ConnectionError', 'could not establish signal connection'))).toBe(false);
        expect(isMediaDeviceUnavailableError(new Error('Client initiated disconnect'))).toBe(false);
        expect(isMediaDeviceUnavailableError(null)).toBe(false);
        expect(isMediaDeviceUnavailableError('NotFoundError')).toBe(false); // a bare string is not an error object
    });
});

describe('describeMediaDeviceUnavailable', () => {
    it('mic-only join: says they are in, muted, and how to fix it', () => {
        const t = describeMediaDeviceUnavailable(dom('NotFoundError'), false);
        expect(t.title).toBe('No microphone found');
        expect(t.message).toMatch(/joined the call muted/);
    });
    it('busy device reads as busy', () => {
        expect(describeMediaDeviceUnavailable(dom('NotReadableError'), false).title).toBe('Your microphone is busy');
    });
    it('camera also requested: does not claim it was the mic', () => {
        expect(describeMediaDeviceUnavailable(dom('NotFoundError'), true).title).toBe('No microphone or camera found');
    });
});

describe('CallPane wiring (no render harness: pinned at the source level)', () => {
    const src = readFileSync(join(__dirname, '..', 'components', 'CallPane.tsx'), 'utf8');
    const start = src.indexOf('onError={(err) => {');
    const body = src.slice(start, start + 1400);

    it('onError checks for a device problem BEFORE failing the connection, and returns', () => {
        expect(start).toBeGreaterThan(-1);
        const check = body.indexOf('isMediaDeviceUnavailableError(err)');
        const fail = body.indexOf('failConnection(');
        expect(check).toBeGreaterThan(-1);
        expect(fail).toBeGreaterThan(check);
        expect(body.slice(check, fail)).toMatch(/return;/);
    });

    it('the person is told (a toast), it is not silent', () => {
        expect(body).toMatch(/describeMediaDeviceUnavailable\(err,/);
        expect(body).toMatch(/toast\.push\(\{ kind: 'warning', title, message \}\)/);
    });

    it('control: every other error still fails the call as before', () => {
        expect(body).toContain("failConnection(err.message || \"Couldn't connect to the call.\", 'connect', err);");
    });
});
