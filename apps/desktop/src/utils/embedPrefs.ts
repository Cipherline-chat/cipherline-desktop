/**
 * Settings → Appearance → Link previews → "Compact embeds" (owner, 2026-11-23).
 *
 *   expanded (default)  videos (YouTube, Medal and other clip pages, direct
 *                       files) always take the full player size, playing or
 *                       not: a player-size poster with a play button. Nothing
 *                       streams before the click.
 *   compact             videos are the compact clip card (thumbnail + text in
 *                       one row), which grows into the player on play.
 *
 * Images and GIFs are inline media in both modes.
 *
 * Phase 3 (sender-built web cards) hooks into the same switch:
 * WEB_CARD_STYLES maps each mode to the card styles the owner picked
 * (concepts/embeds-2026-11-23/round2/).
 *
 * Per device: stored in secureLocalStore under one device-global key, and NOT
 * backed up (services/backupRegistry.ts) - how dense this screen should be is
 * a choice about this screen. Nothing is written on mount; only a user change
 * writes.
 */
import { useSyncExternalStore } from 'react';
import * as storeModule from './secureLocalStore';
import { BACKUP_RESTORED_EVENT } from '../services/backupRegistry';

export const EMBED_PREFS_KEY = 'cipherline_embed_prefs';
export const EMBED_PREFS_CHANGED_EVENT = 'cipherline:embed-prefs-changed';

export type EmbedLayout = 'expanded' | 'compact';

export interface EmbedPrefs { compact: boolean }
export const DEFAULT_EMBED_PREFS: EmbedPrefs = { compact: false };

/**
 * Web card styles per mode, for phase 3 (round-2 concepts): which style a card
 * uses depends on the page's picture (wide image, square image, none).
 *
 * Owner, 2026-11-23 (page snapshots: every page card now has a picture):
 * expanded is "big like the YouTube-looking one" (Island, the picture at the
 * player's size); compact "can be like the Amazon one with the earbuds"
 * (Ambient: text left, the picture in a rounded square on the right), for a
 * wide picture too. The no-picture Tile is only the fallback (walls, login
 * pages, failures).
 */
export const WEB_CARD_STYLES = {
    compact: { wide: 'ambient-wide', square: 'ambient-square', none: 'tile-no-image' },
    expanded: { wide: 'island', square: 'ambient', none: 'tile-no-image' },
} as const satisfies Record<EmbedLayout, Record<'wide' | 'square' | 'none', string>>;

export type WebCardPicture = keyof (typeof WEB_CARD_STYLES)['compact'];
export type WebCardStyle = (typeof WEB_CARD_STYLES)[EmbedLayout][WebCardPicture];

/**
 * The card-layout chooser phase 3 plugs into: the web-card style for a page
 * with a wide image, a square image, or none, under the current layout.
 */
export function webCardStyleFor(layout: EmbedLayout, picture: WebCardPicture): WebCardStyle {
    return WEB_CARD_STYLES[layout][picture];
}

/**
 * Largest box a GIF (a linked .gif, or a GIF-like loop) is drawn in, before
 * the column width caps it further (round 3): small in compact, large in
 * expanded. Frameless in both: just the picture with rounded corners.
 */
export const GIF_BOX: Record<EmbedLayout, { maxW: number; maxH: number }> = {
    compact: { maxW: 240, maxH: 180 },
    expanded: { maxW: 400, maxH: 300 },
};

/** The video-embed variant for a layout (ClipCard): row card, or always player size. */
export function videoCardVariant(layout: EmbedLayout): 'clip-card' | 'player' {
    return layout === 'compact' ? 'clip-card' : 'player';
}

type Store = typeof storeModule.secureLocalStore;
function store(): Store | undefined {
    try { return storeModule.secureLocalStore ?? (storeModule.default as unknown as Store); } catch { return undefined; }
}

/** Strict parse; anything malformed is the default. Never throws. */
export function parseEmbedPrefs(raw: string | null | undefined): EmbedPrefs {
    if (!raw) return DEFAULT_EMBED_PREFS;
    try {
        const o = JSON.parse(raw) as unknown;
        if (o && typeof o === 'object' && typeof (o as { compact?: unknown }).compact === 'boolean') {
            return { compact: (o as { compact: boolean }).compact };
        }
    } catch { /* default */ }
    return DEFAULT_EMBED_PREFS;
}

let lastRaw: string | null | undefined;
let snap: EmbedPrefs = DEFAULT_EMBED_PREFS;
function readRaw(): string | null {
    try { return store()?.getItem(EMBED_PREFS_KEY) ?? null; } catch { return null; }
}
export function getEmbedPrefs(): EmbedPrefs {
    const raw = readRaw();
    if (raw !== lastRaw) { lastRaw = raw; snap = parseEmbedPrefs(raw); }
    return snap;
}

function subscribe(cb: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    window.addEventListener(EMBED_PREFS_CHANGED_EVENT, cb);
    window.addEventListener(BACKUP_RESTORED_EVENT, cb);
    return () => {
        window.removeEventListener(EMBED_PREFS_CHANGED_EVENT, cb);
        window.removeEventListener(BACKUP_RESTORED_EVENT, cb);
    };
}

export function useEmbedPrefs(): EmbedPrefs {
    return useSyncExternalStore(subscribe, getEmbedPrefs, () => DEFAULT_EMBED_PREFS);
}

export function useEmbedLayout(): EmbedLayout {
    return useEmbedPrefs().compact ? 'compact' : 'expanded';
}

/** A user change. The only writer. */
export function setEmbedCompact(compact: boolean): void {
    try { store()?.setItem(EMBED_PREFS_KEY, JSON.stringify({ compact })); } catch { /* best effort */ }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new Event(EMBED_PREFS_CHANGED_EVENT));
    }
}
