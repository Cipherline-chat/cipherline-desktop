import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(resolve(__dirname, './KlipyGifEmbed.tsx'), 'utf8');
const lightbox = readFileSync(resolve(__dirname, './ImageLightbox.tsx'), 'utf8');

describe('KlipyGifEmbed layout + viewer', () => {
    it('shows no KLIPY watermark on the GIF itself (not required by KLIPY)', () => {
        expect(src).not.toMatch(/>\s*KLIPY\s*</);
        expect(src).not.toMatch(/left:\s*6,\s*bottom:\s*6/);
    });

    it('shrink-wraps to the GIF so the absolute save button sits on it, not at the far right of a stretched row', () => {
        expect(src).toContain("width: 'fit-content'");
        expect(src).toContain("alignSelf: 'flex-start'");
    });

    it('opens the shared full-size viewer on click, without sending a referrer to KLIPY', () => {
        expect(src).toContain("import { ImageLightbox } from './ImageLightbox'");
        expect(src).toContain('setLightboxOpen(true)');
        expect(src).toContain('referrerPolicy="no-referrer"');
        expect(lightbox).toContain('referrerPolicy={referrerPolicy}');
    });
});

describe('GIF picker search field colour', () => {
    const picker = readFileSync(resolve(__dirname, './GifPicker.tsx'), 'utf8');
    it('is neutral gray like the popover, not the kit\'s navy, in resting and focus states', () => {
        expect(picker).toContain('.gif-search-input.inp {');
        expect(picker).toMatch(/\.gif-search-input\.inp\s*\{\s*background:\s*rgba\(255,255,255,0\.06\)/);
        expect(picker).not.toMatch(/\.gif-search-input:focus\s*\{\s*border-color:\s*rgba\(37,224,200/);
    });
});

describe('KlipyLinkEmbed (pasted KLIPY links)', () => {
    it('loads straight from KLIPY with no referrer, behind the opt-in, with no save button', () => {
        const i = src.indexOf('export const KlipyLinkEmbed');
        const body = src.slice(i);
        expect(body).toContain('isKlipyMediaUrl(url)');
        expect(body).toContain('!klipyEnabled && !tapped');
        expect(body).toContain('referrerPolicy="no-referrer"');
        expect(body).not.toContain('img-gif-save-btn');
        expect(body).not.toContain('fetchBinary');
        // same 300px box as a sent GIF — a pasted link must not render bigger
        expect(body).toContain("maxWidth: 'min(300px, 100%)', maxHeight: 300");
    });
});
