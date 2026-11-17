// @vitest-environment jsdom
/**
 * Owner, 2026-11-16: "when dragging a sub category outside of a category it
 * should show a red preview and if they drop it have a pop up saying
 * subcategories have to be under a category."
 *
 * The REAL ServerChannelList, with dnd-kit's DndContext wrapped so the test can
 * drive its onDragStart / onDragOver / onDragEnd directly (jsdom has no layout
 * for a pointer gesture; the gesture itself is shot in a real browser by
 * harness/subcat-drag-refuse-shots.mjs). Checks: over the top of the list the
 * drop zone / drop line is red and the not-allowed cursor class is on <html>;
 * releasing there opens a "Got it" dialog (no PATCH, nothing moves), which
 * closes on Escape and on "Got it". Controls: the same sub-category dropped
 * into another category, and a channel dropped at the top, are not refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChannelInfo, CategoryInfo, ServerInfo } from '../../hooks/useServers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

type DndProps = {
    onDragStart: (e: unknown) => void;
    onDragOver: (e: unknown) => void;
    onDragEnd: (e: unknown) => void;
};
const dnd = vi.hoisted(() => ({ props: null as DndProps | null }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@dnd-kit/core')>();
    const React = await import('react');
    return {
        ...actual,
        DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
            dnd.props = props as unknown as DndProps;
            return React.createElement(actual.DndContext, props);
        },
    };
});

const http = vi.hoisted(() => ({ calls: [] as Array<{ method: string; url: string }> }));
vi.mock('axios', async (importOriginal) => {
    const actual = await importOriginal<typeof import('axios')>();
    const rec = (method: string) => (url: string) => { http.calls.push({ method, url }); return Promise.resolve({ data: [] }); };
    const ax = { ...actual.default, get: rec('GET'), patch: rec('PATCH'), post: rec('POST'), put: rec('PUT'), delete: rec('DELETE') };
    return { ...actual, default: ax };
});

const { default: ServerChannelList } = await import('./ServerChannelList');
const { UNCATEGORIZED_END_ID } = await import('./channelDrop');
const { ALL_PERMISSIONS } = await import('@cipherline/shared');

const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '',
} as ServerInfo;
const cat = (id: string, position: number, parent: string | null = null): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name: id, position, kind: 'text', icon_name: null, parent_category_id: parent });
const ch = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind: 'text', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const CATS = [cat('craft', 1000), cat('wood', 2000, 'craft'), cat('events', 2000)];
const CHANNELS = [ch('welcome', null, 1000), ch('general', null, 2000), ch('joinery', 'wood', 1000), ch('build', 'events', 1000)];

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
    vi.useFakeTimers();
    http.calls.length = 0;
    dnd.props = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(ServerChannelList, {
            server: SERVER, channels: CHANNELS, categories: CATS, loading: false,
            activeChannelId: null, onSelectChannel: () => {}, token: 't', userId: 'owner', myPermissions: ALL_PERMISSIONS,
        }));
    });
    http.calls.length = 0; // mount-time reads (roles etc.) are not what is measured
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.documentElement.classList.remove('cl-drag-refused');
    vi.useRealTimers();
});

const rect = { top: 0, left: 0, width: 200, height: 24, bottom: 24, right: 200 };
const active = (id: string) => ({ id, rect: { current: { translated: { ...rect, top: 30, bottom: 54 }, initial: rect } }, data: { current: {} } });
const over = (id: string) => ({ id, rect, data: { current: {} }, disabled: false });
const drag = async (dragId: string, overId: string) => {
    await act(async () => { dnd.props!.onDragStart({ active: active(dragId) }); });
    await act(async () => { dnd.props!.onDragOver({ active: active(dragId), over: over(overId) }); });
};
const drop = async (dragId: string, overId: string) => {
    await act(async () => { dnd.props!.onDragEnd({ active: active(dragId), over: over(overId) }); });
};
const dialog = () => document.querySelector('[role="dialog"]');
const patches = () => http.calls.filter(c => c.method === 'PATCH');

describe('dragging a sub-category outside a category', () => {
    it('the end-of-list zone turns red and the cursor is not-allowed while over it', async () => {
        await drag('sub:wood', UNCATEGORIZED_END_ID);
        expect(document.querySelector('[data-drop-zone]')?.getAttribute('data-drop-zone')).toBe('refused');
        expect(document.querySelector('[data-drop-zone]')!.className).toContain('ring-cl-flash/40');
        expect(document.documentElement.classList.contains('cl-drag-refused')).toBe(true);
    });

    it('over an uncategorized channel the drop line is red', async () => {
        await drag('sub:wood', 'ch:general');
        const lines = [...document.querySelectorAll('[data-drop-indicator]')];
        expect(lines.map(l => l.getAttribute('data-drop-indicator'))).toEqual(['refused']);
        expect(lines[0].innerHTML).toContain('bg-cl-flash');
        expect(lines[0].innerHTML).not.toContain('bg-cl-lume');
    });

    it('dropping there moves nothing and opens a "Got it" dialog that closes on Escape', async () => {
        await drag('sub:wood', UNCATEGORIZED_END_ID);
        await drop('sub:wood', UNCATEGORIZED_END_ID);
        expect(document.documentElement.classList.contains('cl-drag-refused')).toBe(false);
        await act(async () => { vi.advanceTimersByTime(50); });
        const d = dialog()!;
        expect(d).not.toBeNull();
        expect(d.textContent).toContain('Sub-categories have to be under a category');
        const buttons = [...d.querySelectorAll('button')].map(b => b.textContent?.trim());
        expect(buttons).toEqual(['Got it']);
        expect(patches()).toEqual([]);
        // the sub-category is still drawn inside Crafting
        expect(host.querySelector('[data-subcategory-id="wood"]')).not.toBeNull();
        // Not a toast: it stays until answered.
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(dialog()).not.toBeNull();

        await act(async () => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(dialog()).toBeNull();
    });

    it('"Got it" closes it too', async () => {
        await drag('sub:wood', 'ch:welcome');
        await drop('sub:wood', 'ch:welcome');
        await act(async () => { vi.advanceTimersByTime(50); });
        const ok = [...dialog()!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Got it')!;
        await act(async () => { ok.click(); });
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(dialog()).toBeNull();
        expect(patches()).toEqual([]);
    });

    it('control: the same sub-category dropped into another category is a normal move (green, PATCH, no dialog)', async () => {
        await drag('sub:wood', 'ch:build');
        expect([...document.querySelectorAll('[data-drop-indicator]')].map(l => l.getAttribute('data-drop-indicator'))).toEqual(['ok']);
        expect(document.documentElement.classList.contains('cl-drag-refused')).toBe(false);
        await drop('sub:wood', 'ch:build');
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(dialog()).toBeNull();
        expect(patches().map(p => p.url)).toEqual(['/servers/s1/channel-layout'].map(u => expect.stringContaining(u)));
    });

    it('control: a channel dropped at the top of the list is not refused', async () => {
        await drag('ch:joinery', UNCATEGORIZED_END_ID);
        expect(document.querySelector('[data-drop-zone]')?.getAttribute('data-drop-zone')).toBe('ok');
        expect(document.documentElement.classList.contains('cl-drag-refused')).toBe(false);
        await drop('ch:joinery', UNCATEGORIZED_END_ID);
        await act(async () => { vi.advanceTimersByTime(600); });
        expect(dialog()).toBeNull();
        expect(patches()).toHaveLength(1);
    });
});
