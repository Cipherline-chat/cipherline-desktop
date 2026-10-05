import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf8');

describe('picker search polish', () => {
    it('the emoji picker focuses its search box on open (message bar and reaction pickers share it)', () => {
        const src = read('./EmojiPicker.tsx');
        const i = src.indexOf('<Picker\n');
        expect(src.slice(i, i + 900)).toMatch(/\bautoFocus\b/);
    });

    it('the GIF picker clear (X) button is a neutral gray, not the kit ghost blue', () => {
        const src = read('./GifPicker.tsx');
        expect(src).toContain('className="gif-clear-btn"');
        expect(src).toMatch(/\.gif-clear-btn \.cap \{[^}]*color: rgba\(255,255,255,0\.5\)/s);
        expect(src).toMatch(/\.gif-clear-btn \.cap \{[^}]*background-color: transparent/s);
    });
});
