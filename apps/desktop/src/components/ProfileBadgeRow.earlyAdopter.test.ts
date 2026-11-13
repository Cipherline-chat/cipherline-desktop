// @vitest-environment jsdom
/**
 * The permanent Founder badge on the profile-badge row. The API sends it
 * as one more entry of the ordinary `badges` array (icon `rocket`, colour
 * `purple`), so it renders everywhere admin badges do - including the dense
 * Friends rows.
 * Friends rows. Its popover says what it is and never shows a number (to anyone).
 */
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProfileBadgeRow, ProfileBadgeStrip } from './ProfileBadgeRow';
import type { ProfileBadge } from '../utils/profileBadges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    document.body.querySelectorAll('.pbm-pop').forEach((n) => n.remove());
    root = null; host = null;
});
function mount(el: React.ReactElement): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
}

const PUBLIC_LABEL = 'Founder · one of the first 10,000 Cipherline subscribers';
const publicBadge: ProfileBadge = { badge_id: 'early-adopter', icon: 'rocket', color: 'purple', label: PUBLIC_LABEL, sort_order: 900 };

const open = (el: HTMLElement) => {
    const btn = el.querySelector('button.pbm--btn') as HTMLButtonElement;
    act(() => { btn.click(); });
    return document.body.querySelector('.pbm-pop') as HTMLElement;
};

describe('Founder badge (wire id early-adopter)', () => {
    it('renders on the dense friends row (sm): a rocket medallion with the public label, non-interactive', () => {
        const el = mount(h(ProfileBadgeRow, { badges: [publicBadge], size: 'sm' }));
        const medallion = el.querySelector('.pbm')!;
        expect(medallion).not.toBeNull();
        expect(medallion.getAttribute('aria-label')).toBe(PUBLIC_LABEL);
        expect(medallion.querySelector('svg')).not.toBeNull();            // the rocket, not nothing
        expect(el.querySelector('button')).toBeNull();                     // dense rows are not interactive
        expect(medallion.className).toMatch(/purple/);
    });

    it("a stranger's popover says it is one of the first 10,000 subscribers and shows NO number", () => {
        const el = mount(h(ProfileBadgeStrip, { badges: [publicBadge] }));
        const pop = open(el);
        expect(pop.textContent).toContain('Founder');
        expect(pop.textContent).toContain("One of Cipherline's first 10,000 subscribers.");
        expect(pop.textContent).toContain('A permanent badge.');
        expect(pop.textContent).not.toMatch(/#\d|1234/);
    });

    it('a staff-granted Founder (no number) renders the same badge and shows no number', () => {
        const pop = open(mount(h(ProfileBadgeStrip, { badges: [publicBadge] })));
        expect(pop.textContent).toContain('Founder');
        expect(pop.textContent).not.toMatch(/#\d/);
    });

    it('NEGATIVE: a stray founder_number from an old server is ignored, never shown', () => {
        const stray = { ...publicBadge, founder_number: 1234 } as ProfileBadge;
        const pop = open(mount(h(ProfileBadgeStrip, { badges: [stray] })));
        expect(pop.textContent).toContain("One of Cipherline's first 10,000 subscribers.");
        expect(pop.textContent).not.toMatch(/1234|#\d/);
    });

    it('sits with the other badges: an admin badge, then Founder, then Egg hunter', () => {
        const admin: ProfileBadge = { badge_id: 'b1', icon: 'star', color: 'gold', label: 'Staff', sort_order: 0 };
        const egg: ProfileBadge = { badge_id: 'egg-hunter', icon: 'egg-tier-2', color: 'orange', label: 'Egg hunter · Reefcomber · 8 easter eggs found', sort_order: 1000, count: 8 };
        const el = mount(h(ProfileBadgeRow, { badges: [egg, publicBadge, admin], size: 'sm' }));
        expect(Array.from(el.querySelectorAll('.pbm')).map((n) => n.getAttribute('aria-label'))).toEqual([
            'Staff', PUBLIC_LABEL, 'Egg hunter · Reefcomber · 8 easter eggs found',
        ]);
    });
});
