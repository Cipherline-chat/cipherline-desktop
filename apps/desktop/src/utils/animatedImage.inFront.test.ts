// @vitest-environment jsdom
/**
 * Always-animating avatars / banners (profile cards, the DM panel) freeze when
 * Cipherline is not the window in front (owner 2026-10-27): useAppInFront.
 */
import { describe, it, expect, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useAppInFront } from './animatedImage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const here = dirname(fileURLToPath(import.meta.url));

describe('useAppInFront', () => {
    it('follows window focus / blur, with one shared set of listeners', () => {
        vi.spyOn(document, 'hasFocus').mockReturnValue(true);
        const seen: boolean[] = [];
        const Probe = () => { seen.push(useAppInFront()); return null; };
        const add = vi.spyOn(window, 'addEventListener');
        const host = document.createElement('div');
        const root = createRoot(host);
        act(() => root.render(React.createElement(React.Fragment, null, React.createElement(Probe), React.createElement(Probe))));
        expect(seen.at(-1)).toBe(true);
        expect(add.mock.calls.filter(([t]) => t === 'blur').length).toBeLessThanOrEqual(1);
        act(() => { window.dispatchEvent(new Event('blur')); });
        expect(seen.at(-1)).toBe(false);
        act(() => { window.dispatchEvent(new Event('focus')); });
        expect(seen.at(-1)).toBe(true);
        act(() => root.unmount());
    });

    it('the rule lives in the gate, so no caller decides it (owner 2026-10-31: nothing plays unfocused)', () => {
        const gate = readFileSync(join(here, 'animatedImage.ts'), 'utf8');
        expect(gate).toContain('pickDisplayUrl(url, mime, animate && inFront,');
        const avatar = readFileSync(join(here, '../components/EncryptedAvatar.tsx'), 'utf8');
        expect(avatar).toContain('animate || hovered || playing || talking');
        expect(avatar).not.toContain('useAppInFront');
        const banner = readFileSync(join(here, '../components/Banner.tsx'), 'utf8');
        expect(banner).not.toContain('useAppInFront');
        const emoji = readFileSync(join(here, '../components/server/EmojiImage.tsx'), 'utf8');
        expect(emoji).toContain('useFrozenWhenAway(url)');
    });
});
