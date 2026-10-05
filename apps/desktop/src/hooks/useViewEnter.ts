import { useLayoutEffect, useRef } from 'react';

/**
 * Re-play the shared `.view-enter` settle-in (index.css) on an element that
 * STAYS MOUNTED while the view it shows changes.
 *
 * Pane 3 gets its enter animation for free by `key`-ing its content on the
 * active chat/channel, so React remounts it and the CSS animation plays. The
 * list column can't do that: it's one `<aside>` that persists across
 * DMs↔servers and server→server, and a `key` remount there would reset the
 * channel list's collapsed categories and scroll position on every switch.
 * Removing and re-adding the class (with a forced reflow between, or the
 * browser coalesces the two writes and nothing restarts) replays the animation
 * on the persistent node and loses no state.
 *
 * The element must carry `view-enter` in its own className so the FIRST mount
 * animates via plain CSS; this hook only handles subsequent key changes.
 * Reduced motion is honoured by the CSS (`animation: none`), which makes the
 * remove/add here a harmless no-op.
 */
export function useViewEnter<T extends HTMLElement>(viewKey: string) {
    const ref = useRef<T>(null);
    const mounted = useRef(false);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (!mounted.current) { mounted.current = true; return; }
        el.classList.remove('view-enter');
        void el.offsetWidth;
        el.classList.add('view-enter');
    }, [viewKey]);

    return ref;
}
