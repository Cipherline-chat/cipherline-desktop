/**
 * Isolation for the Screen Lock: while the lock overlay is up, NOTHING else in
 * the document can be focused, tabbed to, clicked through, or read by a screen
 * reader.
 *
 * The overlay is opaque, so nobody can SEE the app behind it — but opaque is
 * not the same as unreachable. Without this, Tab walked straight past the PIN
 * field into the composer and the buttons behind the lock, and typing there
 * worked: someone at a locked machine could act on the app. `inert` closes
 * that (no focus, no pointer, no hit-testing), `aria-hidden` closes the
 * assistive-tech side. Nothing is unmounted, so the WebSocket, fetches and any
 * live call carry on exactly as before — this only removes the keyboard and
 * pointer from them.
 *
 * Shape. The overlay is a descendant of the Dashboard root, so the root itself
 * cannot be inert (inert is inherited and would take the lock down with it).
 * Instead every SIBLING along the overlay's ancestor chain is made inert: the
 * rest of the Dashboard's content, then Dashboard's siblings in the app
 * container, then every other child of <body> — which is where the portaled UI
 * lives (modals, menus, toasts, the call panels). The chain itself (the overlay
 * and its ancestors) stays live. Elements that appear while locked (a toast, a
 * modal opened by an incoming call) are caught by a MutationObserver on each
 * level of the chain and isolated too. On release every attribute is put back
 * as it was found.
 */

/** Opt a node out of isolation: only for things with no interactive content that the window needs (the frameless drag strip). */
export const LOCK_EXEMPT_ATTR = 'data-lock-exempt';

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);

interface Saved { inert: boolean; ariaHidden: string | null }

/**
 * Make everything outside `overlay` (and its ancestor chain) inert. Returns the
 * release function, which restores every attribute it touched.
 */
export function isolateFromLock(overlay: HTMLElement): () => void {
    const marked = new Map<Element, Saved>();
    const observers: MutationObserver[] = [];
    // overlay, then each ancestor up to (and excluding) <body>.
    const chain: Element[] = [];
    for (let el: Element | null = overlay; el && el !== document.body; el = el.parentElement) chain.push(el);
    const onChain = new Set<Element>(chain);

    const mark = (el: Element) => {
        if (onChain.has(el) || marked.has(el)) return;
        if (SKIP_TAGS.has(el.tagName) || el.hasAttribute(LOCK_EXEMPT_ATTR)) return;
        marked.set(el, { inert: el.hasAttribute('inert'), ariaHidden: el.getAttribute('aria-hidden') });
        el.setAttribute('inert', '');
        el.setAttribute('aria-hidden', 'true');
    };

    // Each parent along the chain (the overlay's parent … body): isolate its
    // current children, and watch for new ones.
    const parents: Element[] = [];
    for (const el of chain) if (el.parentElement) parents.push(el.parentElement);
    if (!parents.includes(document.body)) parents.push(document.body);
    for (const parent of new Set(parents)) {
        Array.from(parent.children).forEach(mark);
        const mo = new MutationObserver((records) => {
            for (const r of records) r.addedNodes.forEach((n) => { if (n.nodeType === 1) mark(n as Element); });
        });
        mo.observe(parent, { childList: true });
        observers.push(mo);
    }

    return () => {
        observers.forEach((o) => o.disconnect());
        marked.forEach((saved, el) => {
            if (!saved.inert) el.removeAttribute('inert');
            if (saved.ariaHidden === null) el.removeAttribute('aria-hidden');
            else el.setAttribute('aria-hidden', saved.ariaHidden);
        });
        marked.clear();
    };
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Tab / Shift+Tab wrap inside `overlay` instead of leaving it for the browser
 * chrome or <body>. (With everything else inert there is nowhere else to go;
 * without the wrap, focus falls out to <body> and the next key press is
 * addressed to nothing.) Returns the unregister function.
 */
export function trapTabWithin(overlay: HTMLElement): () => void {
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        const items = Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) { e.preventDefault(); return; }
        const active = document.activeElement as HTMLElement | null;
        const inside = !!active && overlay.contains(active);
        const first = items[0], last = items[items.length - 1];
        if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
        if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    // Capture + first-registered-enough: it only ever moves focus inside the overlay.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
}
