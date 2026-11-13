import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { MY_EMOJI_TAB } from './emojiPickerTabs';

export const ADD_BUTTON_CLASS = 'cl-add-emoji';
const HEADER_SELECTOR = `.category[data-id="${MY_EMOJI_TAB.categoryId}"] .sticky`;
const PLUS_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" fill="none"/></svg>';

/** Shadow-root CSS for the injected "+" (emoji-mart's own markup can't take React). */
export const ADD_BUTTON_CSS = `
    ${HEADER_SELECTOR} { display: flex !important; align-items: center; justify-content: space-between; }
    button.${ADD_BUTTON_CLASS} {
        display: inline-flex; align-items: center; gap: 4px; flex: none;
        height: 20px; padding: 0 8px 0 6px; margin: 0; border: 0; border-radius: 6px;
        background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8);
        font: 700 11px/1 var(--font-family, inherit); letter-spacing: 0; text-transform: none; cursor: pointer;
        transition: background 0.15s, color 0.15s;
    }
    button.${ADD_BUTTON_CLASS}:hover { background: rgba(37,224,200,0.18); color: rgb(37,224,200); }
    button.${ADD_BUTTON_CLASS}:focus-visible { outline: 2px solid rgb(37,224,200); outline-offset: 1px; }
    /* An EMPTY My Emojis section (only the hidden placeholder): the empty-state panel carries its own button. */
    .category[data-id="${MY_EMOJI_TAB.categoryId}"]:has(button[title="${MY_EMOJI_TAB.placeholder}"]) button.${ADD_BUTTON_CLASS} { display: none; }
    button.${ADD_BUTTON_CLASS}[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
    button.${ADD_BUTTON_CLASS}[aria-disabled="true"]:hover { background: rgba(255,255,255,0.08); color: rgba(255,255,255,0.8); }
`;

export interface AddButtonState { disabled: boolean; label: string; tooltip: string }

/**
 * A "+ Add" button in the My Emojis section header of the emoji-mart grid.
 *
 * emoji-mart renders inside a shadow root and rebuilds its grid on updates, so
 * the button is a real <button> created in that shadow DOM and re-attached by a
 * MutationObserver whenever the header is re-rendered (at most once a frame).
 * It stays focusable when the library is full (aria-disabled, the tooltip says
 * why) so a keyboard user can find out; a click then does nothing.
 *
 * Returns `focus()` to put focus back on it after the dialog closes.
 */
export function useMyEmojiAddButton(
    wrapRef: RefObject<HTMLElement | null>,
    state: AddButtonState,
    onClick: () => void,
): { focus: () => boolean } {
    const latest = useRef({ state, onClick });
    useEffect(() => { latest.current = { state, onClick }; });
    const rootRef = useRef<ShadowRoot | null>(null);
    const syncRef = useRef<() => void>(() => {});

    useEffect(() => {
        let observer: MutationObserver | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;
        let frame = 0;

        const sync = () => {
            frame = 0;
            const root = rootRef.current;
            const header = root?.querySelector(HEADER_SELECTOR);
            if (!root || !header) return;
            let btn = header.querySelector<HTMLButtonElement>(`button.${ADD_BUTTON_CLASS}`);
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = ADD_BUTTON_CLASS;
                btn.innerHTML = `${PLUS_SVG}<span>Add</span>`;
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const { state: s, onClick: go } = latest.current;
                    if (s.disabled) return;
                    go();
                });
                header.appendChild(btn);
            }
            const { state: s } = latest.current;
            if (btn.getAttribute('aria-label') !== s.label) btn.setAttribute('aria-label', s.label);
            if (btn.getAttribute('title') !== s.tooltip) btn.setAttribute('title', s.tooltip);
            const dis = s.disabled ? 'true' : 'false';
            if (btn.getAttribute('aria-disabled') !== dis) btn.setAttribute('aria-disabled', dis);
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
        syncRef.current = sync;

        const attach = (): boolean => {
            const picker = wrapRef.current?.querySelector('em-emoji-picker') as (Element & { shadowRoot: ShadowRoot | null }) | null;
            if (!picker?.shadowRoot) return false;
            rootRef.current = picker.shadowRoot;
            observer = new MutationObserver(schedule);
            observer.observe(picker.shadowRoot, { childList: true, subtree: true });
            schedule();
            return true;
        };
        // The custom element may not have upgraded on the first tick.
        if (!attach()) {
            interval = setInterval(() => { if (attach() && interval) { clearInterval(interval); interval = null; } }, 16);
        }
        return () => {
            if (interval) clearInterval(interval);
            if (frame) cancelAnimationFrame(frame);
            observer?.disconnect();
            rootRef.current?.querySelector(`button.${ADD_BUTTON_CLASS}`)?.remove();
            rootRef.current = null;
        };
    }, [wrapRef]);

    // A changed state (count crossed the cap) refreshes the label / tooltip at once.
    useEffect(() => { syncRef.current(); }, [state.disabled, state.label, state.tooltip]);

    const focus = useCallback((): boolean => {
        const btn = rootRef.current?.querySelector<HTMLButtonElement>(`button.${ADD_BUTTON_CLASS}`);
        if (!btn) return false;
        btn.focus();
        return rootRef.current?.activeElement === btn;
    }, []);

    return { focus };
}
