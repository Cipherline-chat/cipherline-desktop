/**
 * The screen share's FRAME path must never depend on the page being painted
 * or visible.
 *
 * Owner report (2026-10-11): "When Cipherline is not focused, the screenshare
 * fps tanks to 1 or 2 fps". The first suspect was a requestAnimationFrame or
 * visibility-driven stage between the capturer and the encoder — rAF stops
 * (or drops to about once a second) when a window is minimised or occluded,
 * whatever backgroundThrottling says. There is none today: the capture is
 * Chromium's native desktop capturer, the lighter copy is an encoder
 * simulcast layer, and E2EE runs on encoded streams in a worker. Measured in
 * Electron 43.2.0 (claude/share-fps-unfocused harness): that pipeline kept
 * its send rate with the page hidden (rAF 0 Hz, timers 1 Hz), while a
 * rAF-driven canvas source fell to 0 fps — so adding such a stage is exactly
 * how this bug WOULD be created. This test fails the moment one appears in a
 * share-path module. Comments are stripped first, so explaining why an API is
 * not used is fine.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Modules on the path from capturer to wire for OUR share. */
const SHARE_FRAME_PATH = [
    'utils/screenShare.ts',            // capture constraints, encoder params, in-place retune
    'utils/shareLowLayer.ts',          // the lighter copy (encoder simulcast layer)
    'utils/e2eeAnnexB.ts',             // runs inside the E2EE worker on every encoded frame
    'utils/e2eeSenderCodec.ts',        // sender codec pin for the E2EE worker
    'workers/e2eeWorker.ts',           // the E2EE worker itself
    'utils/shareBackgroundProbe.ts',   // the background probe (stats only)
];

/** Anything that is frame-, paint- or visibility-gated, or a renderer-side frame loop. */
const GATED = [
    /\brequestAnimationFrame\b/,
    /\brequestVideoFrameCallback\b/,
    /\bcaptureStream\s*\(/,
    /\bMediaStreamTrackProcessor\b/,
    /\bMediaStreamTrackGenerator\b/,
    /\bVideoTrackGenerator\b/,
    /\bOffscreenCanvas\b/,
    /\bvisibilityState\b/,
    /\bdocument\.hidden\b/,
];

/** Drop block and line comments (strings in these files never contain comment markers). */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('screen-share frame path is never paint- or visibility-gated', () => {
    it('positive control: the scan catches a gated stage and ignores one in a comment', () => {
        const hit = (s: string) => GATED.some(re => re.test(stripComments(s)));
        expect(hit('const id = requestAnimationFrame(tick);')).toBe(true);
        expect(hit('const s = canvas.captureStream(90);')).toBe(true);
        expect(hit('if (document.hidden) pause();')).toBe(true);
        expect(hit('// requestAnimationFrame stops when minimised, so we do not use it')).toBe(false);
        expect(hit('/* canvas.captureStream(90) would be frame-gated */ const x = 1;')).toBe(false);
    });

    for (const rel of SHARE_FRAME_PATH) {
        it(rel, () => {
            const code = stripComments(readFileSync(join(SRC, rel), 'utf8'));
            const found = GATED.filter(re => re.test(code)).map(re => re.source);
            expect(found).toEqual([]);
        });
    }
});
