// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// clPhysics (pulled in by ClButton) calls matchMedia at module load.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});

import { ClBannerOverlay } from './ClBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;


let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});
const overlay = () => {
    act(() => root.render(React.createElement(ClBannerOverlay, { testId: 'o', children: 'x' })));
    return host.querySelector('[data-testid="o"]') as HTMLElement;
};

describe('banners line up with what is below them', () => {
    it('an overlay takes the edges of the main column', () => {
        const column = document.createElement('div');
        column.setAttribute('data-banner-column', '');
        column.getBoundingClientRect = () => ({ left: 72, width: 1238 }) as DOMRect;
        document.body.appendChild(column);
        const el = overlay();
        expect(el.hasAttribute('data-aligned')).toBe(true);
        expect(el.style.getPropertyValue('--cl-banner-left')).toBe('72px');
        expect(el.style.getPropertyValue('--cl-banner-width')).toBe('1238px');
    });

    it('with no main column (the login screen) it stays centred', () => {
        expect(overlay().hasAttribute('data-aligned')).toBe(false);
    });

    it('the stack adds no side padding, and the Dashboard marks the column', () => {
        const css = readFileSync(join(__dirname, '..', 'styles', 'cl-banner.css'), 'utf8');
        expect(css).toMatch(/\.cl-banner-stack \{[^}]*padding: 0 0 8px;/);
        const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
        const column = dash.indexOf('<div data-banner-column=""');
        expect(column).toBeGreaterThan(0);
        expect(column).toBeLessThan(dash.indexOf('<ClBannerStack>'));
    });
});
