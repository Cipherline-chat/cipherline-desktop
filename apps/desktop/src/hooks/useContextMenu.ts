/**
 * useContextMenu — boilerplate-reducer for the right-click menu pattern.
 *
 * The pattern that used to be repeated in every list component:
 *
 *   const [menu, setMenu] = useState<{x, y, items} | null>(null);
 *   const onContextMenu = (e) => {
 *     e.preventDefault();
 *     e.stopPropagation();
 *     window.dispatchEvent(new Event('close-all-popovers'));
 *     setMenu({ x: e.clientX, y: e.clientY, items: [...] });
 *   };
 *   const close = () => setMenu(null);
 *   {menu && <ContextMenuPortal {...menu} onClose={close} />}
 *
 * With this hook:
 *
 *   const ctx = useContextMenu();
 *   <Row onContextMenu={(e) => ctx.open(e, [items], 'optional title')}>...</Row>
 *   {ctx.menu}
 *
 * Each consumer of this hook owns a SINGLE menu — the `items` change as the
 * user right-clicks different rows in the same list. That's the natural
 * shape: lists have one menu at a time. For multiple independent menus
 * call the hook multiple times.
 */

import React from 'react';
import { ContextMenu, type ContextMenuItem } from '../components/primitives/ContextMenu';

interface OpenArgs {
    items: ContextMenuItem[];
    title?: string;
}

interface UseContextMenu {
    /** Render this in your JSX — `null` when no menu is open. */
    menu: React.ReactNode;
    /** Open the menu at the click position, replacing any prior items. */
    open: (
        e: React.MouseEvent | { clientX: number; clientY: number },
        items: ContextMenuItem[],
        title?: string,
    ) => void;
    /** Replace the items in an already-open menu (e.g. optimistic checkbox flip). */
    updateItems: (items: ContextMenuItem[]) => void;
    /** Close the menu programmatically. */
    close: () => void;
    isOpen: boolean;
}

export function useContextMenu(): UseContextMenu {
    const [state, setState] = React.useState<{ x: number; y: number } & OpenArgs | null>(null);

    const open: UseContextMenu['open'] = (e, items, title) => {
        if ('preventDefault' in e) {
            e.preventDefault();
            e.stopPropagation();
        }
        // Match PopoverMenu / ParticipantCard's global "one popover at a time" signal.
        window.dispatchEvent(new Event('close-all-popovers'));
        const x = 'clientX' in e ? e.clientX : (e as { clientX: number }).clientX;
        const y = 'clientY' in e ? e.clientY : (e as { clientY: number }).clientY;
        setState({ x, y, items, title });
    };

    const close = React.useCallback(() => setState(null), []);

    const updateItems = React.useCallback((newItems: ContextMenuItem[]) => {
        setState(prev => prev ? { ...prev, items: newItems } : null);
    }, []);

    // Memoize anchor so ContextMenu's useLayoutEffect([anchor]) doesn't fire
    // on every parent re-render when x/y haven't actually changed.
    const anchorX = state?.x ?? 0;
    const anchorY = state?.y ?? 0;
    const anchor = React.useMemo(
        () => ({ x: anchorX, y: anchorY }),
        [anchorX, anchorY],
    );

    const menu = state
        ? React.createElement(ContextMenu, {
            anchor,
            items: state.items,
            onClose: close,
            title: state.title,
        })
        : null;

    return { menu, open, updateItems, close, isOpen: !!state };
}
