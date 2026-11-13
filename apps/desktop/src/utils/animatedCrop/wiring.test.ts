import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source guards for the animated server art / avatar / banner wiring (the
 * vitest env has no full render harness for these screens). The behaviour is
 * proven in pipeline.test / client.test / the two render tests; this pins which
 * surfaces opt in and that nothing was left uploading an animation as a JPEG.
 */
const src = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(join(src, rel), 'utf8');

describe('which cropper surfaces keep an animation', () => {
    it('avatar / profile banner and server icon / banner opt in', () => {
        expect(read('components/settings/panes/ProfilePane.tsx')).toMatch(/<ClImageCropper[\s\S]*?allowAnimated[\s\S]*?\/>/);
        expect(read('components/server/ServerSettingsModal.tsx')).toMatch(/<ClImageCropper[\s\S]*?allowAnimated[\s\S]*?\/>/);
    });

    it('group icons and the template-import icon do NOT (they never render animation)', () => {
        for (const f of ['components/GroupSettingsModal.tsx', 'components/CreateGroupModal.tsx', 'components/server/DiscordTemplateImport.tsx']) {
            expect(read(f)).not.toContain('allowAnimated');
        }
    });

    it('the cropper defaults to the old flatten-to-JPEG behaviour', () => {
        expect(read('components/cl/ClImageCropper.tsx')).toContain('allowAnimated = false');
    });
});

describe('server icon / banner upload keeps the cropped image\'s own type', () => {
    const modal = read('components/server/ServerSettingsModal.tsx');
    it('the MIME comes from the blob, not a hard-coded JPEG', () => {
        expect(modal).toContain("blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg'");
        expect(modal).not.toMatch(/server-icon\.jpg'\s*:\s*'server-banner\.jpg',\s*'image\/jpeg'/);
        expect(modal).not.toMatch(/uploadEncryptedFile\(\s*blob,[^)]*'image\/jpeg'\s*,?\s*\)/);
    });
    it('profile avatar and banner already upload with the blob\'s own type', () => {
        const pane = read('components/settings/panes/ProfilePane.tsx');
        expect(pane).toContain("avatarFile.type || 'image/jpeg'");
        expect(pane).toContain("bannerFile.type || 'image/jpeg'");
    });
});

describe('where server art plays', () => {
    it('the open server\'s banner and the settings previews animate; the home tiles are hover-to-play', () => {
        expect(read('components/server/ServerChannelList.tsx')).toMatch(/className="w-full h-full object-cover"\s+animate\s*\/>/);
        const modal = read('components/server/ServerSettingsModal.tsx');
        expect((modal.match(/^\s+animate\s*$/gm) ?? []).length).toBe(3);
        // the home tiles pass nothing: ServerIcon's own hover plays them. The rail is
        // railIconAnimatesWhenOpen.test.ts: only the server you're in plays there.
        expect(read('components/HomePanel.tsx')).not.toMatch(/<ServerIcon[^>]*\banimate\b/);
    });

    it('ServerIcon uses the same gate as avatars: still frame, hover, and app-in-front', () => {
        const icon = read('components/server/ServerIcon.tsx');
        expect(icon).toContain('useStillGate(fullUrl, mime, animate || hovered || playing)');
    });
});

describe('the worker', () => {
    const worker = read('workers/animatedCrop.worker.ts');
    it('decodes with ImageDecoder, encodes through a canvas, and uses no dynamic import', () => {
        expect(worker).toContain('new ImageDecoder');
        expect(worker).toContain("convertToBlob({ type: 'image/webp'");
        expect(worker).not.toMatch(/\bimport\s*\(/);
    });
    it('is constructed in the one form Vite bundles (see workerBundling.test.ts)', () => {
        expect(read('utils/animatedCrop/client.ts')).toMatch(/new Worker\(\s*new URL\('\.\.\/\.\.\/workers\/animatedCrop\.worker\.ts', import\.meta\.url\)/);
    });
});
