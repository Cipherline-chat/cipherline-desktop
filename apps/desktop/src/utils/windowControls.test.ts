import { describe, it, expect } from 'vitest';
import { drawsOwnWindowControls } from './windowControls';

const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Cipherline/0.1.2 Chrome/150.0.0.0 Electron/43.8.7 Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Electron/43.8.7';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/43.8.7';

describe('drawsOwnWindowControls (decision table)', () => {
    it.each([
        // inElectron, userAgent, overlayVisible, expected
        [false, LINUX, undefined, false],   // plain browser: no window to control
        [true, MAC, undefined, false],      // traffic lights
        [true, MAC, false, false],
        [true, WINDOWS, true, false],       // native overlay
        [true, WINDOWS, false, false],      // Windows never draws its own, even if the overlay reports hidden
        [true, LINUX, true, false],         // native overlay on Linux (the normal case now)
        [true, LINUX, false, true],         // Linux window without the overlay: fallback buttons
        [true, LINUX, undefined, true],     // no Window Controls Overlay API at all: fallback buttons
    ] as const)('electron=%s ua=%#, overlay=%s -> %s', (inElectron, userAgent, overlayVisible, expected) => {
        expect(drawsOwnWindowControls({ inElectron, userAgent, overlayVisible })).toBe(expected);
    });
});
