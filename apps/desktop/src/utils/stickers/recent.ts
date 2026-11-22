/**
 * The sticker picker's "Recent" row: the last stickers this account sent from
 * this device. In the encrypted backup and the history transfer (backupRegistry:
 * included, restore overwrites like any preference); never synced live between
 * devices. Encrypted at rest like every renderer setting (secureLocalStore),
 * account-scoped. Written only on a send — never on mount.
 */
import secureLocalStore from '../secureLocalStore';
import { PERSONAL_STICKER_ID_RE, SERVER_STICKER_ID_RE, STICKER_NAME_RE } from '@cipherline/shared';

export const RECENT_STICKERS_MAX = 16;
export const recentStickersKey = (uid: string) => `cipherline_recent_stickers_${uid}`;

export interface RecentSticker {
    source: 'server' | 'personal';
    id: string;
    name: string;
    server_id?: string;
}

function valid(r: unknown): r is RecentSticker {
    if (!r || typeof r !== 'object') return false;
    const c = r as Record<string, unknown>;
    if (typeof c.name !== 'string' || !STICKER_NAME_RE.test(c.name) || typeof c.id !== 'string') return false;
    if (c.source === 'personal') return PERSONAL_STICKER_ID_RE.test(c.id);
    if (c.source === 'server') return SERVER_STICKER_ID_RE.test(c.id) && typeof c.server_id === 'string' && SERVER_STICKER_ID_RE.test(c.server_id);
    return false;
}

const uid = () => { try { return secureLocalStore.getItem('cipherline_user_id') || null; } catch { return null; } };

/** Pure: put `s` first, drop its older copy, cap the list. */
export function pushRecent(list: readonly RecentSticker[], s: RecentSticker, max = RECENT_STICKERS_MAX): RecentSticker[] {
    const key = (r: RecentSticker) => `${r.source}:${r.id}`;
    return [s, ...list.filter(r => key(r) !== key(s))].slice(0, max);
}

export function loadRecentStickers(): RecentSticker[] {
    const u = uid();
    if (!u) return [];
    try {
        const raw = secureLocalStore.getItem(recentStickersKey(u));
        const v = raw ? JSON.parse(raw) : [];
        return Array.isArray(v) ? v.filter(valid).slice(0, RECENT_STICKERS_MAX) : [];
    } catch { return []; }
}

export function rememberRecentSticker(s: RecentSticker): void {
    const u = uid();
    if (!u || !valid(s)) return;
    try {
        const entry: RecentSticker = s.source === 'server'
            ? { source: 'server', id: s.id, name: s.name, server_id: s.server_id }
            : { source: 'personal', id: s.id, name: s.name };
        secureLocalStore.setItem(recentStickersKey(u), JSON.stringify(pushRecent(loadRecentStickers(), entry)));
    } catch { /* a nicety: never fails a send */ }
}
