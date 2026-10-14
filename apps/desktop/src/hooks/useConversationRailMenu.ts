/**
 * useConversationRailMenu — the right-click menu on the rail's "Direct
 * messages" and "Group chats" buttons.
 *
 *   Mark all as read          (scoped to the button's own kind; disabled with
 *                              an "All caught up" note when nothing is unread)
 *   ───────────
 *   New message               (DMs button ONLY — the existing StartDMModal flow)
 *   New group chat            (Group chats button ONLY — the existing CreateGroupModal flow)
 *
 * It rides the canonical `useContextMenu` / `ContextMenu` primitive, so the
 * look, Escape-to-close, arrow-key navigation and outside-click dismissal are
 * exactly the server rail's. Keyboard: the ContextMenu key and Shift+F10 open
 * it on the focused tile (anchored to the tile, not the pointer), and closing
 * it hands focus back to the tile.
 *
 * Presentational: it decides what the menu SAYS from the counts it is given.
 * Doing the mark-read, and opening the modals, is the caller's (Dashboard).
 */
import React from 'react';
import { CheckCheck, MessageSquarePlus, Users } from 'lucide-react';
import { useContextMenu } from './useContextMenu';
import type { ContextMenuItem } from '../components/primitives/ContextMenu';
import { unreadConversationIds, type ConversationScope } from '../utils/markAllRead';
import type { CountMap } from '../utils/unreadBadges';

export interface ConversationRailMenuArgs {
    unreadCounts: CountMap;
    mentionCounts: CountMap;
    /** conversation id -> kind; an unknown id is treated as a DM (see unreadConversationIds). */
    classify: (conversationId: string) => 'dm' | 'group' | undefined;
    /** Run the bulk mark-read for this button's scope. Resolves the ids itself, at click time. */
    onMarkAllRead: (scope: ConversationScope) => void;
    onNewDM: () => void;
    onNewGroup: () => void;
}

export interface RailTileMenuProps {
    onContextMenu: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
    'aria-haspopup': 'menu';
}

const MENU_TITLE: Record<ConversationScope, string> = {
    dm: 'Direct messages',
    group: 'Group chats',
};

/** Pure: the menu rows for one button. Exported for tests. */
export function buildConversationRailMenuItems(p: {
    scope: ConversationScope;
    unreadCount: number;
    onMarkAllRead: () => void;
    onNewDM: () => void;
    onNewGroup: () => void;
}): ContextMenuItem[] {
    const has = p.unreadCount > 0;
    return [
        {
            icon: React.createElement(CheckCheck),
            label: 'Mark all as read',
            // Same wording style as the server rail's disabled "Mark as Read",
            // plus a visible reason so a greyed row never reads as broken.
            accessory: has ? String(p.unreadCount) : 'All caught up',
            disabled: !has,
            onSelect: p.onMarkAllRead,
        },
        { divider: true },
        // Each button offers only its OWN kind of create.
        p.scope === 'dm'
            ? { icon: React.createElement(MessageSquarePlus), label: 'New message', onSelect: p.onNewDM }
            : { icon: React.createElement(Users), label: 'New group chat', onSelect: p.onNewGroup },
    ];
}

export function useConversationRailMenu(args: ConversationRailMenuArgs) {
    const ctx = useContextMenu();
    // The tile that opened the menu, so closing it (Escape, a pick) lands focus
    // back there instead of on <body> — the keyboard user keeps their place.
    const triggerRef = React.useRef<HTMLElement | null>(null);

    const openFor = (
        scope: ConversationScope,
        at: { clientX: number; clientY: number },
        trigger: HTMLElement,
        e?: React.SyntheticEvent,
    ) => {
        e?.preventDefault();
        e?.stopPropagation();
        triggerRef.current = trigger;
        const ids = unreadConversationIds(args.unreadCounts, args.mentionCounts, args.classify, scope);
        ctx.open(
            at,
            buildConversationRailMenuItems({
                scope,
                unreadCount: ids.length,
                onMarkAllRead: () => args.onMarkAllRead(scope),
                onNewDM: args.onNewDM,
                onNewGroup: args.onNewGroup,
            }),
            MENU_TITLE[scope],
        );
    };

    const wasOpen = React.useRef(false);
    React.useEffect(() => {
        if (wasOpen.current && !ctx.isOpen) {
            const el = triggerRef.current;
            // Only reclaim focus if nothing else took it (a modal the menu
            // just opened must keep it).
            if (el && el.isConnected && (!document.activeElement || document.activeElement === document.body)) el.focus();
        }
        wasOpen.current = ctx.isOpen;
    }, [ctx.isOpen]);

    const tileProps = (scope: ConversationScope): RailTileMenuProps => ({
        'aria-haspopup': 'menu',
        onContextMenu: (e) => {
            const el = e.currentTarget;
            // A keyboard-synthesised contextmenu event carries no usable
            // pointer position (0,0 or the element's centre); anchor to the tile.
            const keyboardLike = e.clientX === 0 && e.clientY === 0;
            const r = el.getBoundingClientRect();
            openFor(scope, keyboardLike ? { clientX: r.right, clientY: r.top } : e, el, e);
        },
        onKeyDown: (e) => {
            if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
                const el = e.currentTarget;
                const r = el.getBoundingClientRect();
                openFor(scope, { clientX: r.right, clientY: r.top }, el, e);
            }
        },
    });

    return { menu: ctx.menu, tileProps, isOpen: ctx.isOpen };
}
