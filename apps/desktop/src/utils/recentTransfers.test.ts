import { describe, expect, it, beforeEach } from 'vitest';
import {
    recordOpenedTransfer, wasTransferOpenedByThisDevice, shouldShowQrAuthorisedLine,
    _resetRecentTransfersForTest,
} from './recentTransfers';

/**
 * QR-6 (adversarial review): `HistoryRequestModal` must render "Authorised by
 * a code scanned on this device" ONLY when the request's `transfer_id`
 * matches one this device itself opened — never on the server's `via: 'qr'`
 * claim alone, which a compromised API pod could attach to any request.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();

beforeEach(() => {
    _resetRecentTransfersForTest();
});

describe('wasTransferOpenedByThisDevice', () => {
    it('is true right after this device records opening a transfer', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(wasTransferOpenedByThisDevice('XFER1', T0)).toBe(true);
    });

    it('is true up to and including the 120s window boundary', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(wasTransferOpenedByThisDevice('XFER1', T0 + 120_000)).toBe(true);
    });

    it('is false once the 120s window has passed', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(wasTransferOpenedByThisDevice('XFER1', T0 + 120_001)).toBe(false);
    });

    it('is false for an id this device never opened', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(wasTransferOpenedByThisDevice('SOME-OTHER-ID', T0)).toBe(false);
    });

    it('is false — fails closed — for a missing/empty id', () => {
        expect(wasTransferOpenedByThisDevice(undefined, T0)).toBe(false);
        expect(wasTransferOpenedByThisDevice(null, T0)).toBe(false);
        expect(wasTransferOpenedByThisDevice('', T0)).toBe(false);
    });
});

describe('shouldShowQrAuthorisedLine — the HistoryRequestModal render gate', () => {
    it('renders on a match: via is "qr" AND the transfer_id was opened by this device', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(shouldShowQrAuthorisedLine({ via: 'qr', transfer_id: 'XFER1' }, T0)).toBe(true);
    });

    it('QR-6 core case: via is "qr" but transfer_id is unknown to this device — renders nothing', () => {
        // Nothing was ever recorded for this id — e.g. a compromised API pod
        // attached via:'qr' to a request this device never opened a QR for.
        expect(shouldShowQrAuthorisedLine({ via: 'qr', transfer_id: 'NEVER-OPENED' }, T0)).toBe(false);
    });

    it('QR-6 core case: via is "qr" but transfer_id is absent entirely — renders nothing', () => {
        expect(shouldShowQrAuthorisedLine({ via: 'qr' }, T0)).toBe(false);
    });

    it('does not render for an ordinary in-app request (no via at all), even with a coincidentally-matching id', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(shouldShowQrAuthorisedLine({ transfer_id: 'XFER1' }, T0)).toBe(false);
    });

    it('does not render once the transfer is outside the 120s window, even with a real match', () => {
        recordOpenedTransfer('XFER1', T0);
        expect(shouldShowQrAuthorisedLine({ via: 'qr', transfer_id: 'XFER1' }, T0 + 120_001)).toBe(false);
    });

    it('handles a null/undefined request', () => {
        expect(shouldShowQrAuthorisedLine(null, T0)).toBe(false);
        expect(shouldShowQrAuthorisedLine(undefined, T0)).toBe(false);
    });
});
