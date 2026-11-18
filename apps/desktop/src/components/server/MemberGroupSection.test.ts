// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemberGroupSection } from './MemberGroupSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
afterEach(() => { act(() => { root?.unmount(); }); root = null; host?.remove(); vi.useRealTimers(); });

const rows = (n: number) => Array.from({ length: n }, (_, i) => React.createElement('div', { key: i, 'data-row': i }, `member ${i}`));
const draw = (collapsed: boolean, onToggle = () => {}) => act(() => {
    if (!root) { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); }
    root.render(React.createElement(MemberGroupSection, { label: 'Moderators', count: 4, collapsed, onToggle, children: collapsed ? [] : rows(4) }));
});

describe('MemberGroupSection', () => {
    it('header is a real button with aria-expanded/aria-controls and the count', () => {
        draw(false);
        const btn = host.querySelector('button')!;
        expect(btn.getAttribute('type')).toBe('button');          // native: Enter and Space activate it
        expect(btn.getAttribute('aria-expanded')).toBe('true');
        const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
        expect(body).not.toBeNull();
        expect(btn.textContent).toMatch(/Moderators\s*—\s*4/);
        expect(host.querySelectorAll('[data-row]').length).toBe(4);
    });

    it('click calls onToggle', () => {
        const onToggle = vi.fn();
        draw(false, onToggle);
        act(() => { host.querySelector('button')!.click(); });
        expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('collapsed: count stays in the header, body is hidden + inert, rows leave after the fold', () => {
        vi.useFakeTimers();
        draw(false);
        draw(true);
        const btn = host.querySelector('button')!;
        expect(btn.getAttribute('aria-expanded')).toBe('false');
        expect(btn.textContent).toMatch(/Moderators\s*—\s*4/);
        const body = document.getElementById(btn.getAttribute('aria-controls')!)!;
        expect(body.getAttribute('data-open')).toBe('false');
        expect(body.getAttribute('aria-hidden')).toBe('true');
        expect(body.hasAttribute('inert')).toBe(true);
        // still folding: the last rows are kept so they can animate out
        expect(host.querySelectorAll('[data-row]').length).toBe(4);
        act(() => { vi.advanceTimersByTime(250); });
        expect(host.querySelectorAll('[data-row]').length).toBe(0);
    });

    it('mounting already collapsed renders no rows and starts in the resting state', () => {
        draw(true);
        expect(host.querySelectorAll('[data-row]').length).toBe(0);
        expect(host.querySelector('[data-moving]')).toBeNull();
    });

    it('css: reduced motion turns the transitions off; resting rules hold the final state', () => {
        const css = readFileSync(join(__dirname, '../../styles/member-groups.css'), 'utf8');
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\{\s*\.cl-mgroup-head,\.cl-mgroup-chev,\.cl-mgroup-body\{transition:none\}/);
        expect(css).toMatch(/\.cl-mgroup-body\[data-open="false"\]\{grid-template-rows:0fr;opacity:0\}/);
        expect(css).not.toMatch(/animation\s*:/);                   // transitions only: nothing plays on mount
    });

    it('css: the body column can shrink, so a long member name truncates inside a narrow panel', () => {
        // An implicit `auto` grid column grows to its widest min-content (a long
        // unbreakable username), pushing rows past the 280 px panel at the
        // 1000 px window minimum (window-size check, 2026-11-18).
        const css = readFileSync(join(__dirname, '../../styles/member-groups.css'), 'utf8');
        expect(css).toMatch(/\.cl-mgroup-body\{[^}]*grid-template-columns:minmax\(0,\s*1fr\)/);
    });
});
