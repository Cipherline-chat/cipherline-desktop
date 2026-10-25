/**
 * "Take me to that setting": after the settings search lands on a pane, find
 * the setting the search matched, open any disclosure it is folded inside,
 * scroll it into view and flash it once.
 *
 * Works on the rendered DOM rather than per-pane registries, because the
 * panes are independent components whose rows only exist once mounted (the
 * same reason settingsSearchIndex.ts exists). Matching order:
 *   1. an element whose whole text IS the label (deepest such element);
 *   2. an element carrying the label in `data-labels` ("a|b|c") — for index
 *      labels that are not literally on screen ("Camera adjustments");
 *   3. a heading-ish element whose text CONTAINS the label.
 * Nothing found = nothing happens; the user is still on the right pane.
 */
export const REVEAL_EVENT = 'sx-reveal';

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function deepestWithText(el: Element, want: string): Element {
    let cur = el;
    for (;;) {
        const next = Array.from(cur.children).find(c => norm(c.textContent) === want);
        if (!next) return cur;
        cur = next;
    }
}

export interface SettingTarget {
    target: HTMLElement;
    /** Closed disclosures / hidden tab panels (outermost first) that must open for target to show. */
    closed: HTMLElement[];
}

export function findSettingTarget(root: ParentNode, label: string): SettingTarget | null {
    const want = norm(label);
    if (!want) return null;
    const all = Array.from(root.querySelectorAll<HTMLElement>('*'));

    let target: HTMLElement | null = null;
    // 1. exact visible text (skip <option>s and the disclosure's own region wrapper text)
    const exact = all.find(el => el.tagName !== 'OPTION' && norm(el.textContent) === want);
    if (exact) target = deepestWithText(exact, want) as HTMLElement;
    // 2. declared labels
    if (!target) {
        target = all.find(el => {
            const raw = el.getAttribute('data-labels');
            return !!raw && raw.split('|').some(l => norm(l) === want);
        }) ?? null;
    }
    // 3. heading-ish element containing the label
    if (!target) {
        target = all.find(el => /^(B|STRONG|H3|H4|LABEL)$/.test(el.tagName) && norm(el.textContent).includes(want)) ?? null;
    }
    if (!target) return null;

    const closed: HTMLElement[] = [];
    let p: HTMLElement | null = target;
    while (p) {
        // A folded disclosure, or a hidden tab panel (Settings > Profile's tabs listen for REVEAL_EVENT too).
        if ((p.classList?.contains('sx-disc') && p.getAttribute('data-open') === 'false') || p.getAttribute?.('data-reveal-closed') === 'true') closed.unshift(p);
        p = p.parentElement;
        if (p === root) break;
    }
    return { target, closed };
}

/** The block worth highlighting around a matched label: its row, else its card. */
function highlightBlock(target: HTMLElement): HTMLElement {
    return (target.closest('.sd-row, .vv-row, .sd-secrow, .sx-disc-head, .sd-opt') as HTMLElement | null)
        ?? (target.classList.contains('sx-disc') ? (target.querySelector('.sx-disc-head') as HTMLElement | null) : null)
        ?? (target.closest('.sd-card') as HTMLElement | null)
        ?? target;
}

export function revealSetting(
    root: HTMLElement,
    label: string,
    schedule: (fn: () => void) => void = fn => requestAnimationFrame(() => requestAnimationFrame(fn)),
): boolean {
    const found = findSettingTarget(root, label);
    if (!found) return false;
    for (const d of found.closed) d.dispatchEvent(new CustomEvent(REVEAL_EVENT));
    schedule(() => {
        const block = highlightBlock(found.target);
        const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        block.scrollIntoView?.({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
        block.classList.remove('sx-flash');
        // restart the one-shot highlight even if it was just shown
        void block.offsetWidth;
        block.classList.add('sx-flash');
        window.setTimeout(() => block.classList.remove('sx-flash'), 1900);
    });
    return true;
}
