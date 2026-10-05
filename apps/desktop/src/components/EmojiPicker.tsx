import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';
import { init, Data, SearchIndex } from 'emoji-mart';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useEscape } from '../hooks/useEscape';
import { useEncryptedAvatar } from '../hooks/useEncryptedAvatar';
import type { ServerEmoji } from '../hooks/useServerEmojis';

// Initialise the picker's own index once at module load (used by the
// <Picker> component below).
init({ data });

// ── Scoping custom emojis out of emoji-mart's OWN global search/frequently-
// used machinery ─────────────────────────────────────────────────────────
//
// `Data`/`SearchIndex` are GLOBAL MUTABLE SINGLETONS shared by every
// <Picker> instance in the whole app — nothing about them is scoped per
// component or per server. Once a custom emoji's id is pushed into
// `Data.emojis` (by the `custom` prop's own init pass), it stays there
// FOREVER unless something deletes it:
//   - `SearchIndex`'s own `Pool` cache is invalidated only when a genuinely
//     NEW (never-before-seen) emoji needs indexing — a stale id from a
//     DIFFERENT server keeps matching the picker's own search bar
//     regardless of which server (or DM, which should offer none at all)
//     is currently open.
//   - The "Frequently Used" row resolves its stored ids against
//     `Data.emojis` on every render; an id it can't resolve there gets
//     silently dropped — so pruning `Data.emojis` fixes the frequently-
//     used leak too, with no need to separately touch its own localStorage
//     index.
// Fix: every time a Picker is about to mount with a specific custom-emoji
// scope (this server's ids, or none for a DM), diff against whatever the
// PREVIOUS scope left behind and delete anything no longer valid. Each
// open is a fresh mount (EmojiPickerPopover is conditionally rendered, not
// kept alive hidden), so this runs exactly once per open — comparing
// against whatever the last open, anywhere in the app, registered.
let registeredCustomEmojiIds = new Set<string>();

function scopeCustomEmojis(currentIds: Set<string>): void {
    let prunedAny = false;
    for (const id of registeredCustomEmojiIds) {
        if (!currentIds.has(id)) {
            delete (Data as any).emojis[id];
            prunedAny = true;
        }
    }
    if (prunedAny) SearchIndex.reset();
    registeredCustomEmojiIds = currentIds;
}

// The `:query` autocomplete's search lives in emojiSearch.ts so it can load the
// dataset on demand without pulling this whole module (and emoji-mart) into
// the boot bundle. Re-exported here so existing importers keep working.
export { searchEmoji } from './emojiSearch';
export type { EmojiSuggestion } from './emojiSearch';

/** What the caller passes in to make a server's custom emojis selectable —
 *  a plain subset of ServerEmoji (the encrypted-blob key material, not a
 *  resolved image). EmojiPickerPopover resolves these to decrypted object
 *  URLs itself (see EmojiPickerCustomResolver below) only while it's open,
 *  since that's the only place a plain `src` string (not a React element) is
 *  actually needed — emoji-mart's own grid renders `<img src>` internally
 *  from its `custom` prop data, so it can't take a component. Every OTHER
 *  custom-emoji surface (autocomplete dropdown, reaction chips, inline
 *  message render) is ChatPane's own JSX and renders EmojiImage directly,
 *  with no resolver needed. */
export type CustomEmojiInput = Pick<ServerEmoji, 'emoji_id' | 'name' | 'attachment_id' | 'key_b64' | 'nonce_b64'>;

/** Payload emoji-mart's onEmojiSelect hands back. For a native pick, `native`
 *  is the unicode character and `id`/`src` describe emoji-mart's own dataset
 *  entry. For a custom pick, `native` is absent, `id` is the emoji_id we gave
 *  it, `name` is the emoji's name, and `src` is the decrypted object URL —
 *  see emoji-mart's getEmojiByEvent (skin.src present ⇒ emojiData.src set,
 *  native always undefined for a custom-category entry). */
export interface EmojiSelection {
    native?: string;
    id?: string;
    name?: string;
    src?: string;
}

// ── EmojiPickerPopover ────────────────────────────────────────────────────────
// Rendered via React portal at document.body so it is NEVER clipped by any
// ancestor's overflow:hidden (e.g. the rounded input-box container).
// Position is computed from the anchor element's bounding rect.

export interface PickerProps {
    onEmojiSelect: (emoji: EmojiSelection) => void;
    onClose: () => void;
    /** The button that triggered the picker — used for positioning. */
    anchorEl: HTMLElement | null;
    /** This server's custom emojis (omit/empty for DMs and groups — there is
     *  no server, so no custom category). See docs/custom-emoji-design.md. */
    customEmojis?: CustomEmojiInput[];
    /** Needed to decrypt customEmojis' blobs — see EmojiPickerCustomResolver. */
    token?: string | null;
}

/**
 * Resolves each custom emoji's encrypted blob to a decrypted object URL and
 * reports the accumulated map back to the parent. One `useEncryptedAvatar`
 * call per emoji, each in its OWN component instance (hooks can't run in a
 * loop) — mounted only while the picker is open, so this pays the decrypt
 * cost lazily rather than for every server the app has ever joined. Reuses
 * the exact same 3-tier cache (memory/IndexedDB/network) as every other
 * encrypted image in the app, so a picker reopened later is instant.
 */
const EmojiUrlProbe: React.FC<{
    emoji: CustomEmojiInput;
    token: string | null;
    onUrl: (emojiId: string, url: string | null) => void;
}> = ({ emoji, token, onUrl }) => {
    const url = useEncryptedAvatar(emoji.attachment_id, token, { keyB64: emoji.key_b64, nonceB64: emoji.nonce_b64 });
    const lastReported = useRef<string | null>(null);
    useEffect(() => {
        if (lastReported.current === url) return;
        lastReported.current = url;
        onUrl(emoji.emoji_id, url);
    }, [url, emoji.emoji_id, onUrl]);
    return null;
};

// Styles injected into emoji-mart's shadow root. emoji-mart's public CSS
// custom properties (--rgb-*, --font-family) only reach so far — its own
// focus rule (input[type=search]:focus { background-color: rgb(var(--em-rgb-input)) },
// full 100% opacity, solid white) and its header/footer chrome aren't
// covered by that surface at all, so those need real rule overrides
// injected straight into the shadow root instead. This is also where
// the emoji picker is brought in line with GifPicker's exact divider
// treatment (border rgba(255,255,255,0.07) under the header, above the
// footer) so the two read as a matched set instead of one being a
// generic bundled widget and the other custom-built chrome.
const SHADOW_OVERRIDES = `
    input[type=search] {
        background: rgba(255,255,255,0.07) !important;
        border: 1px solid rgba(255,255,255,0.10) !important;
        outline: none !important;
        box-shadow: none !important;
        transition: border-color 0.15s, box-shadow 0.15s !important;
        border-radius: 8px !important;
    }
    input[type=search]:focus {
        background: rgba(255,255,255,0.07) !important;
        border-color: rgba(37,224,200,0.65) !important;
        box-shadow: 0 0 0 3px rgba(37,224,200,0.15) !important;
    }
    /* :has() scopes this to the specific .padding-lr wrapping the search
       row (there are several unrelated .padding-lr wrappers elsewhere in
       the picker, e.g. around category rows) — same header divider color/
       weight as GifPicker's header border-bottom. */
    .padding-lr:has(.search) {
        border-bottom: 1px solid rgba(255,255,255,0.07) !important;
        padding-bottom: 8px !important;
        margin-bottom: 4px !important;
    }
    /* #nav is emoji-mart's own id for the bottom category bar — safe to
       target directly, no collision risk. Same footer divider GifPicker
       uses above its GIF count text. */
    #nav {
        border-top: 1px solid rgba(255,255,255,0.07) !important;
    }
`;

const EmojiPickerPopover: React.FC<PickerProps> = ({ onEmojiSelect, onClose, anchorEl, customEmojis, token }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0, pointerEvents: 'none', position: 'fixed', top: -9999 });

    // Resolved-URL cache for this server's custom emojis, fed by the probes
    // below. Empty entries (not yet resolved, or failed) are simply omitted
    // from emoji-mart's `custom` category — a still-decrypting emoji just
    // doesn't appear in the grid yet rather than showing a broken image.
    const [resolvedUrls, setResolvedUrls] = useState<Record<string, string | null>>({});
    const handleUrl = useCallback((emojiId: string, url: string | null) => {
        setResolvedUrls(prev => (prev[emojiId] === url ? prev : { ...prev, [emojiId]: url }));
    }, []);

    const customCategories = useMemo(() => {
        const list = customEmojis ?? [];
        // Deliberately called here (during render), not in a useEffect: the
        // child <Picker>'s own mount effect (which triggers emoji-mart's
        // internal init()) fires BEFORE a sibling/parent useEffect would —
        // effects run child-before-parent on mount — so a prune scheduled
        // via useEffect would lose that race on the very first open and
        // leave the FIRST mount of a session showing stale data. Mutating
        // emoji-mart's module-level singleton during render is technically
        // impure, but safe here: it's idempotent (recomputing with the same
        // ids is a no-op) and touches no React state, only an external
        // library's own global — see scopeCustomEmojis's own comment.
        scopeCustomEmojis(new Set(list.map(e => e.emoji_id)));

        if (list.length === 0) return undefined;
        const emojis = list
            .map(e => ({ id: e.emoji_id, name: e.name, url: resolvedUrls[e.emoji_id] }))
            .filter((e): e is { id: string; name: string; url: string } => !!e.url)
            .map(e => ({ id: e.id, name: e.name, keywords: [e.name], skins: [{ src: e.url }] }));
        if (emojis.length === 0) return undefined;
        return [{ id: 'server_emojis', name: 'This Server', emojis }];
    }, [customEmojis, resolvedUrls]);

    // Two-pass positioning: first render off-screen (invisible) so we can measure
    // the picker's actual rendered height, then snap to the correct position.
    useLayoutEffect(() => {
        if (!anchorEl) return;

        const compute = () => {
            const r = anchorEl.getBoundingClientRect();
            const MARGIN = 8;
            const pickerH = ref.current?.offsetHeight || 435;
            const pickerW = ref.current?.offsetWidth  || 352;

            // Vertical: prefer above, fall back to below if insufficient space.
            const spaceAbove = r.top - MARGIN;
            let posStyle: Pick<React.CSSProperties, 'top' | 'bottom'>;
            if (spaceAbove >= pickerH) {
                posStyle = { bottom: window.innerHeight - r.top + MARGIN };
            } else if (window.innerHeight - r.bottom - MARGIN >= pickerH) {
                // Enough room below — place under the anchor
                posStyle = { top: r.bottom + MARGIN };
            } else {
                // Not enough room either side — pin to top margin
                posStyle = { top: MARGIN };
            }

            // Horizontal: right-align to anchor, clamp so picker stays on screen.
            const rawRight = window.innerWidth - r.right;
            const right = Math.max(MARGIN, Math.min(rawRight, window.innerWidth - pickerW - MARGIN));

            setStyle({
                position: 'fixed',
                ...posStyle,
                right,
                zIndex: 9999,
                opacity: 1,
                pointerEvents: 'auto',
            });
        };

        // Run after the browser has painted the off-screen picker so offsetHeight is accurate.
        const raf = requestAnimationFrame(compute);
        return () => cancelAnimationFrame(raf);
    }, [anchorEl]);

    // Close on outside click (exclude the anchor button itself so the button's
    // own toggle handler can close it without immediately reopening). The
    // predicate form of useDismissOnOutsideClick lets us treat both the
    // picker AND the anchor as "inside."
    useDismissOnOutsideClick(
        useCallback(
            (t: Node) => !!(ref.current?.contains(t)) || !!(anchorEl?.contains(t)),
            [anchorEl],
        ),
        true,
        onClose,
    );

    // TASK 2: this popover had no Escape-to-close at all before. Capture
    // phase wins over any internal handling emoji-mart's own search input
    // might do (e.g. clearing its query) — a single Escape closes the whole
    // picker, matching the other pickers in the app.
    useEscape(onClose);

    // Inject search-input focus styles directly into emoji-mart's shadow root.
    // CSS custom properties can't target :focus states inside shadow DOM, so we
    // adopt a constructed stylesheet onto the shadow root after the picker mounts.
    useEffect(() => {
        let styleEl: HTMLStyleElement | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;

        const inject = () => {
            const picker = ref.current?.querySelector('em-emoji-picker');
            const root = (picker as any)?.shadowRoot as ShadowRoot | null | undefined;
            if (!root) return false;
            // Avoid double-injection on HMR re-runs
            if (root.querySelector('#cl-search-overrides')) return true;
            styleEl = document.createElement('style');
            styleEl.id = 'cl-search-overrides';
            styleEl.textContent = SHADOW_OVERRIDES;
            root.appendChild(styleEl);
            return true;
        };

        // The shadow root may not exist on the first tick if the custom element
        // hasn't upgraded yet — poll with rAF until it's available.
        if (!inject()) {
            interval = setInterval(() => { if (inject() && interval) clearInterval(interval!); }, 16);
        }

        return () => {
            if (interval) clearInterval(interval);
            styleEl?.remove();
        };
    }, []);

    // PERF: @emoji-mart/react calls `picker.update(props)` on EVERY render of
    // its wrapper, and emoji-mart treats any update that includes `custom`
    // (always present here) as a grid reset: it re-runs its whole data init
    // over ~1,900 emojis and rebuilds the grid. This popover re-renders right
    // after mount (the positioning pass below) and whenever ChatPane does
    // (typing, hover, presence), so every open built the picker twice and an
    // open picker kept rebuilding itself. Keep the <Picker> element identical
    // across renders unless its real inputs change — React then skips the
    // wrapper and no update() is sent. The select handler goes through a ref
    // so a new parent closure doesn't count as a change.
    const onSelectRef = useRef(onEmojiSelect);
    useLayoutEffect(() => { onSelectRef.current = onEmojiSelect; });
    const stableOnSelect = useCallback((e: EmojiSelection) => onSelectRef.current(e), []);
    const pickerEl = useMemo(() => (
            <Picker
                data={data}
                custom={customCategories}
                onEmojiSelect={stableOnSelect}
                theme="dark"
                set="native"
                // Focus the search box as soon as the picker opens (from the message
                // bar or a reaction) so typing searches immediately, like the GIF picker.
                autoFocus
                skinTonePosition="search"
                previewPosition="none"
                navPosition="bottom"
                perLine={8}
                // Default is a fully circular ("100%") hover/press shape —
                // the one other place in the app that has grid cells with
                // their own hover state (GifPicker's thumbnails) uses a
                // rounded square (6px), matching cl-ds buttons generally.
                // A circle here was the single biggest "this is a stock
                // library widget" tell independent of color.
                emojiButtonRadius="8px"
            />
    ), [customCategories, stableOnSelect]);

    return createPortal(
        <>
            {(customEmojis ?? []).map(e => (
                <EmojiUrlProbe key={e.emoji_id} emoji={e} token={token ?? null} onUrl={handleUrl} />
            ))}
            <div
            ref={ref}
            style={{
                ...style,
                background:   '#1e2024',
                border:       '1px solid rgba(255,255,255,0.08)',
                borderRadius: 12,
                boxShadow:    '0 8px 32px rgba(0,0,0,0.6)',
                overflow:     'hidden',
            }}
            onClick={e => e.stopPropagation()}
        >
            {pickerEl}
            {/*
              * Override emoji-mart's web-component (em-emoji-picker) CSS variables.
              * CSS custom properties cross the shadow-DOM boundary, so --rgb-background
              * changes the picker's internal background to match the GIF picker (#1e2024).
              * border/box-shadow/border-radius !important strips the picker's own shell
              * so our wrapper div provides those instead.
              */}
            {/*
              * --rgb-* (no em- prefix) are the PUBLIC override variables.
              * Internally emoji-mart does: --em-rgb-background: var(--rgb-background, 21,22,23)
              * so setting --rgb-background from outside cascades through.
              * --rgb-input is intentionally omitted — our shadow-root injection
              * controls the search input colours directly to match the GIF picker.
              *
              * --rgb-accent drives the picker's own selected-category underline,
              * hover highlight, and skin-tone-selected ring. It shipped as a
              * generic blue (94,142,224) that doesn't match the app's brand
              * teal (--cl-lume, 37,224,200 — the same accent GifPicker's search
              * focus ring and every other cl-ds control uses), which is the
              * main thing that made this picker read as "a bundled library
              * widget" rather than a native part of the app. --font-family
              * pulls in the app's own body font so category labels and the
              * "no results" text don't fall back to emoji-mart's own default
              * instead of matching every other piece of chrome around it.
              */}
            <style>{`
                em-emoji-picker {
                    --rgb-background: 30, 32, 36;
                    --rgb-color: 255, 255, 255;
                    --rgb-accent: 37, 224, 200;
                    --color-border: rgba(255,255,255,0.07);
                    --font-family: var(--cl-font-body);
                    /* --category-icon-size has no --em- indirection layer —
                       :host hardcodes its own 18px default at the same
                       specificity a plain type-selector override can't
                       beat, so this needs !important to actually win.
                       20px brings the category row closer to the icon
                       sizing used elsewhere in cl-ds instead of reading
                       slightly undersized/generic. */
                    --category-icon-size: 20px !important;
                    border: none !important;
                    box-shadow: none !important;
                    border-radius: 0 !important;
                }
            `}</style>
        </div>
        </>,
        document.body
    );
};

export default EmojiPickerPopover;
