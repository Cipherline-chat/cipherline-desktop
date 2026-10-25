/**
 * The custom tabs of the emoji picker's bottom bar: "Server emojis" (the open
 * server's custom emojis; ONLY when the picker was opened in a server context,
 * never in DMs / group DMs / the status editor) and "My Emojis" (the user's
 * personal ones; always present).
 *
 * emoji-mart skips a custom category that has no emojis, so an empty tab would
 * simply not exist. To keep a present tab visible (and explain itself when
 * empty) an empty category carries ONE hidden placeholder entry; picking the
 * tab then shows an empty-state panel (EmojiPickerEmptyState) over the grid.
 * Pure data + helpers, so it is unit-tested without emoji-mart or a DOM.
 */

export type EmojiTabId = 'server' | 'mine';

export interface EmojiTabDef {
    id: EmojiTabId;
    /** emoji-mart category id. */
    categoryId: string;
    /** Tab tooltip / aria-label and the category heading. */
    label: string;
    /** emoji-mart emoji id AND name of the hidden placeholder (the name becomes
     *  the button's title, which the injected CSS keys on). */
    placeholder: string;
    emptyTitle: string;
    emptyBody: string;
    /** Inline SVG (emoji-mart takes markup, not a component): solid versions of
     *  the lucide `Server` / `SmilePlus` glyphs Create Server and Personalize use. */
    iconSvg: string;
}

// Solid, like emoji-mart's own category glyphs on the same bar (outline icons
// read as a different set next to them). Holes are even-odd cut-outs.
const svg = (d: string) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    + `<path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>`;
const dot = (cx: number, cy: number, r: number) =>
    `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const SERVER_EMOJI_TAB: EmojiTabDef = {
    id: 'server',
    categoryId: 'server_emojis',
    label: 'Server emojis',
    placeholder: 'cl-empty-server',
    emptyTitle: 'No server emojis here yet',
    emptyBody: 'Emojis added to this server show up here.',
    iconSvg: svg('M4.5 2.5h15a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 8V5a2.5 2.5 0 0 1 2.5-2.5z'
        + dot(6.5, 6.5, 1.4)
        + 'M4.5 13.5h15a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 19v-3a2.5 2.5 0 0 1 2.5-2.5z'
        + dot(6.5, 17.5, 1.4)),
};

export const MY_EMOJI_TAB: EmojiTabDef = {
    id: 'mine',
    categoryId: 'my_emojis',
    label: 'My Emojis',
    placeholder: 'cl-empty-mine',
    emptyTitle: 'No emojis of your own yet',
    emptyBody: 'Save emojis with right-click or add your own in Settings → Personalize.',
    iconSvg: svg(dot(10.5, 13.5, 8.5)
        + dot(7.6, 11.2, 1.35) + dot(13.4, 11.2, 1.35)
        + 'M6.9 14.6q3.6 4.4 7.2 0q-3.6 2.2-7.2 0z'
        + 'M18.2 1.5h1.6v3.2H23v1.6h-3.2v3.2h-1.6V6.3H15V4.7h3.2z'),
};

export const EMOJI_TABS: readonly EmojiTabDef[] = [SERVER_EMOJI_TAB, MY_EMOJI_TAB];

export const EMPTY_PLACEHOLDER_PREFIX = 'cl-empty-';
export const isEmptyPlaceholderId = (id: string | null | undefined): boolean =>
    !!id && id.startsWith(EMPTY_PLACEHOLDER_PREFIX);

export interface PickerEmojiInput { id: string; name: string; src: string }

export interface PickerCategory { id: string; name: string; icon: { svg: string }; emojis: unknown[] }

/**
 * The tabs, in bar order: Server emojis (only when `serverTab`) then My Emojis.
 * Without a server context the Server tab and its placeholder do not exist at
 * all, so it can never be reported empty. An empty list becomes the placeholder.
 * `search: ','` pre-fills emoji-mart's search haystack so the placeholder can
 * never match a query.
 */
export function buildEmojiTabCategories(
    server: readonly PickerEmojiInput[],
    mine: readonly PickerEmojiInput[],
    placeholderSrc: string,
    serverTab: boolean,
): { categories: PickerCategory[]; emptyTabs: EmojiTabId[] } {
    const emptyTabs: EmojiTabId[] = [];
    const categories = EMOJI_TABS.filter(tab => serverTab || tab.id !== 'server').map(tab => {
        const list = tab.id === 'server' ? server : mine;
        let emojis: unknown[];
        if (list.length > 0) {
            emojis = list.map(e => ({ id: e.id, name: e.name, keywords: [e.name], skins: [{ src: e.src }] }));
        } else {
            emptyTabs.push(tab.id);
            emojis = [{ id: tab.placeholder, name: tab.placeholder, keywords: [], search: ',', skins: [{ src: placeholderSrc }] }];
        }
        return { id: tab.categoryId, name: tab.label, icon: { svg: tab.iconSvg }, emojis };
    });
    return { categories, emptyTabs };
}

/** Which EMPTY tab a nav-bar button label refers to, else null. */
export function emptyTabForLabel(label: string | null | undefined, emptyTabs: readonly EmojiTabId[]): EmojiTabDef | null {
    if (!label) return null;
    const tab = EMOJI_TABS.find(t => t.label === label);
    return tab && emptyTabs.includes(tab.id) ? tab : null;
}

/** Shadow-root CSS: keep the placeholder tile invisible. */
export const PLACEHOLDER_HIDE_CSS = EMOJI_TABS.map(t => `button[title="${t.placeholder}"]`).join(', ') + ' { display: none !important; }';
