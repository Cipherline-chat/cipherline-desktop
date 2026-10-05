import { useEffect, useRef } from 'react';
import { pushEscapeLayer, type EscapeHandler } from '../utils/escapeStack';

/**
 * Make Escape back out of this surface while `active` is true.
 *
 * The layer is registered when `active` becomes true and removed when it
 * becomes false or the component unmounts. It is NOT re-registered when the
 * handler identity changes: re-registering would move this surface to the top
 * of the stack on every render, so a component that re-renders underneath an
 * open dialog would steal Escape from that dialog. The latest handler is read
 * through a ref instead.
 *
 * Usage:
 *   useEscape(() => setOpen(false), open);
 *   useEscape(cancelEdit, !!editingId);
 */
export function useEscape(handler: EscapeHandler, active: boolean = true): void {
    const handlerRef = useRef(handler);
    useEffect(() => { handlerRef.current = handler; });

    useEffect(() => {
        if (!active) return;
        return pushEscapeLayer((event) => handlerRef.current(event));
    }, [active]);
}
