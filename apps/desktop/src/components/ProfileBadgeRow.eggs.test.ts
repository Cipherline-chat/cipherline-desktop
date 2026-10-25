// @vitest-environment jsdom
/**
 * The Egg hunter badge on the profile-badge row. The API sends it as one more
 * entry of the ordinary `badges` array (icon `egg-tier-N`, colour name, the
 * "Egg hunter · Deep Diver · 12 easter eggs found" label), so it must render
 * everywhere admin badges do, with its own glyph per tier, and degrade like any
 * unrecognised icon when it drifts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProfileBadgeRow } from './ProfileBadgeRow';
import { EggTierIcon } from './EggTierIcon';
import type { ProfileBadge } from '../utils/profileBadges';
import { EGG_TIERS, EGG_TIER_COLORS } from '../utils/eggProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
    if (root) act(() => root!.unmount());
    host?.remove();
    root = null; host = null;
});

function mount(el: React.ReactElement): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
}

const egg = (tier: number, count: number): ProfileBadge => ({
    badge_id: 'egg-hunter',
    icon: `egg-tier-${tier}`,
    color: EGG_TIER_COLORS[tier],
    label: `Egg hunter · ${EGG_TIERS[tier - 1].name} · ${count} easter eggs found`,
    sort_order: 1000,
    count,
});

describe('EggTierIcon', () => {
    it.each([1, 2, 3, 4])('tier %i renders its own decorative svg', (tier) => {
        const el = mount(h(EggTierIcon, { tier, size: 20 }));
        const svg = el.querySelector('svg')!;
        expect(svg).not.toBeNull();
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('data-egg-tier')).toBe(String(tier));
        expect(svg.querySelectorAll('path,circle').length).toBeGreaterThan(2);
    });

    it('the four glyphs are four different drawings', () => {
        const markup = [1, 2, 3, 4].map((tier) => {
            const el = mount(h(EggTierIcon, { tier }));
            const html = el.querySelector('svg')!.innerHTML;
            act(() => root!.unmount()); host!.remove(); root = null; host = null;
            return html;
        });
        expect(new Set(markup).size).toBe(4);
    });

    it('renders nothing for a tier it does not know', () => {
        expect(mount(h(EggTierIcon, { tier: 9 })).querySelector('svg')).toBeNull();
    });
});

describe('ProfileBadgeRow with the Egg hunter badge', () => {
    it.each([[1, 3], [2, 7], [3, 12], [4, 18]])('tier %i shows the tier glyph with the full hover label', (tier, count) => {
        const el = mount(h(ProfileBadgeRow, { badges: [egg(tier, count)] }));
        const chip = el.querySelector('[role="img"]')!;
        expect(chip.getAttribute('aria-label')).toBe(`Egg hunter · ${EGG_TIERS[tier - 1].name} · ${count} easter eggs found`);
        expect(chip.querySelector(`svg[data-egg-tier="${tier}"]`)).not.toBeNull();
        expect(chip.className).toContain(tier === 4 ? 'text-cl-glow' : 'text-');
    });

    it('sits after an admin badge and both render', () => {
        const admin: ProfileBadge = { badge_id: 'b1', icon: 'star', color: 'gold', label: 'Founder', sort_order: 0 };
        const el = mount(h(ProfileBadgeRow, { badges: [egg(3, 12), admin] }));
        const chips = [...el.querySelectorAll('[role="img"]')];
        expect(chips.map(c => c.getAttribute('aria-label'))).toEqual(['Founder', 'Egg hunter · Deep Diver · 12 easter eggs found']);
        expect(chips[0].querySelector('svg[data-egg-tier]')).toBeNull();
        expect(chips[1].querySelector('svg[data-egg-tier="3"]')).not.toBeNull();
    });

    it('an out-of-range egg tier from a future server falls back to the generic glyph, label intact', () => {
        const future: ProfileBadge = { ...egg(1, 3), icon: 'egg-tier-7', label: 'Egg hunter · Something New · 40 easter eggs found' };
        const el = mount(h(ProfileBadgeRow, { badges: [future] }));
        const chip = el.querySelector('[role="img"]')!;
        expect(chip.querySelector('svg[data-egg-tier]')).toBeNull();
        expect(chip.querySelector('svg')).not.toBeNull();
        expect(chip.getAttribute('aria-label')).toContain('Something New');
    });

    it('renders at the dense list size too', () => {
        const el = mount(h(ProfileBadgeRow, { badges: [egg(2, 7)], size: 'sm' }));
        expect((el.querySelector('[role="img"]') as HTMLElement).style.width).toBe('16px');
        expect(el.querySelector('svg[data-egg-tier="2"]')).not.toBeNull();
    });

    it('full-size row shows the count as a bubble on the tier medallion', () => {
        const el = mount(h(ProfileBadgeRow, { badges: [egg(3, 12)] }));
        const chip = el.querySelector('[role="img"]') as HTMLElement;
        const num = chip.querySelector('[data-egg-count]')!;
        expect(num.textContent).toBe('12');
        expect(num.getAttribute('aria-hidden')).toBe('true');
        expect(num.className).toContain('pbm-count');
        expect(chip.querySelector('svg[data-egg-tier="3"]')).not.toBeNull();
        // the medallion keeps the set's one round shape; the count rides on it
        expect(chip.style.width).toBe('24px');
        expect(chip.style.height).toBe('24px');
        // tooltip / aria label unchanged
        expect(chip.getAttribute('aria-label')).toBe('Egg hunter · Deep Diver · 12 easter eggs found');
    });

    it('the dense sm row stays icon-only even when a count is present', () => {
        const el = mount(h(ProfileBadgeRow, { badges: [egg(3, 12)], size: 'sm' }));
        expect(el.querySelector('[data-egg-count]')).toBeNull();
        expect((el.querySelector('[role="img"]') as HTMLElement).style.width).toBe('16px');
    });

    it('no count on the wire (older server) renders the plain icon swatch', () => {
        const { count: _omit, ...noCount } = egg(2, 7);
        const el = mount(h(ProfileBadgeRow, { badges: [noCount] }));
        expect(el.querySelector('[data-egg-count]')).toBeNull();
        expect((el.querySelector('[role="img"]') as HTMLElement).style.width).toBe('24px');
    });

    it.each([-1, 1001, 2.5, NaN, Infinity, '12'])('an invalid count (%s) is dropped, not rendered', (bad) => {
        const el = mount(h(ProfileBadgeRow, { badges: [{ ...egg(2, 7), count: bad as unknown as number }] }));
        expect(el.querySelector('[data-egg-count]')).toBeNull();
    });

    it('an admin badge never shows a count even if one is sent', () => {
        const admin: ProfileBadge = { badge_id: 'b1', icon: 'star', color: 'gold', label: 'Founder', sort_order: 0, count: 5 };
        const el = mount(h(ProfileBadgeRow, { badges: [admin] }));
        expect(el.querySelector('[data-egg-count]')).toBeNull();
    });
});
