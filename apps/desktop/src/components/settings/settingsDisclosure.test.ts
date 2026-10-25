// @vitest-environment jsdom
/**
 * Settings disclosures ("Advanced audio", "Troubleshooting", …): the open
 * state is remembered per id, the folded body stays MOUNTED (so every setting
 * inside keeps its lifecycle and the search can still find it), and the
 * search reveal opens the right row.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const mem = new Map<string, string>();
vi.mock('../../utils/secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
    },
}));

import { SettingsDisclosure } from './SettingsDisclosure';
import { getDisclosureOpen, setDisclosureOpen, __resetDisclosureCache } from './settingsDisclosureStore';
import { findSettingTarget, revealSetting, REVEAL_EVENT } from './revealSetting';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    mem.clear();
    __resetDisclosureCache();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('settingsDisclosureStore', () => {
    it('falls back to the default until toggled, then remembers', () => {
        expect(getDisclosureOpen('voice.advanced-audio', false)).toBe(false);
        expect(getDisclosureOpen('voice.advanced-audio', true)).toBe(true);
        setDisclosureOpen('voice.advanced-audio', true);
        __resetDisclosureCache(); // force a re-read from the store
        expect(getDisclosureOpen('voice.advanced-audio', false)).toBe(true);
        expect(JSON.parse(mem.get('cipherline_settings_disclosures')!)).toEqual({ 'voice.advanced-audio': true });
    });

    it('a corrupt or wrong-shaped blob degrades to defaults instead of throwing', () => {
        mem.set('cipherline_settings_disclosures', '{not json');
        expect(getDisclosureOpen('a.b', false)).toBe(false);
        __resetDisclosureCache();
        mem.set('cipherline_settings_disclosures', JSON.stringify({ 'a.b': 'yes', 'c.d': true }));
        expect(getDisclosureOpen('a.b', false)).toBe(false);
        expect(getDisclosureOpen('c.d', false)).toBe(true);
    });
});

describe('<SettingsDisclosure>', () => {
    const render = () => act(() => root.render(
        React.createElement(SettingsDisclosure, {
            id: 'test.more', title: 'More options', summary: 'Things you rarely change.',
            children: React.createElement('div', { className: 'sd-row' }, React.createElement('b', null, 'Deep toggle')),
        }),
    ));

    it('starts closed with the body mounted but hidden, and aria wired', () => {
        render();
        const btn = host.querySelector('button.sx-disc-head')!;
        const body = host.querySelector('.sx-disc-body') as HTMLElement;
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        expect(btn.getAttribute('aria-controls')).toBe(body.id);
        expect(body.hidden).toBe(true);
        expect(body.textContent).toContain('Deep toggle'); // mounted while folded
    });

    it('toggles on click and remembers it across a remount', () => {
        render();
        const btn = host.querySelector('button.sx-disc-head') as HTMLButtonElement;
        act(() => btn.click());
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        expect((host.querySelector('.sx-disc-body') as HTMLElement).hidden).toBe(false);
        act(() => root.unmount());
        root = createRoot(host);
        render();
        expect(host.querySelector('button.sx-disc-head')!.getAttribute('aria-expanded')).toBe('true');
    });

    it('opens when the search reveal event reaches it', () => {
        render();
        const disc = host.querySelector('.sx-disc') as HTMLElement;
        act(() => { disc.dispatchEvent(new CustomEvent(REVEAL_EVENT)); });
        expect(disc.getAttribute('data-open')).toBe('true');
    });
});

describe('<SettingsDisclosure> rows are independent (no accordion)', () => {
    const three = () => act(() => root.render(
        React.createElement(React.Fragment, null,
            ...['a', 'b', 'c'].map((n) => React.createElement(SettingsDisclosure, {
                key: n, id: `ind.${n}`, title: `Section ${n}`, defaultOpen: n === 'a', children: React.createElement('p', null, n),
            }))),
    ));
    const heads = () => [...host.querySelectorAll<HTMLButtonElement>('button.sx-disc-head')];
    const open = () => heads().map((h) => h.getAttribute('aria-expanded') === 'true');

    it('opening one section leaves the others as they were; each closes only itself', () => {
        three();
        expect(open()).toEqual([true, false, false]);
        act(() => heads()[2].click());
        expect(open()).toEqual([true, false, true]);
        act(() => heads()[1].click());
        expect(open()).toEqual([true, true, true]);
        act(() => heads()[2].click());
        expect(open()).toEqual([true, true, false]);
    });
    it('the search reveal opens its section without folding the rest', () => {
        three();
        const discs = [...host.querySelectorAll<HTMLElement>('.sx-disc')];
        act(() => { discs[1].dispatchEvent(new CustomEvent(REVEAL_EVENT)); });
        expect(open()).toEqual([true, true, false]);
    });
    it('a header action sits beside the toggle, not inside it', () => {
        act(() => root.render(React.createElement(SettingsDisclosure, {
            id: 'acc.x', title: 'With action', action: React.createElement('button', { id: 'act' }, 'Add'), children: 'x',
        })));
        const act1 = host.querySelector('#act')!;
        expect(act1.closest('button.sx-disc-head')).toBeNull();
        expect(host.querySelector('.sx-disc-top')).not.toBeNull();
    });
});

describe('findSettingTarget / revealSetting', () => {
    const fixture = () => {
        const el = document.createElement('div');
        el.innerHTML = `
            <div class="sd-card"><h3>Camera</h3>
              <div class="sd-row"><div class="sd-rl"><b>Noise suppression</b><span>Fans, gone.</span></div></div>
              <div class="sx-disc" data-open="false" data-labels="Camera adjustments">
                <button class="sx-disc-head">Quality</button>
                <div class="sx-disc-body" hidden>
                  <div class="sx-disc" data-open="false">
                    <button class="sx-disc-head">Inner</button>
                    <div class="sx-disc-body" hidden>
                      <div class="sd-row"><div class="sd-rl"><b>Echo cancellation</b></div></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>`;
        document.body.appendChild(el);
        return el;
    };

    it('finds the deepest element whose text is the label, case-insensitively', () => {
        const el = fixture();
        const hit = findSettingTarget(el, 'noise SUPPRESSION')!;
        expect(hit.target.tagName).toBe('B');
        expect(hit.closed).toHaveLength(0);
        el.remove();
    });

    it('lists every closed disclosure around a folded setting, outermost first', () => {
        const el = fixture();
        const hit = findSettingTarget(el, 'Echo cancellation')!;
        expect(hit.closed.map(d => d.querySelector('button')!.textContent)).toEqual(['Quality', 'Inner']);
        el.remove();
    });

    it('falls back to declared data-labels for index labels that are not on screen', () => {
        const el = fixture();
        const hit = findSettingTarget(el, 'Camera adjustments')!;
        expect(hit.target.classList.contains('sx-disc')).toBe(true);
        expect(findSettingTarget(el, 'Nothing like this')).toBeNull();
        el.remove();
    });

    it('revealSetting opens the folds and flashes the row', () => {
        const el = fixture();
        const opened: string[] = [];
        el.querySelectorAll('.sx-disc').forEach(d => d.addEventListener(REVEAL_EVENT, () => opened.push(d.querySelector('button')!.textContent!)));
        const ok = revealSetting(el, 'Echo cancellation', fn => fn());
        expect(ok).toBe(true);
        expect(opened).toEqual(['Quality', 'Inner']);
        expect(el.querySelector('.sx-flash')!.classList.contains('sd-row')).toBe(true);
        el.remove();
    });
});

describe('disclosure motion', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/settings-descent.css'), 'utf8');
    const rule = (sel: string) => {
        const i = css.indexOf(`\n${sel}{`);
        expect(i).toBeGreaterThan(-1);
        return css.slice(i, css.indexOf('}', i));
    };
    it('the opening body never retains a forwards fill (it would flatten toggle slides inside it)', () => {
        const body = rule('.sx-disc-body');
        expect(body).toMatch(/animation:sx-discin/);
        expect(body).not.toMatch(/\b(both|forwards)\b/);
    });
    it('reduced motion strips the disclosure motion', () => {
        const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion:reduce){'));
        expect(reduced).toMatch(/\.sx-disc-body\{animation:none\}/);
    });
});

describe('disclosure ids', () => {
    it('are unique and namespaced by pane across the source tree', () => {
        const src = resolve(__dirname, '../..');
        const files: string[] = [];
        const walk = (d: string) => {
            for (const n of readdirSync(d)) {
                const p = join(d, n);
                if (statSync(p).isDirectory()) walk(p);
                else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) files.push(p);
            }
        };
        walk(src);
        const ids: string[] = [];
        for (const f of files) {
            const text = readFileSync(f, 'utf8');
            for (const m of text.matchAll(/<SettingsDisclosure\b[^>]*?\bid="([^"]+)"/gs)) ids.push(m[1]);
        }
        expect(ids.length).toBeGreaterThanOrEqual(8);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z]+\.[a-z0-9-]+$/);
    });
});
