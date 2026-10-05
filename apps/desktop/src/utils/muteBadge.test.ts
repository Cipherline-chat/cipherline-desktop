import { describe, it, expect } from 'vitest';
import { shouldShowMuteBadge, type CallConnectionState } from './muteBadge';

const NOT_YET_CONNECTED: CallConnectionState[] = ['connecting', 'reconnecting', 'signalReconnecting', 'disconnected'];

describe('shouldShowMuteBadge', () => {
    it('hides the badge when no track has published yet, during any non-connected phase', () => {
        for (const state of NOT_YET_CONNECTED) {
            expect(shouldShowMuteBadge(false, false, state)).toBe(false);
        }
    });

    it('this is the false-positive the bug report describes: ringing/connecting, no track yet, "enabled" reads false — must NOT show a badge', () => {
        expect(shouldShowMuteBadge(false, false, 'connecting')).toBe(false);
    });

    it('once fully connected, a still-absent track falls back to "muted" (no mic device, permission denied, etc.) — preserves pre-fix behaviour instead of hiding it forever', () => {
        expect(shouldShowMuteBadge(false, false, 'connected')).toBe(true);
        expect(shouldShowMuteBadge(false, true, 'connected')).toBe(true); // defensive: hasTrack always governs when false
    });

    it('a published track is authoritative and genuinely-muted must show, in every connection phase (no suppressing a real mute)', () => {
        for (const state of [...NOT_YET_CONNECTED, 'connected'] as CallConnectionState[]) {
            expect(shouldShowMuteBadge(true, false, state)).toBe(true);
        }
    });

    it('a published, unmuted track never shows the badge, in every connection phase', () => {
        for (const state of [...NOT_YET_CONNECTED, 'connected'] as CallConnectionState[]) {
            expect(shouldShowMuteBadge(true, true, state)).toBe(false);
        }
    });
});
