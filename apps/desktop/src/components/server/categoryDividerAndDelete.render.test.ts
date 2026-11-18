// @vitest-environment jsdom
/**
 * 2026-11-17 channel-list round, against the REAL components:
 *
 *   - divider categories: a top-level category with `header_style` draws its
 *     heading as the labelled divider (with a chevron) and still collapses
 *     with the mouse AND the keyboard (Enter / Space, aria-expanded); an
 *     ordinary category keeps the bold top-level label and has no colour;
 *   - the two-choice delete: "category only" is the default and calls the
 *     plain DELETE; "everything" lists the counts, stays disabled until the
 *     second confirmation is ticked, and goes out as ONE request with the
 *     counts the user saw - never a channel-by-channel loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChannelInfo, CategoryInfo, DividerInfo, ServerInfo } from '../../hooks/useServers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
});

const http = vi.hoisted(() => ({ calls: [] as Array<{ method: string; url: string; body?: unknown }> }));
vi.mock('axios', async (importOriginal) => {
    const actual = await importOriginal<typeof import('axios')>();
    const rec = (method: string) => (url: string, body?: unknown) => { http.calls.push({ method, url, body }); return Promise.resolve({ data: [] }); };
    const ax = { ...actual.default, get: rec('GET'), patch: rec('PATCH'), post: rec('POST'), put: rec('PUT'), delete: rec('DELETE') };
    return { ...actual, default: ax };
});

const { default: ServerChannelList } = await import('./ServerChannelList');
const { CategoryDeleteDialog } = await import('./CategoryDeleteDialog');
const { ALL_PERMISSIONS } = await import('@cipherline/shared');

const SERVER = {
    server_id: 's1', name: 'Maker Collective', description: null, icon_attachment: null, icon_key_b64: null, icon_nonce_b64: null,
    banner_attachment: null, banner_key_b64: null, banner_nonce_b64: null, owner_user_id: 'owner', created_at: '',
} as ServerInfo;
const cat = (id: string, position: number, parent: string | null = null, extra: Partial<CategoryInfo> = {}): CategoryInfo =>
    ({ category_id: id, server_id: 's1', name: id.toUpperCase(), position, kind: 'text', icon_name: null, parent_category_id: parent, ...extra });
const ch = (id: string, parent: string | null, position: number): ChannelInfo => ({
    channel_id: id, server_id: 's1', kind: 'text', name: id, topic: null, icon_emoji: null, icon_name: null,
    position, parent_category_id: parent, active_call_session_id: null, member_limit: null, max_calls: null,
});
const div = (id: string, parent: string | null, position: number): DividerInfo =>
    ({ divider_id: id, server_id: 's1', parent_category_id: parent, position, style: 'line', label: null, emoji: null, color: null } as DividerInfo);

const CATS = [
    cat('games', 1000, null, { header_style: 'pill', header_color: '#25e0c8' }),
    cat('wood', 2000, 'games'),
    cat('craft', 2000),
];
const CHANNELS = [ch('lobby', 'games', 1000), ch('joinery', 'wood', 1000), ch('general', 'craft', 1000)];
const DIVIDERS = [div('d1', 'games', 1500), div('d2', 'wood', 1500)];

let host: HTMLDivElement;
let root: Root;
const onDeleteCategoryApi = vi.fn(async () => {});
const onDeleteCategoryWithContentsApi = vi.fn(async () => {});

beforeEach(async () => {
    vi.useFakeTimers();
    http.calls.length = 0;
    onDeleteCategoryApi.mockClear();
    onDeleteCategoryWithContentsApi.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
        root.render(React.createElement(ServerChannelList, {
            server: SERVER, channels: CHANNELS, categories: CATS, dividers: DIVIDERS, loading: false,
            activeChannelId: null, onSelectChannel: () => {}, token: 't', userId: 'owner', myPermissions: ALL_PERMISSIONS,
            onDeleteCategoryApi, onDeleteCategoryWithContentsApi,
        }));
    });
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const header = (name: string) =>
    [...host.querySelectorAll('[role="button"][aria-expanded]')].find(el => el.getAttribute('aria-label')?.startsWith(`${name},`)) as HTMLElement;
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;
const button = (root: ParentNode, text: string) =>
    [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined;

describe('divider categories in the channel list', () => {
    it('draws the divider (style + colour) as the heading, with a chevron; an ordinary category keeps the bold label', () => {
        const games = header('GAMES');
        expect(games.getAttribute('aria-label')).toBe('GAMES, divider category');
        expect(games.querySelector('[data-divider-category="pill"]')?.textContent).toBe('GAMES');
        expect(games.querySelector('[data-testid="divider-category-chevron"]')).not.toBeNull();
        expect(games.innerHTML).toContain('rgb(37, 224, 200)'); // #25e0c8
        const craft = header('CRAFT');
        expect(craft.getAttribute('aria-label')).toBe('CRAFT, category');
        expect(craft.querySelector('[data-divider-category]')).toBeNull();
        const label = [...craft.querySelectorAll('span')].find(s => s.textContent === 'CRAFT')!;
        expect(label.className).toContain('font-bold');
        expect(label.className).toContain('text-cl-muted');
        expect(label.getAttribute('style') ?? '').not.toContain('color');
    });

    it("a manager's hover \"+\" / \"...\" (category and sub-category) take no room until the row is hovered or focused (labels keep the row width)", () => {
        // Window-size check 2026-11-18: while merely faded (opacity 0) they kept ~54 px
        // and cut divider-category labels to a few letters in the 200 px list.
        for (const name of ['GAMES', 'CRAFT']) {
            const actions = header(name).querySelector('button[aria-label="Category options"]')!.parentElement!;
            const cls = actions.className.split(/\s+/);
            expect(cls).toContain('hidden');
            expect(cls).toContain('group-hover:flex');
            expect(cls).toContain('group-has-[:focus-visible]:flex');
            expect(cls).toContain('group-focus-visible:flex');
        }
        const sub = host.querySelector('[data-subcategory-id="wood"]')!;
        const subActions = sub.querySelector('button[aria-label="Sub-category options"]')!.parentElement!;
        expect(subActions.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'group-hover:flex', 'group-focus-visible:flex', 'group-has-[:focus-visible]:flex']));
    });

    it('a mouse click (collapse / expand) must not keep the "+" / "..." slot open: only KEYBOARD focus (:focus-visible) reveals it, in both states, and nothing animates layout', async () => {
        // Owner 2026-11-18: after clicking a divider category the header stays focused
        // (role=button, tabIndex 0); `group-focus-within` kept the ~83 px slot open
        // after the pointer left, so the divider's right rule stayed short.
        const assertSlot = (name: string) => {
            const row = header(name);
            const actions = row.querySelector('button[aria-label="Category options"]')!.parentElement!;
            const cls = actions.className.split(/\s+/);
            expect(cls).not.toContain('group-focus-within:flex');
            expect(cls).toContain('group-has-[:focus-visible]:flex');
            expect(cls).toContain('group-focus-visible:flex');
            // The slot is in or out of the layout, never animated.
            expect(actions.className.replace(/transition-opacity/, "")).not.toMatch(/transition|duration|\bw-|basis|max-w|min-w/); // the opacity fade is fine
            // Neither are the divider rules (flex-1 spans) or the row.
            for (const el of [row, ...row.querySelectorAll('[data-divider-category] *')]) {
                expect(el.className?.toString() ?? '').not.toMatch(/transition-(all|\[)|transition-(width|size|spacing)/);
            }
        };
        assertSlot('GAMES'); // expanded
        await act(async () => { header('GAMES').click(); });
        expect(header('GAMES').getAttribute('aria-expanded')).toBe('false');
        assertSlot('GAMES'); // collapsed
        await act(async () => { header('GAMES').click(); });
        assertSlot('GAMES');
        assertSlot('CRAFT');
    });

    it('holds its sub-category and channels, and collapses with click, Enter and Space (aria-expanded follows)', async () => {
        expect(host.querySelector('[data-subcategory-id="wood"]')).not.toBeNull();
        const games = header('GAMES');
        expect(games.getAttribute('aria-expanded')).toBe('true');
        await act(async () => { games.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(header('GAMES').getAttribute('aria-expanded')).toBe('false');
        expect(host.querySelector('[data-subcategory-id="wood"]')).toBeNull();
        await act(async () => { header('GAMES').dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
        expect(header('GAMES').getAttribute('aria-expanded')).toBe('true');
        await act(async () => { header('GAMES').click(); });
        expect(header('GAMES').getAttribute('aria-expanded')).toBe('false');
    });
});

describe('delete category: two choices', () => {
    const openDelete = async (name: string) => {
        const h = header(name);
        const more = h.querySelector('button[aria-label="Category options"]') as HTMLButtonElement;
        await act(async () => { more.click(); });
        const item = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('Delete Category')) as HTMLElement;
        await act(async () => { item.click(); });
        // The menu closes, then the roles / overrides read (private-parent check) resolves.
        for (let i = 0; i < 6; i++) await act(async () => { vi.advanceTimersByTime(200); });
    };

    it('lists what is inside (channels, sub-categories, dividers) and defaults to "category only"', async () => {
        await openDelete('GAMES');
        const d = dialog()!;
        expect(d.textContent).toContain('Contains 2 channels, 1 sub-category and 2 dividers.');
        expect(d.textContent).toContain('Delete category only');
        expect(d.textContent).toContain('Delete category and everything in it');
        expect(d.textContent).toContain('Permanently deletes 2 channels, 1 sub-category and 2 dividers.');
        expect(button(d, 'Delete category')).toBeDefined();
        await act(async () => { button(d, 'Delete category')!.click(); });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onDeleteCategoryApi).toHaveBeenCalledTimes(1);
        expect(onDeleteCategoryWithContentsApi).not.toHaveBeenCalled();
    });

    it('"everything": warns, needs the tick, then ONE request with the counts shown (no per-channel deletes)', async () => {
        await openDelete('GAMES');
        const d = dialog()!;
        const everything = d.querySelector('[data-choice="everything"] [role="radio"], [data-choice="everything"] button') as HTMLElement;
        await act(async () => { everything.click(); });
        expect(d.textContent).toContain("Deleted channels can't be recovered");
        const go = button(d, 'Delete 2 channels')!;
        expect(go.disabled).toBe(true);
        await act(async () => { go.click(); });
        expect(onDeleteCategoryWithContentsApi).not.toHaveBeenCalled();
        const tick = [...d.querySelectorAll('[role="checkbox"], button')].find(el => el.textContent?.includes('I understand 2 channels')) as HTMLElement;
        await act(async () => { tick.click(); });
        expect(button(d, 'Delete 2 channels')!.disabled).toBe(false);
        await act(async () => { button(d, 'Delete 2 channels')!.click(); });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onDeleteCategoryWithContentsApi).toHaveBeenCalledTimes(1);
        const [catArg, expected] = onDeleteCategoryWithContentsApi.mock.calls[0] as unknown as [CategoryInfo, unknown];
        expect(catArg.category_id).toBe('games');
        expect(expected).toEqual({ expected_channels: 2, expected_subcategories: 1, expected_dividers: 2 });
        expect(onDeleteCategoryApi).not.toHaveBeenCalled();
        expect(http.calls.filter(c => c.method === 'DELETE')).toEqual([]);
    });
});

describe('CategoryDeleteDialog on its own', () => {
    const render = async (props: Partial<React.ComponentProps<typeof CategoryDeleteDialog>> = {}) => {
        const onConfirm = vi.fn();
        await act(async () => {
            root.render(React.createElement(CategoryDeleteDialog, {
                name: 'Staff', isSub: false,
                only: { title: 'Delete "Staff"?', message: 'Channels inside will become uncategorized.' },
                contents: { channels: 1, subcategories: 0, dividers: 0 },
                onConfirm, onCancel: () => {},
                ...props,
            }));
        });
        await act(async () => { vi.advanceTimersByTime(50); });
        return onConfirm;
    };

    it('"category only" blocked (private parent): that choice is disabled with the reason; "everything" is preselected', async () => {
        await render({
            only: { title: "Can't delete", message: 'Move or delete the sub-categories first.', confirmDisabled: true },
            contents: { channels: 1, subcategories: 1, dividers: 0 },
        });
        const d = dialog()!;
        expect(d.textContent).toContain('Move or delete the sub-categories first.');
        expect(button(d, 'Delete 1 channel')).toBeDefined();
    });

    it('an empty category is a plain confirm with no choice', async () => {
        const onConfirm = await render({ contents: { channels: 0, subcategories: 0, dividers: 0 } });
        const d = dialog()!;
        expect(d.textContent).toContain('This category is empty.');
        expect(d.textContent).not.toContain('everything in it');
        await act(async () => { button(d, 'Delete')!.click(); });
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(onConfirm).toHaveBeenCalledWith('only');
    });

    it('Calls panel wording', async () => {
        await render({ panel: 'calls', initialChoice: 'everything', contents: { channels: 3, subcategories: 0, dividers: 1 } });
        const d = dialog()!;
        expect(d.textContent).toContain("Deleted Calls channels can't be recovered");
        expect(d.textContent).toContain('any call in them ends');
        expect(d.textContent).toContain('I understand 3 Calls channels will be deleted for good');
    });
});
