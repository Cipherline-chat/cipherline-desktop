import { describe, expect, it, vi } from 'vitest';
import { TransferQrController, type TransferQrDeps } from '../../utils/transferQrController';
import { buildXferQr } from '../../utils/linkQr';

/**
 * Covers `TransferQrPanel.tsx`'s behaviour via the controller it is a thin
 * view over — same rationale and `.test.ts` (not `.test.tsx`) naming as
 * `QrSignInPanel.test.ts`: `apps/desktop`'s vitest has no DOM and its
 * `include` glob only matches `*.test.ts`.
 *
 * Full design: docs/QR-LINKING.md §3.
 */

const COUNTDOWN_TICK_MS = 250;
const TTL_MS = 120_000;
const TRANSFER_ID = 'XFER123';

function makeDeps(overrides: Partial<TransferQrDeps> = {}): TransferQrDeps {
    const now = Date.now();
    return {
        createTransfer: vi.fn().mockResolvedValue({
            transfer_id: TRANSFER_ID,
            expires_at: new Date(now + TTL_MS).toISOString(),
            ttl_s: TTL_MS / 1000,
        }),
        renderQr: vi.fn().mockResolvedValue('data:image/png;base64,FAKE'),
        buildQrText: vi.fn(buildXferQr),
        recordOpenedTransfer: vi.fn(),
        countdownTickMs: COUNTDOWN_TICK_MS,
        ...overrides,
    };
}

describe('TransferQrController', () => {
    it('stops the countdown at expiry and moves to the expired state', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps();
            const controller = new TransferQrController(deps);

            await controller.begin();
            expect(controller.getSnapshot().phase).toBe('active');
            expect(vi.getTimerCount()).toBeGreaterThan(0); // the countdown interval is armed

            await vi.advanceTimersByTimeAsync(TTL_MS);

            expect(controller.getSnapshot().phase).toBe('expired');
            expect(controller.getSnapshot().remainingS).toBe(0);
            // The interval was genuinely cleared, not just displaying 0 while
            // still ticking in the background.
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('never auto-refreshes — no new transfer is created after expiry', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps();
            const controller = new TransferQrController(deps);

            await controller.begin();
            await vi.advanceTimersByTimeAsync(TTL_MS + COUNTDOWN_TICK_MS * 4);

            expect(controller.getSnapshot().phase).toBe('expired');
            expect(deps.createTransfer).toHaveBeenCalledTimes(1); // still just the original call
        } finally {
            vi.useRealTimers();
        }
    });

    it('builds the QR text from the transfer id alone, with no key material', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const buildQrText = vi.fn((transferId: string) => `built:${transferId}`);
            const deps = makeDeps({ buildQrText });
            const controller = new TransferQrController(deps);

            await controller.begin();

            expect(buildQrText).toHaveBeenCalledTimes(1);
            expect(buildQrText).toHaveBeenCalledWith(TRANSFER_ID);
            expect(controller.getSnapshot().qrDataUrl).toBe('data:image/png;base64,FAKE');
        } finally {
            vi.useRealTimers();
        }
    });

    it('QR-6: records the transfer id as opened by this device the moment the QR renders', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps();
            const controller = new TransferQrController(deps);

            await controller.begin();

            expect(deps.recordOpenedTransfer).toHaveBeenCalledTimes(1);
            expect(deps.recordOpenedTransfer).toHaveBeenCalledWith(TRANSFER_ID);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancel() clears the timer and returns to idle', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
            const deps = makeDeps();
            const controller = new TransferQrController(deps);

            await controller.begin();
            expect(controller.getSnapshot().phase).toBe('active');

            controller.cancel();
            expect(controller.getSnapshot().phase).toBe('idle');
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('buildXferQr', () => {
    it('matches docs/QR-LINKING.md §3.2\'s wire format exactly', () => {
        const text = buildXferQr(TRANSFER_ID);
        expect(text).toBe(`cipherline://xfer/1?t=${TRANSFER_ID}`);
    });

    it('QR-4: percent-encodes a server-supplied transferId, same defence-in-depth as buildLinkQr', () => {
        const withSpecialChars = `${TRANSFER_ID}&x=injected`;
        const text = buildXferQr(withSpecialChars);
        expect(text).toBe(`cipherline://xfer/1?t=${encodeURIComponent(withSpecialChars)}`);
        expect(text).not.toContain('&x=injected');
    });
});
