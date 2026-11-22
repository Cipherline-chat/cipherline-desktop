/**
 * The sticker picker — its own button next to the emoji button in the
 * composer (owner 2026-11-22: "treat it like emojis ... call it stickers and
 * have its own button").
 *
 * Sections, in order: Recent (this device), This server (when composing in a
 * server channel), My stickers, then every other server you are in that has
 * stickers. One scrolling list with headings; the rail on the left jumps to a
 * section. Search matches name, description and tags across all of them.
 *
 * Keyboard: focus starts in search; ArrowDown/Enter moves into / picks from
 * the grid; arrows move between tiles (4 per row), Enter/Space sends, Escape
 * closes. Data: My stickers is local (personalStickers()); server stickers come
 * from one GET /v1/stickers (utils/stickers/serverStickers.ts), refreshed when
 * opened if older than a minute and live on server:stickers_updated.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Search, Plus, Sticker as StickerIcon, RefreshCw, User, X } from 'lucide-react';
import { stickerMatches, PERSONAL_STICKER_LIBRARY_MAX } from '@cipherline/shared';
import { useDismissOnOutsideClick } from '../../hooks/useDismissOnOutsideClick';
import { useEscape } from '../../hooks/useEscape';
import { usePersonalStickerLibrary } from '../../hooks/usePersonalStickers';
import {
    allStickersLoadedAt, refreshAllServerStickers, stickerListCache, useStickerCacheVersion, type ServerSticker,
} from '../../utils/stickers/serverStickers';
import { loadRecentStickers, type RecentSticker } from '../../utils/stickers/recent';
import type { EmojiEntry } from '../../utils/personalEmoji/library';
import { StickerImage } from './StickerImage';
import { AddStickerDialog } from './AddStickerDialog';
import { emojiFileProblem } from '../../utils/personalEmoji/pickFile';

export type StickerPick =
    | { kind: 'personal'; entry: Pick<EmojiEntry, 'id' | 'name' | 'mime' | 'animated'> }
    | { kind: 'server'; sticker: ServerSticker };

interface ServerInfoLite { server_id: string; name: string }

interface Props {
    anchorRect: DOMRect | null;
    token: string | null;
    /** The server whose channel is open, or null (DM / group). */
    currentServerId: string | null;
    /** For section names. */
    servers: readonly ServerInfoLite[];
    onPick: (pick: StickerPick) => void;
    onClose: () => void;
}

const COLS = 4;
const TILE = 84;
const INDEX_MAX_AGE_MS = 60_000;

interface Tile { key: string; pick: StickerPick; name: string; hint: string }
interface Section { id: string; title: string; icon: React.ReactNode; tiles: Tile[]; empty?: React.ReactNode }

const personalTile = (e: Pick<EmojiEntry, 'id' | 'name' | 'mime' | 'animated'>, prefix: string): Tile => ({
    key: `${prefix}:p:${e.id}`, pick: { kind: 'personal', entry: e }, name: e.name, hint: e.name,
});
const serverTile = (s: ServerSticker, prefix: string): Tile => ({
    key: `${prefix}:s:${s.sticker_id}`, pick: { kind: 'server', sticker: s }, name: s.name,
    hint: s.description ? `${s.name} — ${s.description}` : s.name,
});

const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || '?';

export const StickerPicker: React.FC<Props> = ({ anchorRect, token, currentServerId, servers, onPick, onClose }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const tileRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
    const [query, setQuery] = useState('');
    const [style, setStyle] = useState<React.CSSProperties>({ position: 'fixed', opacity: 0, pointerEvents: 'none' });
    const [indexState, setIndexState] = useState<'idle' | 'loading' | 'error'>(() => (allStickersLoadedAt() ? 'idle' : 'loading'));
    const [addFile, setAddFile] = useState<File | null>(null);
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const mine = usePersonalStickerLibrary();
    const cacheVersion = useStickerCacheVersion();
    const [recent] = useState<RecentSticker[]>(() => loadRecentStickers());

    useLayoutEffect(() => {
        if (!anchorRect) return;
        const width = Math.min(420, window.innerWidth - 16);
        const right = Math.max(8, window.innerWidth - anchorRect.right);
        setStyle({
            position: 'fixed',
            bottom: window.innerHeight - anchorRect.top + 8,
            right: Math.min(right, window.innerWidth - width - 8),
            width,
            height: Math.min(440, Math.max(260, anchorRect.top - 24)),
            zIndex: 9999,
            opacity: 1,
            pointerEvents: 'auto',
        });
    }, [anchorRect]);

    // An open Add dialog owns Escape and outside clicks.
    useDismissOnOutsideClick(containerRef, !addFile, onClose);
    useEscape(onClose, !addFile);

    const loadIndex = useCallback(async () => {
        if (!token) return;
        setIndexState(s => (allStickersLoadedAt() ? s : 'loading'));
        try {
            await refreshAllServerStickers(token);
            setIndexState('idle');
        } catch {
            setIndexState(allStickersLoadedAt() ? 'idle' : 'error');
        }
    }, [token]);

    useEffect(() => {
        if (Date.now() - allStickersLoadedAt() > INDEX_MAX_AGE_MS) void loadIndex();
        else setIndexState('idle');
    }, [loadIndex]);

    useEffect(() => { requestAnimationFrame(() => searchRef.current?.focus()); }, []);

    const serverName = useCallback((id: string) => servers.find(s => s.server_id === id)?.name ?? 'Server', [servers]);

    const sections = useMemo<Section[]>(() => {
        void cacheVersion;
        const q = query.trim();
        const out: Section[] = [];
        const mineById = new Map(mine.map(e => [e.id, e]));

        // Recent — only what still exists.
        if (!q && recent.length) {
            const tiles: Tile[] = [];
            for (const r of recent) {
                if (r.source === 'personal') {
                    const e = mineById.get(r.id);
                    if (e) tiles.push(personalTile(e, 'recent'));
                } else if (r.server_id) {
                    const s = stickerListCache.get(r.server_id)?.find(x => x.sticker_id === r.id);
                    if (s) tiles.push(serverTile(s, 'recent'));
                }
            }
            if (tiles.length) out.push({ id: 'recent', title: 'Recent', icon: <Clock size={16} />, tiles });
        }

        const serverSection = (id: string, title: string): Section | null => {
            const list = (stickerListCache.get(id) ?? []).filter(s => stickerMatches(q, s));
            if (!list.length) return null;
            return { id: `server:${id}`, title, icon: <span className="text-[10px] font-bold">{initials(title)}</span>, tiles: list.map(s => serverTile(s, id)) };
        };

        if (currentServerId) {
            const sec = serverSection(currentServerId, `${serverName(currentServerId)} (this server)`);
            if (sec) out.push(sec);
            else if (!q && stickerListCache.has(currentServerId)) {
                out.push({
                    id: `server:${currentServerId}`, title: `${serverName(currentServerId)} (this server)`,
                    icon: <span className="text-[10px] font-bold">{initials(serverName(currentServerId))}</span>, tiles: [],
                    empty: <span>No stickers on this server yet. People who can manage emojis and stickers add them in Server Settings → Stickers.</span>,
                });
            }
        }

        const mineTiles = mine.filter(e => stickerMatches(q, { name: e.name })).map(e => personalTile(e, 'mine'));
        if (mineTiles.length || !q) {
            out.push({
                id: 'mine', title: 'My stickers', icon: <User size={16} />, tiles: mineTiles,
                empty: <span>No stickers of your own yet. Add a picture, or right-click a sticker someone sent and choose Add to My stickers.</span>,
            });
        }

        const others = stickerListCache.serverIds()
            .filter(id => id !== currentServerId)
            .sort((a, b) => serverName(a).localeCompare(serverName(b)));
        for (const id of others) {
            const sec = serverSection(id, serverName(id));
            if (sec) out.push(sec);
        }
        return out;
    }, [query, mine, recent, currentServerId, serverName, cacheVersion]);

    const flat = useMemo(() => sections.flatMap(s => s.tiles), [sections]);

    // Keep the roving focus on a tile that still exists.
    useEffect(() => {
        if (focusKey && !flat.some(t => t.key === focusKey)) setFocusKey(null);
    }, [flat, focusKey]);

    const focusTile = (key: string | undefined) => {
        if (!key) return;
        setFocusKey(key);
        requestAnimationFrame(() => tileRefs.current.get(key)?.focus());
    };

    const pick = (t: Tile) => onPick(t.pick);

    const onGridKey = (e: React.KeyboardEvent, t: Tile) => {
        // Arrow movement within the tile's own section grid (rows of COLS).
        const sec = sections.find(s => s.tiles.includes(t));
        if (!sec) return;
        const i = sec.tiles.indexOf(t);
        const gi = flat.indexOf(t);
        let next: Tile | undefined;
        if (e.key === 'ArrowRight') next = flat[gi + 1];
        else if (e.key === 'ArrowLeft') next = flat[gi - 1];
        else if (e.key === 'ArrowDown') {
            next = sec.tiles[i + COLS];
            if (!next) {
                const after = sections.slice(sections.indexOf(sec) + 1).find(s => s.tiles.length);
                next = after?.tiles[Math.min(i % COLS, after.tiles.length - 1)];
            }
        } else if (e.key === 'ArrowUp') {
            next = sec.tiles[i - COLS];
            if (!next) {
                if (i < COLS && sections.indexOf(sec) === sections.findIndex(s => s.tiles.length)) {
                    e.preventDefault(); searchRef.current?.focus(); return;
                }
                const before = sections.slice(0, sections.indexOf(sec)).reverse().find(s => s.tiles.length);
                if (before) {
                    const lastRow = Math.floor((before.tiles.length - 1) / COLS) * COLS;
                    next = before.tiles[Math.min(lastRow + (i % COLS), before.tiles.length - 1)];
                }
            }
        } else if (e.key === 'Home') next = flat[0];
        else if (e.key === 'End') next = flat[flat.length - 1];
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t); return; }
        else return;
        e.preventDefault();
        if (next) focusTile(next.key);
    };

    const onSearchKey = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); focusTile(flat[0]?.key); }
        else if (e.key === 'Enter') { e.preventDefault(); if (flat[0]) pick(flat[0]); }
    };

    const jumpTo = (id: string) => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-sticker-section="${CSS.escape(id)}"]`);
        if (el && scrollRef.current) scrollRef.current.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' });
    };

    const fileRef = useRef<HTMLInputElement>(null);
    const [fileError, setFileError] = useState('');
    const startAdd = async () => { setFileError(''); fileRef.current?.click(); };
    const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const problem = emojiFileProblem(f);
        if (problem) { setFileError(problem); return; }
        setAddFile(f);
    };

    const mineFull = mine.length >= PERSONAL_STICKER_LIBRARY_MAX;
    const firstTileKey = flat[0]?.key ?? null;
    const showIndexLoading = indexState === 'loading' && !allStickersLoadedAt();

    return createPortal(
        <>
            <div
                ref={containerRef}
                role="dialog"
                aria-label="Sticker picker"
                className="cl-sticker-picker flex flex-col overflow-hidden rounded-xl border border-cl-border bg-cl-surface text-cl-text shadow-cl-menu"
                style={style}
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center gap-2 px-3 py-2 border-b border-cl-border">
                    <div className="relative flex-1">
                        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cl-faint" aria-hidden="true" />
                        <input
                            ref={searchRef}
                            type="search"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={onSearchKey}
                            placeholder="Search stickers"
                            aria-label="Search stickers"
                            maxLength={64}
                            className="w-full rounded-lg border border-cl-border bg-cl-deep pl-8 pr-7 py-1.5 text-[13px] text-cl-text placeholder:text-cl-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume"
                        />
                        {query && (
                            <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}
                                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-cl-faint hover:text-cl-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume">
                                <X size={12} />
                            </button>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => void startAdd()}
                        disabled={mineFull}
                        title={mineFull ? `My stickers is full (${PERSONAL_STICKER_LIBRARY_MAX}). Remove one to add another.` : 'Add a sticker to My stickers'}
                        aria-label="Add a sticker to My stickers"
                        className="inline-flex items-center gap-1 rounded-lg border border-cl-border px-2 py-1.5 text-[12px] text-cl-muted hover:text-cl-text hover:bg-white/5 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume"
                    >
                        <Plus size={14} aria-hidden="true" /> Add
                    </button>
                    <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFilePicked} aria-hidden="true" tabIndex={-1} />
                </div>
                {fileError && <div className="px-3 py-1.5 text-[12px] text-cl-flash-text border-b border-cl-border" role="alert">{fileError}</div>}

                <div className="flex flex-1 min-h-0">
                    <nav aria-label="Sticker sections" className="flex flex-col items-center gap-1 py-2 px-1.5 border-r border-cl-border overflow-y-auto" style={{ width: 48 }}>
                        {sections.map(s => (
                            <button
                                key={s.id}
                                type="button"
                                title={s.title}
                                aria-label={s.title}
                                onClick={() => jumpTo(s.id)}
                                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-cl-muted hover:bg-white/5 hover:text-cl-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume"
                            >
                                {s.icon}
                            </button>
                        ))}
                    </nav>

                    <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-2 pb-2" role="presentation">
                        {sections.map(sec => (
                            <section key={sec.id} data-sticker-section={sec.id} aria-label={sec.title}>
                                <h3 className="sticky top-0 z-10 bg-cl-surface py-1.5 text-[11px] font-semibold uppercase tracking-wide text-cl-faint truncate">{sec.title}</h3>
                                {sec.tiles.length === 0 ? (
                                    <div className="px-1 pb-3 text-[12px] leading-relaxed text-cl-faint">
                                        {sec.empty}
                                        {sec.id === 'mine' && (
                                            <div className="mt-2">
                                                <button type="button" onClick={() => void startAdd()} disabled={mineFull}
                                                    className="inline-flex items-center gap-1 rounded-lg bg-cl-lume px-2.5 py-1 text-[12px] font-semibold text-cl-on-lume hover:bg-cl-lume-hi disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cl-lume">
                                                    <Plus size={13} aria-hidden="true" /> Add a sticker
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div role="grid" aria-label={sec.title} className="grid gap-1 pb-2" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}>
                                        {sec.tiles.map(t => {
                                            const ref = t.pick.kind === 'personal'
                                                ? { source: 'personal' as const, id: t.pick.entry.id, name: t.pick.entry.name }
                                                : { source: 'server' as const, id: t.pick.sticker.sticker_id, name: t.pick.sticker.name, server_id: t.pick.sticker.server_id };
                                            const tabbable = focusKey ? focusKey === t.key : t.key === firstTileKey;
                                            return (
                                                <button
                                                    key={t.key}
                                                    ref={el => { if (el) tileRefs.current.set(t.key, el); else tileRefs.current.delete(t.key); }}
                                                    type="button"
                                                    role="gridcell"
                                                    tabIndex={tabbable ? 0 : -1}
                                                    title={t.hint}
                                                    aria-label={`Send sticker ${t.hint}`}
                                                    onClick={() => pick(t)}
                                                    onFocus={() => setFocusKey(t.key)}
                                                    onKeyDown={e => onGridKey(e, t)}
                                                    className="flex items-center justify-center rounded-lg p-1 hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume"
                                                    style={{ height: TILE }}
                                                >
                                                    <StickerImage
                                                        sticker={ref}
                                                        token={token}
                                                        size={TILE - 12}
                                                        row={t.pick.kind === 'server' ? t.pick.sticker : undefined}
                                                    />
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </section>
                        ))}

                        {showIndexLoading && (
                            <div className="flex items-center gap-2 px-1 py-3 text-[12px] text-cl-faint" role="status">
                                <span className="h-4 w-4 animate-spin rounded-full border-2 border-cl-border border-t-cl-lume" aria-hidden="true" />
                                Loading server stickers…
                            </div>
                        )}
                        {indexState === 'error' && (
                            <div className="flex items-center gap-2 px-1 py-3 text-[12px] text-cl-flash-text" role="alert">
                                Couldn't load server stickers.
                                <button type="button" onClick={() => void loadIndex()}
                                    className="inline-flex items-center gap-1 rounded border border-cl-border px-2 py-0.5 text-cl-text hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume">
                                    <RefreshCw size={12} aria-hidden="true" /> Retry
                                </button>
                            </div>
                        )}
                        {query.trim() && flat.length === 0 && !showIndexLoading && (
                            <div className="flex flex-col items-center gap-2 py-10 text-[13px] text-cl-faint" role="status">
                                <StickerIcon size={22} aria-hidden="true" />
                                No stickers match “{query.trim()}”.
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {addFile && (
                <AddStickerDialog
                    file={addFile}
                    onClose={() => { setAddFile(null); requestAnimationFrame(() => searchRef.current?.focus()); }}
                    overlayStyle={{ zIndex: 10000 }}
                />
            )}
        </>,
        document.body,
    );
};

export default StickerPicker;
