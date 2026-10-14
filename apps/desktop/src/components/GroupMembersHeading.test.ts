// @vitest-environment jsdom
/**
 * The "+" at the right end of the group panel's Members heading: present when
 * the user may add people, absent otherwise, accessible, and it opens the
 * add flow when clicked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { GroupMembersHeading } from './GroupMembersHeading';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

const render = (props: Partial<React.ComponentProps<typeof GroupMembersHeading>>) =>
    act(() => root.render(React.createElement(GroupMembersHeading, { count: 3, canAdd: true, onAdd: () => {}, ...props })));
const plus = () => host.querySelector('button[aria-label="Add people"]') as HTMLButtonElement | null;

describe('GroupMembersHeading', () => {
    it('shows "Members (n)" and a + for a user who may add people', () => {
        render({ count: 3, canAdd: true });
        expect(host.textContent).toContain('Members (3)');
        expect(plus()).not.toBeNull();
        expect(plus()!.type).toBe('button');
    });

    it('NEGATIVE CONTROL: no + at all when the user may not add people (heading still renders)', () => {
        render({ count: 3, canAdd: false });
        expect(host.textContent).toContain('Members (3)');
        expect(plus()).toBeNull();
    });

    it('clicking the + calls onAdd', () => {
        const onAdd = vi.fn();
        render({ onAdd });
        act(() => { plus()!.click(); });
        expect(onAdd).toHaveBeenCalledTimes(1);
    });

    it('is a keyboard-reachable control with a focus-visible ring and a hover colour', () => {
        render({});
        const cls = plus()!.className;
        expect(cls).toMatch(/focus-visible:ring/);
        expect(cls).toMatch(/hover:text-cl-text/);
        expect(cls).toMatch(/text-cl-faint/);
        expect(plus()!.tabIndex).not.toBe(-1);
    });

    it('keeps the heading typography identical to the "Shared" heading and lays the row out with flex', () => {
        render({});
        const row = host.firstElementChild as HTMLElement;
        expect(row.style.fontSize).toBe('11px');
        expect(row.style.fontWeight).toBe('800');
        expect(row.style.letterSpacing).toBe('.08em');
        expect(row.style.textTransform).toBe('uppercase');
        expect(row.style.padding).toBe('2px 2px 8px');
        expect(row.className).toContain('flex');
        expect(row.className).toContain('items-center');
        expect(row.className).toContain('justify-between');
    });

    it('uses the exact style literal of the "Shared" heading in Dashboard (jsdom drops var() colours, so compare source)', () => {
        const dir = path.dirname(fileURLToPath(import.meta.url));
        const dash = readFileSync(path.join(dir, 'Dashboard.tsx'), 'utf8');
        const heading = readFileSync(path.join(dir, 'GroupMembersHeading.tsx'), 'utf8');
        const shared = dash.match(/<div style=\{\{ (fontSize: 11[^}]*)\}\}>Shared<\/div>/);
        expect(shared).not.toBeNull();
        expect(heading).toContain(shared![1].trim());
    });
});
