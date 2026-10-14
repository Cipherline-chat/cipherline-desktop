// @vitest-environment jsdom
/**
 * The rail's Direct messages / Group chats right-click menu, mounted through
 * the real RailTile + useConversationRailMenu + ContextMenu. The harness wires
 * the menu's callbacks the same way Dashboard does (unreadConversationIds ->
 * markConversationsRead -> readEventFor -> sendReadReceipt), with the socket
 * sender and toast as spies, so "uses the same mark-read path" is observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { RailTile } from './RailTile';
import { useConversationRailMenu } from '../../hooks/useConversationRailMenu';
import { runMarkRead, unreadConversationIds, type ConversationScope } from '../../utils/markAllRead';
import type { CountMap } from '../../utils/unreadBadges';

const h = React.createElement;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const kinds: Record<string, 'dm' | 'group'> = { dm1: 'dm', dm2: 'dm', dm3: 'dm', grp1: 'group', grp2: 'group' };
const thread = (n: number) => [{ id: U(n), content: { type: 'text' } }, { id: U(n + 1), content: { type: 'text' } }];
const MESSAGES: Record<string, ReturnType<typeof thread>> = {
    dm1: thread(10), dm2: thread(20), dm3: thread(30), grp1: thread(40), grp2: thread(50),
};

interface Props {
    unread: CountMap;
    mentions?: CountMap;
    send: (id: string, msgId: string, opts?: { selfOnly?: boolean }) => boolean;
    toast: (m: { kind: string; message: string }) => void;
    onNewDM: () => void;
    onNewGroup: () => void;
    showReceipts?: boolean;
    /** Conversation the stand-in sidebar "Mark as Read" targets. */
    one?: string;
}

const Harness: React.FC<Props> = (p) => {
    const [unread, setUnread] = React.useState<CountMap>(p.unread);
    const [mentions, setMentions] = React.useState<CountMap>(p.mentions ?? {});
    const countsRef = React.useRef({ unread, mentions });
    // eslint-disable-next-line react-hooks/refs -- test harness mirrors Dashboard's render-time ref pattern
    countsRef.current = { unread, mentions };
    // The same glue Dashboard has: ONE function runs the mark-read for the rail
    // (all in scope) and for the sidebar's per-conversation "Mark as Read".
    const markNow = (ids: readonly string[]) => runMarkRead({
        ids,
        unread: countsRef.current.unread, mentions: countsRef.current.mentions,
        setUnread, setMentions,
        messagesOf: id => MESSAGES[id],
        isSelfChat: () => false,
        showReadReceipts: p.showReceipts ?? true,
        send: p.send,
        notifyFailure: message => p.toast({ kind: 'error', message }),
        sleep: () => Promise.resolve(),
    });
    const markAll = React.useRef<(s: ConversationScope) => void>(() => {});
    const rail = useConversationRailMenu({
        unreadCounts: unread, mentionCounts: mentions,
        classify: id => kinds[id],
        onMarkAllRead: s => markAll.current(s),
        onNewDM: p.onNewDM, onNewGroup: p.onNewGroup,
    });
    // eslint-disable-next-line react-hooks/refs -- same
    markAll.current = (scope) => {
        const { unread: u, mentions: m } = countsRef.current;
        const ids = unreadConversationIds(u, m, id => kinds[id], scope);
        if (ids.length) void markNow(ids);
    };
    return h('div', { 'data-counts': JSON.stringify({ unread, mentions }) },
        h(RailTile, { title: 'Direct messages', ...rail.tileProps('dm') }),
        h(RailTile, { title: 'Group chats', ...rail.tileProps('group') }),
        // stands in for the sidebar conversation menu's "Mark as Read" row
        // eslint-disable-next-line react-hooks/refs -- markNow reads the counts ref only when clicked
        h('button', { 'data-testid': 'mark-one', onClick: () => { void markNow([p.one ?? 'dm1']); } }, 'Mark as Read'),
        rail.menu,
    );
};

let root: Root | null = null;
let host: HTMLElement | null = null;
const send = vi.fn<Props['send']>();
const toast = vi.fn<Props['toast']>();
const onNewDM = vi.fn();
const onNewGroup = vi.fn();

function mount(over: Partial<Props> = {}) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(h(Harness, { unread: { dm1: 2, dm2: 0, dm3: 4, grp1: 3, grp2: 1 }, send, toast, onNewDM, onNewGroup, ...over }));
    });
}
const tile = (title: string) => document.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!;
const menuEl = () => document.querySelector<HTMLElement>('[role="menu"]');
const rows = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]'));
const row = (label: string) => rows().find(r => r.textContent?.includes(label))!;
const counts = () => JSON.parse(host!.querySelector('[data-counts]')!.getAttribute('data-counts')!) as { unread: CountMap; mentions: CountMap };

function rightClick(el: HTMLElement) {
    act(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 120 })); });
}
function key(el: Element, init: KeyboardEventInit) {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
}
/** Click a menu row and let the pick flash (170ms) + exit fade (120ms) run. */
function pick(label: string) {
    act(() => { row(label).click(); });
    act(() => { vi.advanceTimersByTime(400); });
}

beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset().mockReturnValue(true);
    toast.mockReset(); onNewDM.mockReset(); onNewGroup.mockReset();
    // jsdom has rAF only with pretendToBeVisual; the menu defers its first focus with it.
    if (!window.requestAnimationFrame) (window as unknown as { requestAnimationFrame: (cb: () => void) => number }).requestAnimationFrame = (cb) => setTimeout(cb, 0) as unknown as number;
});
afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null; host = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('rail DM / Group buttons — right-click menu', () => {
    it('opens on right-click for BOTH buttons, titled for the button it came from', () => {
        mount();
        expect(menuEl()).toBeNull();
        rightClick(tile('Direct messages'));
        expect(menuEl()).not.toBeNull();
        expect(menuEl()!.textContent).toContain('Direct messages');
        act(() => { key(document.body, { key: 'Escape' }); vi.advanceTimersByTime(400); });
        expect(menuEl()).toBeNull();

        rightClick(tile('Group chats'));
        expect(menuEl()).not.toBeNull();
        expect(menuEl()!.textContent).toContain('Group chats');
    });

    it('each button shows ONLY its own create item: DMs = New message, Groups = New group chat', () => {
        mount();
        const expected: Record<string, string[]> = {
            'Direct messages': ['Mark all as read', 'New message'],
            'Group chats': ['Mark all as read', 'New group chat'],
        };
        for (const t of ['Direct messages', 'Group chats']) {
            rightClick(tile(t));
            const labels = rows().map(r => r.querySelector('.clabel')!.textContent);
            expect(labels).toEqual(expected[t]);
            // negative control: the other button's create item is absent
            expect(labels).not.toContain(t === 'Direct messages' ? 'New group chat' : 'New message');
            expect(menuEl()!.querySelectorAll('[role="separator"]')).toHaveLength(1);
            // separator sits between Mark all as read and New message
            const kids = Array.from(menuEl()!.children).filter(c => c.getAttribute('role') !== null).map(c => c.getAttribute('role'));
            expect(kids.slice(0, 3)).toEqual(['menuitem', 'separator', 'menuitem']);
            act(() => { key(document.body, { key: 'Escape' }); vi.advanceTimersByTime(400); });
        }
    });

    it('scopes the count: DMs show the DM conversations with unread, groups the group ones', () => {
        mount();
        rightClick(tile('Direct messages'));
        expect(row('Mark all as read').textContent).toContain('2');   // dm1 + dm3 (dm2 is 0)
        act(() => { key(document.body, { key: 'Escape' }); vi.advanceTimersByTime(400); });
        rightClick(tile('Group chats'));
        expect(row('Mark all as read').textContent).toContain('2');   // grp1 + grp2
    });

    it('Mark all as read on DMs clears only DM unread, sends one read per DM through the same sender, leaves groups alone', () => {
        mount({ mentions: { dm3: 1, grp1: 2 } });
        rightClick(tile('Direct messages'));
        pick('Mark all as read');
        expect(counts().unread).toEqual({ dm2: 0, grp1: 3, grp2: 1 });
        expect(counts().mentions).toEqual({ grp1: 2 });
        // exactly the in-scope conversations, each naming its newest message, a visible receipt (receipts on)
        expect(send.mock.calls.map(c => [c[0], c[1], c[2]]).sort()).toEqual([
            ['dm1', U(11), undefined],
            ['dm3', U(31), undefined],
        ].sort());
        expect(toast).not.toHaveBeenCalled();
    });

    it('Mark all as read on Groups clears only groups', () => {
        mount();
        rightClick(tile('Group chats'));
        pick('Mark all as read');
        expect(counts().unread).toEqual({ dm1: 2, dm2: 0, dm3: 4 });
        expect(send.mock.calls.map(c => c[0]).sort()).toEqual(['grp1', 'grp2']);
    });

    it('with read receipts OFF the same path sends self-only reads (mirrors opening the chat)', () => {
        mount({ showReceipts: false });
        rightClick(tile('Group chats'));
        pick('Mark all as read');
        expect(send).toHaveBeenCalledTimes(2);
        for (const c of send.mock.calls) expect(c[2]).toEqual({ selfOnly: true });
    });

    it('is disabled with an explanation when nothing is unread, and picking it does nothing', () => {
        mount({ unread: { dm2: 0 } });
        rightClick(tile('Direct messages'));
        const r = row('Mark all as read');
        expect(r.getAttribute('aria-disabled')).toBe('true');
        expect((r as HTMLButtonElement).disabled).toBe(true);
        expect(r.textContent).toContain('All caught up');
        act(() => { r.click(); vi.advanceTimersByTime(400); });
        expect(send).not.toHaveBeenCalled();
        // focus lands on the first ENABLED row instead
        act(() => { vi.advanceTimersByTime(50); });
        expect(document.activeElement).toBe(row('New message'));
    });

    it('is disabled for groups when only DMs are unread (and vice-versa)', () => {
        mount({ unread: { dm1: 3 } });
        rightClick(tile('Group chats'));
        expect((row('Mark all as read') as HTMLButtonElement).disabled).toBe(true);
        act(() => { key(document.body, { key: 'Escape' }); vi.advanceTimersByTime(400); });
        rightClick(tile('Direct messages'));
        expect((row('Mark all as read') as HTMLButtonElement).disabled).toBe(false);
    });

    it('New message opens the existing new-DM flow; New group chat the existing group flow', () => {
        mount();
        rightClick(tile('Direct messages'));
        pick('New message');
        expect(onNewDM).toHaveBeenCalledTimes(1);
        expect(onNewGroup).not.toHaveBeenCalled();

        rightClick(tile('Group chats'));
        pick('New group chat');
        expect(onNewGroup).toHaveBeenCalledTimes(1);
        expect(onNewDM).toHaveBeenCalledTimes(1);
    });

    it('sidebar "Mark as Read" on ONE conversation clears its unread AND mentions and sends the same message:read', () => {
        mount({ mentions: { dm1: 1, dm3: 1 }, one: 'dm1' });
        act(() => { document.querySelector<HTMLButtonElement>('[data-testid="mark-one"]')!.click(); });
        expect(counts().unread).toEqual({ dm2: 0, dm3: 4, grp1: 3, grp2: 1 });
        expect(counts().mentions).toEqual({ dm3: 1 });
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith('dm1', U(11), undefined);
        expect(toast).not.toHaveBeenCalled();
    });

    it('single mark-read with receipts OFF is self-only', () => {
        mount({ showReceipts: false, one: 'grp1' });
        act(() => { document.querySelector<HTMLButtonElement>('[data-testid="mark-one"]')!.click(); });
        expect(send).toHaveBeenCalledWith('grp1', U(41), { selfOnly: true });
    });

    it('single mark-read rolls back and toasts when the send fails', () => {
        mount({ mentions: { dm1: 1 }, one: 'dm1' });
        send.mockReturnValue(false);
        act(() => { document.querySelector<HTMLButtonElement>('[data-testid="mark-one"]')!.click(); });
        expect(counts().unread.dm1).toBe(2);
        expect(counts().mentions.dm1).toBe(1);
        expect(toast).toHaveBeenCalledTimes(1);
    });

    it('rolls the badges back and toasts when the read cannot be sent', () => {
        mount({ mentions: { dm3: 1 } });
        send.mockReturnValue(false);                 // socket down
        rightClick(tile('Direct messages'));
        pick('Mark all as read');
        expect(counts().unread).toEqual({ dm1: 2, dm2: 0, dm3: 4, grp1: 3, grp2: 1 });
        expect(counts().mentions).toEqual({ dm3: 1 });
        expect(toast).toHaveBeenCalledTimes(1);
        expect(toast.mock.calls[0][0].kind).toBe('error');
    });

    it('rolls back only the conversation whose send failed', () => {
        mount();
        send.mockImplementation((id: string) => id !== 'dm3');
        rightClick(tile('Direct messages'));
        pick('Mark all as read');
        expect(counts().unread).toEqual({ dm2: 0, dm3: 4, grp1: 3, grp2: 1 });
        expect(toast).toHaveBeenCalledTimes(1);
    });
});

describe('rail DM / Group buttons — keyboard', () => {
    it('the ContextMenu key opens the menu on the focused button, anchored to the tile', () => {
        mount();
        const t = tile('Group chats');
        act(() => { t.focus(); });
        key(t, { key: 'ContextMenu' });
        expect(menuEl()).not.toBeNull();
        expect(menuEl()!.textContent).toContain('Group chats');
        expect(t.getAttribute('aria-haspopup')).toBe('menu');
    });

    it('Shift+F10 opens it; plain F10 does not', () => {
        mount();
        const t = tile('Direct messages');
        act(() => { t.focus(); });
        key(t, { key: 'F10' });
        expect(menuEl()).toBeNull();
        key(t, { key: 'F10', shiftKey: true });
        expect(menuEl()).not.toBeNull();
    });

    it('arrow keys move through the rows, Enter picks, Escape closes and returns focus to the button', () => {
        mount();
        const t = tile('Direct messages');
        act(() => { t.focus(); });
        key(t, { key: 'ContextMenu' });
        act(() => { vi.advanceTimersByTime(50); });
        expect(document.activeElement).toBe(row('Mark all as read'));
        key(document.activeElement!, { key: 'ArrowDown' });
        expect(document.activeElement).toBe(row('New message'));
        key(document.activeElement!, { key: 'Escape' });
        act(() => { vi.advanceTimersByTime(400); });
        expect(menuEl()).toBeNull();
        expect(document.activeElement).toBe(t);
    });

    it('a keyboard-synthesised contextmenu event (0,0) anchors to the tile, not the screen corner', () => {
        mount();
        const t = tile('Direct messages');
        t.getBoundingClientRect = () => ({ left: 14, right: 58, top: 80, bottom: 124, width: 44, height: 44, x: 14, y: 80, toJSON() {} }) as DOMRect;
        act(() => { t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 })); });
        const m = menuEl()!;
        expect(m.style.left).toBe('58px');
        expect(m.style.top).toBe('80px');
    });
});
