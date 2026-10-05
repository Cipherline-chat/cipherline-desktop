import { useEffect, type RefObject } from 'react';

/**
 * Close a popover / context menu / dropdown when the user clicks outside it,
 * AND consume that closing click so it doesn't trigger handlers on the
 * element behind it.
 *
 * Why the "consume" half matters: the chat row in ChatPane has an `onClick`
 * that toggles save/unsave (clicking blank space saves the message). If a
 * right-click context menu is open and the user clicks anywhere outside it
 * to close it, a naive `document.mousedown` listener closes the menu but
 * the SAME event keeps bubbling — its eventual `click` reaches the row's
 * onClick and saves the message the user never meant to save. Same pattern
 * applies in calls (clicking outside a participant tile's popover would fire
 * the tile's click handler), in the friends pane (closing a dropdown
 * re-opens it because the close-click hits the trigger button), and so on.
 *
 * What this hook does:
 *
 *   1. Listens for `mousedown` in the **capture phase** on `document`.
 *      Capture phase runs before any React synthetic event handler — so we
 *      get first refusal on the event before it reaches anything else.
 *
 *   2. If the target is inside `ref.current`, we let the event pass through
 *      unchanged (the user clicked an item in the menu — that should still
 *      do its thing).
 *
 *   3. Otherwise we call `onClose()` and **swallow** the rest of the click
 *      sequence — `mousedown`, `mouseup`, and the synthesized `click` —
 *      via one-shot capture-phase listeners. That stops React (and any
 *      other library) from delivering this click to elements underneath.
 *
 *   4. Only intercepts the primary (left) button — `e.button === 0`. A
 *      right-click outside an open menu should still be able to open a
 *      different context menu at the new location, which means we can't
 *      block the contextmenu sequence wholesale.
 *
 * The ref must wrap the popover AND its trigger button. If the trigger lives
 * outside the ref, clicking the trigger to "close" the menu would be
 * detected as an outside click — the menu would close, the button's onClick
 * would be swallowed, and the user couldn't toggle it via the trigger. The
 * fix is to include the trigger in the ref's subtree (the standard popover
 * layout: a wrapper div containing both button and menu, refed as a whole).
 * When the trigger genuinely can't share a parent with the popover (e.g. the
 * popover is portaled into document.body and the trigger lives elsewhere in
 * the React tree), pass a predicate as `inside` instead — the predicate can
 * return true for clicks inside ANY of the participating elements.
 *
 * `enabled` gates the listener; pass it `true` when the menu is open and
 * `false` otherwise so we don't burn cycles when nothing's visible.
 */
type InsideCheck = RefObject<HTMLElement | null> | ((target: Node) => boolean);

export function useDismissOnOutsideClick(
    inside: InsideCheck,
    enabled: boolean,
    onClose: () => void,
): void {
    useEffect(() => {
        if (!enabled) return;

        const isInside = (target: Node): boolean => {
            if (typeof inside === 'function') return inside(target);
            const el = inside.current;
            return !!(el && el.contains(target));
        };

        const onDown = (e: MouseEvent) => {
            if (isInside(e.target as Node)) return;

            // Outside click — always close. The CONSUMING half (stopping
            // propagation + swallowing the trailing mouseup/click) only runs
            // for primary (left) clicks below; for right-clicks we want the
            // event to keep flowing so the user can open a NEW context menu
            // at the new location with a single right-click. Middle-clicks
            // similarly fall through (paste, etc. should still work).
            onClose();
            if (e.button !== 0) return;

            // Stop the left-click from reaching anything behind. preventDefault
            // is also needed because some default actions (drag-start on text,
            // native form-control focus shifts) fire even when bubbling is
            // stopped.
            e.stopPropagation();
            e.preventDefault();

            // The mousedown we just consumed is only the first event in a
            // click sequence. The browser will still dispatch `mouseup` and
            // `click` next; if we don't also swallow those, React's onClick
            // handlers on elements behind the popover will still fire.
            //
            // One-shot capture-phase listeners on `document` for both, so
            // they auto-remove after firing once. Using `{ once: true }`
            // avoids a leaked listener if for some reason the click never
            // arrives (e.g. user holds the button and the page navigates).
            const swallow = (cev: Event) => {
                cev.stopPropagation();
                cev.preventDefault();
            };
            document.addEventListener('mouseup', swallow, { capture: true, once: true });
            document.addEventListener('click',   swallow, { capture: true, once: true });
        };

        document.addEventListener('mousedown', onDown, { capture: true });
        return () => document.removeEventListener('mousedown', onDown, { capture: true });
    }, [enabled, inside, onClose]);
}
