import { useEffect, type RefObject } from 'react';

/**
 * Custom emoji tiles that were drawn before their image was ready.
 *
 * emoji-mart wraps every emoji button in a component that only re-renders when
 * selected, skin or size change, and keys it by position + id, so a new `src` for a
 * tile already on screen is ignored until something selects it: the Frequently Used
 * row, which is on screen from the first frame, sat on its blank placeholder until
 * hovered. Other categories render later, usually with the image ready.
 *
 * Each placeholder therefore names its emoji in the URL fragment, and this swaps the
 * real image in on those exact <img>s. That needs no change to emoji-mart and no
 * rebuild of the grid, which is expensive (see the PERF note in EmojiPicker).
 */

/** A neutral rounded tile: an inline SVG data URI (CSP img-src allows data:), no network. */
export const CUSTOM_EMOJI_PLACEHOLDER_SRC =
    'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
        '<rect x="2" y="2" width="20" height="20" rx="6" fill="#ffffff" fill-opacity="0.10"/></svg>',
    );

const MARK = '#cl-emoji=';

/** The placeholder for one emoji. A fragment does not change what a data: URL draws. */
export const placeholderSrcFor = (id: string): string =>
    `${CUSTOM_EMOJI_PLACEHOLDER_SRC}${MARK}${encodeURIComponent(id)}`;

/** Swap any resolved image onto the tiles still showing their placeholder. */
export function fillResolvedPlaceholders(root: ParentNode, urlFor: (id: string) => string | undefined): void {
    for (const img of root.querySelectorAll<HTMLImageElement>('img[src^="data:image/svg+xml"]')) {
        const src = img.getAttribute('src') ?? '';
        const at = src.indexOf(MARK);
        if (at < 0) continue;
        const url = urlFor(decodeURIComponent(src.slice(at + MARK.length)));
        if (url) img.setAttribute('src', url);
    }
}

/**
 * Keep an open picker's placeholders filled, including tiles emoji-mart draws after
 * the image arrived (its first render is async, and rows render as they scroll in).
 * Watches for new nodes only, so swapping a `src` does not wake it.
 */
export function useFillResolvedPlaceholders(
    wrapRef: RefObject<HTMLElement | null>,
    urls: Readonly<Record<string, string>>,
): void {
    useEffect(() => {
        const urlFor = (id: string) => urls[id];
        let observer: MutationObserver | null = null;
        const attach = (): boolean => {
            const root = wrapRef.current?.querySelector('em-emoji-picker')?.shadowRoot;
            if (!root) return false;
            fillResolvedPlaceholders(root, urlFor);
            observer = new MutationObserver(() => fillResolvedPlaceholders(root, urlFor));
            observer.observe(root, { childList: true, subtree: true });
            return true;
        };
        let timer: ReturnType<typeof setInterval> | null = null;
        if (!attach()) {
            // The custom element and its shadow root appear a moment after mount.
            timer = setInterval(() => {
                if (attach() && timer) { clearInterval(timer); timer = null; }
            }, 50);
        }
        return () => {
            if (timer) clearInterval(timer);
            observer?.disconnect();
        };
    }, [wrapRef, urls]);
}
