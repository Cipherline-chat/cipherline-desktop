// @vitest-environment jsdom
/**
 * The Create / Edit Category dialog shares the channel editor; this pins its
 * own wire traffic: POST /categories then the preset's overrides against the
 * CATEGORY override route, and an edit that only touches permissions sends
 * no category PATCH at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_EVERYONE_PERMISSIONS, Permissions as P } from '@cipherline/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const s = (b: bigint) => b.toString(10);
const EV = '00000000-0000-4000-8000-000000000000';
const MOD = '00000000-0000-4000-8000-000000000002';
const CAT = '10000000-0000-4000-8000-000000000009';
let calls: [string, string, unknown?][] = [];
let catOverrides: unknown[] = [];

vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url: string) => {
            const p = url.replace(/^.*\/v1/, '');
            calls.push(['GET', p]);
            if (/\/roles$/.test(p)) {
                return { data: [
                    { role_id: EV, name: '@everyone', color: -1, position: 0, permissions: s(DEFAULT_EVERYONE_PERMISSIONS), is_everyone: true },
                    { role_id: MOD, name: 'Moderator', color: -1, position: 5, permissions: s(P.KICK_MEMBERS), is_everyone: false },
                ] };
            }
            if (/\/members$/.test(p)) return { data: [] };
            if (/\/me\/permissions$/.test(p)) return { data: { permissions: s((1n << 30n) - 1n) } };
            if (/\/categories\/[^/]+\/overrides$/.test(p)) return { data: catOverrides };
            throw new Error('unmocked GET ' + p);
        }),
        post: vi.fn(async (url: string, body: Record<string, unknown>) => {
            calls.push(['POST', url.replace(/^.*\/v1/, ''), body]);
            return { data: { category_id: 'new-cat', server_id: 's1', position: 1000, icon_name: null, ...body } };
        }),
        patch: vi.fn(async (url: string, body: unknown) => { calls.push(['PATCH', url.replace(/^.*\/v1/, ''), body]); return { data: { ok: true } }; }),
        delete: vi.fn(async (url: string) => { calls.push(['DELETE', url.replace(/^.*\/v1/, '')]); return { data: { ok: true } }; }),
    },
}));

const { CategoryFormDialog } = await import('./CategoryFormDialog');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    calls = [];
    catOverrides = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ''; });

const flush = async (ms = 0) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
async function mount(props: Record<string, unknown>) {
    const h = { onClose: vi.fn(), onSaved: vi.fn() };
    await act(async () => {
        root.render(React.createElement(CategoryFormDialog, {
            serverId: 's1', token: 't', kind: 'text', ownerUserId: 'o', currentUserId: 'o', ...h, ...props,
        } as never));
    });
    await flush(10);
    return h;
}
async function click(el: Element | undefined | null) {
    expect(el).toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await flush(5);
}
const radio = (t: string) => [...document.querySelectorAll('[role="radio"]')].find(b => b.textContent?.trim() === t);

describe('CategoryFormDialog', () => {
    it('create + Staff only → POST category, then the @everyone deny on the CATEGORY route', async () => {
        const h = await mount({});
        const input = document.querySelector('input[aria-label="Category name"]') as HTMLInputElement;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Staff');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(radio('Staff only'));
        await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        await flush(30);
        expect(calls.filter(c => c[0] === 'POST')).toEqual([['POST', '/servers/s1/categories', { name: 'Staff', kind: 'text', icon_name: null }]]);
        const patches = calls.filter(c => c[0] === 'PATCH');
        expect(patches[0]).toEqual(['PATCH', '/servers/s1/categories/new-cat/overrides',
            { target_kind: 'role', target_id: EV, allow_bits: '0', deny_bits: s(P.VIEW_CHANNEL) }]);
        expect(patches[1]).toEqual(['PATCH', '/servers/s1/categories/new-cat/overrides',
            { target_kind: 'role', target_id: MOD, allow_bits: s(P.VIEW_CHANNEL), deny_bits: '0' }]);
        expect(h.onSaved).toHaveBeenCalledTimes(1);
    });

    it('edit: clearing a role sends a DELETE for it and no category PATCH', async () => {
        catOverrides = [{ target_kind: 'role', target_id: MOD, allow_bits: s(P.VIEW_CHANNEL), deny_bits: '0' }];
        const h = await mount({ category: { category_id: CAT, server_id: 's1', name: 'Staff', position: 1, kind: 'text', icon_name: null } });
        await click([...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.includes('Permissions')));
        await click([...document.querySelectorAll('[data-target]')].find(b => b.textContent?.includes('Moderator')));
        await click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Clear'));
        calls = [];
        await click([...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Save'));
        await flush(30);
        expect(calls.filter(c => c[0] !== 'GET')).toEqual([['DELETE', `/servers/s1/categories/${CAT}/overrides/role/${MOD}`]]);
        expect(h.onSaved).toHaveBeenCalledTimes(1);
    });
});
