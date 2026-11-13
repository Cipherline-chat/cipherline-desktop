import { useSyncExternalStore } from 'react';

/**
 * "The pointer is on this message's author NAME" - shared between the name
 * (a sibling of the avatar deep inside ChatPane's row render) and that row's
 * avatar, so hovering the name can play an animated avatar.
 *
 * It is an external store rather than ChatPane state on purpose: ChatPane is
 * the largest component in the app, and a state flip there on every name
 * enter/leave would re-render the whole message list. With a per-row boolean
 * selector only the avatar whose answer changed re-renders.
 */
let hoveredKey: string | null = null;
const listeners = new Set<() => void>();

const emit = () => { for (const l of listeners) l(); };

/** Pointer entered the author name of `key` (the message id). */
export function enterAuthorName(key: string): void {
    if (hoveredKey === key) return;
    hoveredKey = key;
    emit();
}

/** Pointer left the author name of `key`. A no-op if another name already took over. */
export function leaveAuthorName(key: string): void {
    if (hoveredKey !== key) return;
    hoveredKey = null;
    emit();
}

const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
};

/** True while the pointer is over the author name of `key`. */
export function useAuthorNameHovered(key: string): boolean {
    return useSyncExternalStore(
        subscribe,
        () => hoveredKey === key,
        () => false,
    );
}

/** Test seam. */
export const _peekAuthorNameHover = (): string | null => hoveredKey;
