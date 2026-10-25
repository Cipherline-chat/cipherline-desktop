// @vitest-environment jsdom
/**
 * ClBanner, the shared notice-strip primitive.
 *
 * Rendered for real (jsdom + react-dom). Covered: every tone, the aria role per
 * tone (assertive only for danger), actions + dismiss, the stack's priority
 * ordering / top-two cap / "+N more", and the stylesheet's contract (narrow
 * container query, reduced motion, tokens only). Negative controls sit next to
 * the positives: no live region when `live="off"`, no dismiss without a handler,
 * no stacking for an inline banner, no "+N more" at two banners or fewer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// clPhysics (pulled in by ClButton) calls matchMedia at module load.
vi.hoisted(() => {
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

import { ClBanner, ClBannerStack, ClBannerOverlay } from './ClBanner';
import type { ClBannerTone } from './bannerStack';

const h = React.createElement;
let host: HTMLDivElement;
let root: Root;
const render = (el: React.ReactElement) => act(() => { root.render(el); });
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
const qa = (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[];
const bannerIds = () => qa('.cl-banner').map(b => b.querySelector('.cl-banner__title')?.textContent);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('ClBanner: tones and roles', () => {
    const tones: ClBannerTone[] = ['info', 'warning', 'danger', 'success', 'neutral'];

    it.each(tones)('%s renders the title, the description and a glyph', tone => {
        render(h(ClBanner, { tone, title: 'Heads up', description: 'More detail' }));
        const b = q('.cl-banner')!;
        expect(b.getAttribute('data-banner-tone')).toBe(tone);
        expect(q('.cl-banner__title')?.textContent).toBe('Heads up');
        expect(q('.cl-banner__desc')?.textContent).toBe('More detail');
        expect(q('.cl-banner__icon svg')).not.toBeNull();
    });

    it('danger is role=alert + aria-live=assertive; every other tone is role=status + polite', () => {
        for (const tone of tones) {
            render(h(ClBanner, { tone, title: tone }));
            const b = q('.cl-banner')!;
            if (tone === 'danger') {
                expect(b.getAttribute('role')).toBe('alert');
                expect(b.getAttribute('aria-live')).toBe('assertive');
            } else {
                expect(b.getAttribute('role'), tone).toBe('status');
                expect(b.getAttribute('aria-live'), tone).toBe('polite');
            }
        }
    });

    it('NEGATIVE: live="off" renders no live region at all (the container already announces it)', () => {
        render(h(ClBanner, { tone: 'danger', title: 'x', live: 'off' }));
        const b = q('.cl-banner')!;
        expect(b.getAttribute('role')).toBeNull();
        expect(b.getAttribute('aria-live')).toBeNull();
    });

    it('a description-only banner shows it as plain body text, with no empty title element', () => {
        render(h(ClBanner, { tone: 'info', description: 'Just a message' }));
        expect(q('.cl-banner__title')).toBeNull();
        expect(q('.cl-banner__desc--solo')?.textContent).toBe('Just a message');
    });

    it('icon={false} drops the glyph circle', () => {
        render(h(ClBanner, { tone: 'info', title: 'x', icon: false }));
        expect(q('.cl-banner__icon')).toBeNull();
    });

    it('passes data-* attributes and a test id to the root', () => {
        render(h(ClBanner, { tone: 'info', title: 'x', testId: 'tid', data: { foo: 'bar' } }));
        expect(q('[data-testid="tid"]')?.getAttribute('data-foo')).toBe('bar');
    });
});

describe('ClBanner: actions and dismiss', () => {
    it('renders one button per action, in order, and calls the right handler', () => {
        const a = vi.fn();
        const b = vi.fn();
        render(h(ClBanner, {
            tone: 'info', title: 't',
            actions: [
                { key: 'first', label: 'Upgrade', onClick: a },
                { key: 'second', label: '+3 days', variant: 'ghost', onClick: b },
            ],
        }));
        expect(qa('[data-action]').map(e => e.getAttribute('data-action'))).toEqual(['first', 'second']);
        act(() => { q<HTMLButtonElement>('[data-action="second"] button')!.click(); });
        expect(b).toHaveBeenCalledTimes(1);
        expect(a).not.toHaveBeenCalled();
        act(() => { q<HTMLButtonElement>('[data-action="first"] button')!.click(); });
        expect(a).toHaveBeenCalledTimes(1);
    });

    it('a disabled action does not fire', () => {
        const a = vi.fn();
        render(h(ClBanner, { tone: 'info', title: 't', actions: [{ key: 'x', label: 'Go', disabled: true, onClick: a }] }));
        act(() => { q<HTMLButtonElement>('[data-action="x"] button')!.click(); });
        expect(a).not.toHaveBeenCalled();
    });

    it('a custom node takes the slot of its action (a muted note instead of a button)', () => {
        render(h(ClBanner, { tone: 'info', title: 't', actions: [{ key: 'note', node: h('span', { id: 'n' }, 'No members have Pro yet') }] }));
        expect(q('[data-action="note"] #n')?.textContent).toContain('No members');
        expect(q('[data-action="note"] button')).toBeNull();
    });

    it('dismiss is a labelled native button that calls onDismiss', () => {
        const d = vi.fn();
        render(h(ClBanner, { tone: 'info', title: 't', onDismiss: d, dismissLabel: 'Dismiss until tomorrow' }));
        const x = q<HTMLButtonElement>('.cl-banner__x')!;
        expect(x.tagName).toBe('BUTTON');
        expect(x.getAttribute('aria-label')).toBe('Dismiss until tomorrow');
        act(() => { x.click(); });
        expect(d).toHaveBeenCalledTimes(1);
    });

    it('NEGATIVE: no dismiss control without a handler; dismissDisabled blocks the click', () => {
        render(h(ClBanner, { tone: 'info', title: 't' }));
        expect(q('.cl-banner__x')).toBeNull();
        expect(q('[data-action="dismiss"]')).toBeNull();
        const d = vi.fn();
        render(h(ClBanner, { tone: 'info', title: 't', onDismiss: d, dismissDisabled: true }));
        act(() => { q<HTMLButtonElement>('.cl-banner__x')!.click(); });
        expect(d).not.toHaveBeenCalled();
    });

    it('extra rows render in their own region under the head row', () => {
        render(h(ClBanner, { tone: 'danger', title: 't' }, h('div', { id: 'row' }, 'device row')));
        expect(q('.cl-banner__extra #row')).not.toBeNull();
    });
});

describe('ClBannerStack: priority ordering and the top-two cap', () => {
    const stack = (...items: Array<{ id: string; tone?: ClBannerTone; priority?: number }>) =>
        h(ClBannerStack, null, ...items.map(i => h(ClBanner, { key: i.id, id: i.id, tone: i.tone ?? 'info', priority: i.priority, title: i.id })));

    it('orders banners by priority (via CSS order), not by mount order', () => {
        render(stack({ id: 'low', priority: 10 }, { id: 'high', priority: 90 }));
        const byTitle = Object.fromEntries(qa('.cl-banner').map(b => [b.querySelector('.cl-banner__title')!.textContent, b.style.order]));
        expect(byTitle.high).toBe('0');
        expect(byTitle.low).toBe('1');
    });

    it('with no explicit priority the tone decides: danger above warning above info', () => {
        render(stack({ id: 'i', tone: 'info' }, { id: 'w', tone: 'warning' }, { id: 'd', tone: 'danger' }));
        // Only the top two are shown: danger and warning. Info is folded.
        expect(bannerIds().sort()).toEqual(['d', 'w']);
        expect(q('.cl-banner-more')?.textContent).toContain('+1 more');
    });

    it('shows at most two; the rest fold behind "+N more", highest priority kept', () => {
        render(stack({ id: 'a', priority: 1 }, { id: 'b', priority: 4 }, { id: 'c', priority: 3 }, { id: 'd', priority: 2 }));
        expect(bannerIds().sort()).toEqual(['b', 'c']);
        expect(q('.cl-banner-more')?.textContent).toContain('+2 more');
        expect(q('.cl-banner-more')?.getAttribute('aria-expanded')).toBe('false');
    });

    it('"+N more" expands all of them in priority order, and "Show less" folds them again', () => {
        render(stack({ id: 'a', priority: 1 }, { id: 'b', priority: 4 }, { id: 'c', priority: 3 }));
        act(() => { q<HTMLButtonElement>('.cl-banner-more')!.click(); });
        expect(bannerIds()).toHaveLength(3);
        const orderOf = (t: string) => Number(qa('.cl-banner').find(b => b.textContent?.includes(t))!.style.order);
        expect(orderOf('b')).toBeLessThan(orderOf('c'));
        expect(orderOf('c')).toBeLessThan(orderOf('a'));
        expect(q('.cl-banner-more')?.textContent).toContain('Show less');
        act(() => { q<HTMLButtonElement>('.cl-banner-more')!.click(); });
        expect(bannerIds()).toHaveLength(2);
    });

    it('NEGATIVE: two banners or fewer never show a "+N more" toggle', () => {
        render(stack({ id: 'a' }, { id: 'b' }));
        expect(q('.cl-banner-more')).toBeNull();
        render(stack({ id: 'a' }));
        expect(q('.cl-banner-more')).toBeNull();
    });

    it('a banner that goes away promotes the next one up (and drops the toggle at two)', () => {
        render(stack({ id: 'a', priority: 3 }, { id: 'b', priority: 2 }, { id: 'c', priority: 1 }));
        expect(bannerIds().sort()).toEqual(['a', 'b']);
        render(stack({ id: 'b', priority: 2 }, { id: 'c', priority: 1 }));
        expect(bannerIds().sort()).toEqual(['b', 'c']);
        expect(q('.cl-banner-more')).toBeNull();
    });

    it('NEGATIVE: an inline banner never joins the stack, so it neither counts nor gets folded', () => {
        render(h(ClBannerStack, null,
            h(ClBanner, { id: 'a', tone: 'info', priority: 3, title: 'a' }),
            h(ClBanner, { id: 'b', tone: 'info', priority: 2, title: 'b' }),
            h(ClBanner, { inline: true, tone: 'info', title: 'inline' }),
        ));
        expect(bannerIds().sort()).toEqual(['a', 'b', 'inline']);
        expect(q('.cl-banner-more')).toBeNull();
    });

    it('an empty stack renders an empty container (the stylesheet then removes it from layout)', () => {
        render(h(ClBannerStack, null, null));
        const s = q('[data-banner-stack]')!;
        expect(s.childElementCount).toBe(0);
    });

    it('outside any stack a banner just renders', () => {
        render(h(ClBanner, { tone: 'info', title: 'alone' }));
        expect(bannerIds()).toEqual(['alone']);
    });
});

describe('ClBannerOverlay', () => {
    it('carries the live region itself so its banners can opt out of their own', () => {
        render(h(ClBannerOverlay, { testId: 'ov', live: 'assertive', children: h(ClBanner, { inline: true, live: 'off', tone: 'danger', title: 'x' }) }));
        const ov = q('[data-testid="ov"]')!;
        expect(ov.getAttribute('role')).toBe('alert');
        expect(ov.getAttribute('aria-live')).toBe('assertive');
        expect(ov.querySelector('.cl-banner')?.getAttribute('role')).toBeNull();
    });
});

describe('cl-banner.css contract', () => {
    const css = readFileSync(resolve(__dirname, '../styles/cl-banner.css'), 'utf8');

    it('wraps gracefully when narrow: a container query moves the actions under the text', () => {
        expect(css).toMatch(/@container\s*\(max-width:\s*\d+px\)/);
        const narrow = css.slice(css.indexOf('@container'));
        expect(narrow).toMatch(/grid-template-areas:[^;]*\.\s+actions\s+actions/);
        // The dismiss stays in the top row, so a long message never pushes it away.
        expect(narrow).toMatch(/'icon text dismiss'/);
        // …and the card is a container to query.
        expect(css).toMatch(/\.cl-banner\s*\{[^}]*container-type:\s*inline-size/);
    });

    it('text flows and wraps (no clipping ellipsis on the message)', () => {
        const text = css.match(/\.cl-banner__text\s*\{([^}]*)\}/)![1];
        expect(text).toMatch(/overflow-wrap:\s*anywhere/);
        expect(text).not.toMatch(/text-overflow/);
        expect(text).not.toMatch(/white-space:\s*nowrap/);
    });

    it('respects prefers-reduced-motion: the entrance animation is switched off', () => {
        expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.cl-banner\s*\{\s*animation:\s*none/);
    });

    it('uses design tokens only: no hex colours, and every tone accent is a --cl-* variable', () => {
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        for (const tone of ['info', 'warning', 'danger', 'success', 'neutral']) {
            expect(css).toMatch(new RegExp(`data-banner-tone='${tone}'\\]\\s*\\{\\s*--b:\\s*var\\(--cl-[a-z]+\\)`));
        }
        // Warning is never a filled khaki slab: its accent is the amber token only.
        expect(css).toMatch(/data-banner-tone='warning'\]\s*\{\s*--b:\s*var\(--cl-glow\)/);
    });

    it('an empty stack takes no space', () => {
        expect(css).toMatch(/\.cl-banner-stack:empty\s*\{\s*display:\s*none/);
    });
});
