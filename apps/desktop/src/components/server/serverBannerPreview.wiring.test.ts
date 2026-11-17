import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source guard for the Server Settings banner preview (no render harness for
 * the settings dock). The shape maths is proven in utils/imageCrop.test.ts
 * (`cssAspectRatio`); this pins that the preview USES it — i.e. the box after
 * cropping is the crop's own 2.5:1 shape, not the old full-width h-32 strip
 * that re-cropped the image with object-cover.
 */
const src = join(dirname(fileURLToPath(import.meta.url)), '../..');
const modal = readFileSync(join(src, 'components/server/ServerSettingsModal.tsx'), 'utf8');

describe('Server Settings banner preview is the crop\'s shape', () => {
    it('derives its aspect ratio from BANNER_OUTPUT, the same size the cropper is given', () => {
        expect(modal).toMatch(/const BANNER_ASPECT = cssAspectRatio\(BANNER_OUTPUT\);/);
        expect(modal).toMatch(/outputWidth=\{cropTarget\?\.kind === 'banner' \? BANNER_OUTPUT\.width/);
        expect(modal).toMatch(/outputHeight=\{cropTarget\?\.kind === 'banner' \? BANNER_OUTPUT\.height/);
    });

    it('the preview box carries that aspect ratio and no fixed height', () => {
        const box = modal.match(/data-testid="server-banner-preview"[\s\S]*?>/)?.[0] ?? '';
        expect(box).toContain('style={{ aspectRatio: BANNER_ASPECT }}');
        expect(box).not.toMatch(/\bh-\d+\b|\bh-\[/);
    });

    it('is a real button (keyboard-reachable), not a clickable div', () => {
        expect(modal).toMatch(/<button\s+type="button"\s+data-testid="server-banner-preview"/);
    });
});
