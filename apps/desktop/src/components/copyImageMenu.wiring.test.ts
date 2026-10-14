/**
 * Wiring checks for "Copy image" (behaviour of the pieces is covered in
 * utils/copyImage.test.ts and electron/clipboard-image.test.ts). The message
 * menu is built inside the ChatPane monolith, so these pin that it goes
 * through the gate and that the IPC channel is wired end to end.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('Copy image wiring', () => {
    const chat = read('./ChatPane.tsx');

    it('the message context menu adds "Copy image" only behind copyImageSourceFor', () => {
        const at = chat.indexOf("label: 'Copy image'");
        expect(at).toBeGreaterThan(0);
        const before = chat.slice(Math.max(0, at - 400), at);
        expect(before).toMatch(/if \(copyImageUrl\)/);
        expect(chat).toMatch(/const copyImageUrl = copyImageSourceFor\(\{/);
        // the attachment URL is the decrypted one, nothing else
        expect(chat).toMatch(/attachmentUrl: objectUrls\[msg\.id\] \?\? null/);
        expect(chat).toMatch(/attachmentMime: msg\.content\?\.mime/);
    });

    it('the image-link embed exposes only its local blob URL to the menu', () => {
        expect(chat).toMatch(/data-cl-copy-image=\{blobUrl \?\? undefined\}/);
    });

    it('the lightbox offers Copy image for blob: images only', () => {
        const lb = read('./ImageLightbox.tsx');
        expect(lb).toMatch(/if \(!src\.startsWith\('blob:'\)\) return;/);
        expect(lb).toMatch(/label: 'Copy image'/);
        expect(lb).toMatch(/onContextMenu=\{onImageContextMenu\}/);
    });

    it('the IPC channel is wired preload -> main with validation, and typed', () => {
        const preload = read('../../electron/preload.ts');
        const main = read('../../electron/main.ts');
        const dts = read('../env.d.ts');
        expect(preload).toMatch(/clipboardWriteImage:[^\n]*ipcRenderer\.invoke\('clipboard:write-image', png\)/);
        expect(main).toMatch(/ipcMain\.handle\('clipboard:write-image'[\s\S]{0,200}validateClipboardPng\(data\)/);
        expect(main).toMatch(/clipboard\.writeImage\(image\)/);
        expect(dts).toMatch(/clipboardWriteImage\?: \(png: Uint8Array\) => Promise<void>/);
    });

    it('the renderer util never fetches a remote URL for copying', () => {
        const util = read('../utils/copyImage.ts');
        expect(util).toMatch(/startsWith\('blob:'\)/);
        expect(util).not.toMatch(/fetchBinary/);
    });
});
