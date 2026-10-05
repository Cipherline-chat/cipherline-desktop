/**
 * GifPicker — two tabs:
 *
 *   KLIPY  — trending + search, requested DIRECTLY from KLIPY by this device
 *            (utils/klipy.ts) and shown straight from KLIPY's CDN. OPT-IN:
 *            until the user turns it on, this tab shows a one-line notice and
 *            makes no request at all. Sending a KLIPY GIF sends a `klipy_gif`
 *            REFERENCE (no bytes uploaded) inside the normal E2EE envelope.
 *   Saved  — the user's library: GIFs imported from files (AES-256-GCM
 *            encrypted on disk, synced, backed up) plus KLIPY GIFs saved as
 *            references (slug + rendition — never the media itself). A saved
 *            KLIPY GIF is displayed by loading it from KLIPY, so it too only
 *            loads for an opted-in user.
 *
 * KLIPY attribution: the search placeholder "Search KLIPY" is REQUIRED by
 * KLIPY's guidelines — keep it verbatim. "Powered by KLIPY" is shown too.
 *
 * Rendered via React portal at document.body (same pattern as
 * EmojiPickerPopover) so it is never clipped by ancestor overflow:hidden.
 */

import React, {
    memo,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Bookmark, Plus, Search, X } from 'lucide-react';
import type { KlipyGifRef } from '@cipherline/shared';
import { useDismissOnOutsideClick } from '../hooks/useDismissOnOutsideClick';
import { useEscape } from '../hooks/useEscape';
import { ClSearch, ClButton } from './cl';
import { GifPlayer } from './GifPlayer';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { useGifLibrarySync } from '../hooks/useGifLibrarySync';
import { useGifSettings } from '../hooks/useGifSettings';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import {
    loadFavorites,
    addFavorite,
    addKlipyFavorite,
    removeFavorite,
    loadGifFile,
    findKlipyFavorite,
    GIF_LIBRARY_CHANGED,
    type FavoriteGif,
} from '../utils/gifStorage';
import { dedupeKlipyRefs, isKlipyRefEntry } from '../utils/gifLibrarySync';
import { trackActivity } from '../utils/freezeLog';
import { acquireDecryptedMedia, peekDecryptedMedia, peekDecryptedMediaBlob, putDecryptedMediaBlob, releaseDecryptedMedia } from '../utils/decryptedMediaCache';

/** Decrypted-media cache key of a saved GIF's preview (ids are per-favorite UUIDs). */
const gifCacheKey = (id: string) => `gif:${id}`;
import {
    fetchKlipyBySlug,
    fetchKlipyTrending,
    isAbort,
    klipyConfigured,
    klipyErrorKind,
    klipyErrorDetail,
    klipyErrorMessage,
    klipyRefOf,
    initialGifTab,
    searchKlipy,
    KLIPY_MAX_QUERY_LENGTH,
    KLIPY_NOT_AVAILABLE_TEXT,
    KLIPY_NOTICE_TEXT,
    KLIPY_SEARCH_DEBOUNCE_MS,
    KLIPY_SEARCH_PLACEHOLDER,
    type KlipyErrorKind,
    type GifPickerTab,
    type KlipyGif,
} from '../utils/klipy';
import { nextGridIndex } from '../utils/gifGridNav';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
    /**
     * Bounding rect of the trigger button, captured at click time in the
     * parent so the measurement is taken before any re-render shifts the layout.
     */
    anchorRect:  DOMRect | null;
    /** A GIF from the user's own files — sent as an encrypted attachment. */
    onGifSelect: (file: File) => void;
    /** A KLIPY GIF — sent as a `klipy_gif` reference, no upload. */
    onKlipySelect: (ref: KlipyGifRef) => void;
    onClose:     () => void;
}

type Tab = GifPickerTab;

type KlipyState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error'; kind: KlipyErrorKind; detail: string }
    | { status: 'ready'; results: KlipyGif[]; page: number; hasNext: boolean; loadingMore: boolean; moreError: boolean };

const COLUMNS = 3;

/** Remembered for the rest of the session so the picker reopens where the
 *  user left it. Deliberately NOT persisted. */
let lastTab: Tab | null = null;

// ── Small hooks ───────────────────────────────────────────────────────────────

function useDebounced<T>(value: T, ms: number): T {
    const [v, setV] = useState(value);
    useEffect(() => {
        const t = setTimeout(() => setV(value), ms);
        return () => clearTimeout(t);
    }, [value, ms]);
    return v;
}

// ── Styles shared by both grids ───────────────────────────────────────────────

const cellStyle: React.CSSProperties = {
    position:     'relative',
    aspectRatio:  '1 / 1',
    borderRadius: 6,
    overflow:     'hidden',
    background:   'rgba(255,255,255,0.04)',
};
const cellBtnStyle: React.CSSProperties = {
    all:        'unset',
    display:    'block',
    width:      '100%',
    height:     '100%',
    cursor:     'pointer',
    position:   'relative',
};
const imgStyle: React.CSSProperties = {
    width:     '100%',
    height:    '100%',
    objectFit: 'cover',
    display:   'block',
};
const fillStyle: React.CSSProperties = { display: 'block', width: '100%', height: '100%' };
const gridStyle: React.CSSProperties = {
    display:             'grid',
    gridTemplateColumns: `repeat(${COLUMNS}, 1fr)`,
    gap:                 4,
};

/** A KLIPY image in a grid cell. Loads from KLIPY's CDN, no referrer; frozen
 *  until hover when autoplay is off or the OS asks for reduced motion. */
const KlipyThumb: React.FC<{ url: string; alt: string; onError: () => void }> = ({ url, alt, onError }) => (
    <GifPlayer
        src={url}
        alt={alt}
        referrerPolicy="no-referrer"
        onError={onError}
        wrapperStyle={fillStyle}
        imgStyle={imgStyle}
    />
);

// ── KLIPY result cell ─────────────────────────────────────────────────────────

interface KlipyCellProps {
    gif: KlipyGif;
    index: number;
    focusable: boolean;
    saved: boolean;
    onSend: (gif: KlipyGif) => void;
    onToggleSave: (gif: KlipyGif) => void;
    onGridKey: (e: React.KeyboardEvent, index: number) => void;
    onFocusIndex: (index: number) => void;
}

const KlipyCell = memo(function KlipyCell({
    gif, index, focusable, saved, onSend, onToggleSave, onGridKey, onFocusIndex,
}: KlipyCellProps) {
    const [failed, setFailed] = useState(false);
    const label = gif.title || 'GIF';
    return (
        <div className={`gif-cell${saved ? ' is-saved' : ''}`} role="gridcell" style={cellStyle}>
            <button
                type="button"
                className="gif-cell-btn"
                data-gif-index={index}
                tabIndex={focusable ? 0 : -1}
                onClick={() => onSend(gif)}
                onKeyDown={e => onGridKey(e, index)}
                onFocus={() => onFocusIndex(index)}
                aria-label={`Send ${label}`}
                aria-keyshortcuts="S"
                title={`${label} — Enter to send, S to ${saved ? 'unsave' : 'save'}`}
                style={cellBtnStyle}
            >
                {!failed ? (
                    <KlipyThumb url={gif.preview.url} alt={label} onError={() => setFailed(true)} />
                ) : gif.placeholder ? (
                    <img src={gif.placeholder} alt="" aria-hidden style={{ ...imgStyle, filter: 'blur(6px)', transform: 'scale(1.1)' }} draggable={false} />
                ) : (
                    <span className="gif-skel gif-skel--still" aria-hidden />
                )}
            </button>
            <button
                type="button"
                className="gif-bookmark-btn gif-save-btn"
                tabIndex={-1}
                onClick={e => { e.stopPropagation(); onToggleSave(gif); }}
                aria-pressed={saved}
                title={saved ? 'Remove from favorites' : 'Add to favorites'}
                aria-label={saved ? 'Remove from favorites' : 'Add to favorites'}
            >
                <Bookmark style={{ width: 12, height: 12, fill: saved ? 'currentColor' : 'none' }} />
            </button>
        </div>
    );
});

// ── Saved KLIPY reference cell content ────────────────────────────────────────

/**
 * A saved KLIPY GIF in the Saved grid. Shown by loading its stored URL from
 * KLIPY; if that stops working, re-resolve the slug through KLIPY's Items API
 * once (in memory only — the stored reference is not rewritten). Not opted in
 * → a still tile, nothing requested.
 */
const SavedKlipyThumb: React.FC<{ fav: FavoriteGif; enabled: boolean; online: boolean }> = ({ fav, enabled, online }) => {
    const ref = fav.klipy!;
    const [url, setUrl] = useState(ref.media.url);
    const [state, setState] = useState<'ok' | 'refetching' | 'gone'>('ok');

    const onError = useCallback(() => {
        if (state !== 'ok' || !online) { setState('gone'); return; }
        setState('refetching');
        fetchKlipyBySlug(ref.slug)
            .then(g => {
                if (g && g.preview.url !== url) { setUrl(g.preview.url); setState('ok'); }
                else setState('gone');
            })
            .catch(() => setState('gone'));
    }, [state, online, ref.slug, url]);

    if (!enabled || state === 'gone') {
        return (
            <span className="gif-ref-tile" aria-hidden>
                <span className="gif-ref-badge">KLIPY</span>
                <span className="gif-ref-title">{state === 'gone' ? 'Unavailable' : (ref.title || 'GIF')}</span>
            </span>
        );
    }
    if (state === 'refetching') return <span className="gif-skel" aria-hidden />;
    return <KlipyThumb url={url} alt={ref.title || 'GIF'} onError={onError} />;
};

// ── Saved local GIF cell content ──────────────────────────────────────────────

/** At most this many saved-GIF file reads + decrypts at once. */
const SAVED_DECRYPT_CONCURRENCY = 4;
let savedDecryptActive = 0;
const savedDecryptQueue: Array<() => void> = [];
function acquireSavedDecryptSlot(): Promise<() => void> {
    return new Promise(resolve => {
        const grant = () => {
            savedDecryptActive++;
            let done = false;
            resolve(() => {
                if (done) return;
                done = true;
                savedDecryptActive--;
                savedDecryptQueue.shift()?.();
            });
        };
        if (savedDecryptActive < SAVED_DECRYPT_CONCURRENCY) grant();
        else savedDecryptQueue.push(grant);
    });
}

/**
 * A GIF saved from the user's own files: encrypted on disk, so it has to be
 * read and decrypted before it can show. Done when the tile comes within a
 * screen of the visible grid (not for the whole library up front), four at a
 * time. The decrypted URL lives in the shared decrypted-media cache (key
 * `gif:<id>`): held while the tile is mounted, kept warm in the bounded LRU
 * after the picker closes so re-opening it paints instantly with no file read
 * and no decrypt, and revoked when the cache evicts it or on sign-out.
 */
export const SavedLocalThumb = memo(function SavedLocalThumb({ fav }: { fav: FavoriteGif }) {
    const holderRef = useRef<HTMLSpanElement>(null);
    const favId = fav.id;
    const favFile = fav.fileName;
    // Already decrypted earlier this session: no need to wait for the viewport.
    const [near, setNear] = useState(() => peekDecryptedMedia(gifCacheKey(favId)) !== null);
    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
        if (near) return;
        const el = holderRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') { setNear(true); return; }
        // The grid's own scroller is the root, so the margin means "within
        // ~2 rows of what the grid shows", not of the window.
        const root = el.closest<HTMLElement>('[data-gif-scroll]');
        const io = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) { io.disconnect(); setNear(true); }
        }, { root, rootMargin: '240px 0px' });
        io.observe(el);
        return () => io.disconnect();
    }, [near, favId]);
    useEffect(() => {
        if (!near) return;
        let cancelled = false;
        let held = false;
        const key = gifCacheKey(favId);
        (async () => {
            const hit = acquireDecryptedMedia(key);
            if (hit) { held = true; setUrl(hit); return; }
            const release = await acquireSavedDecryptSlot();
            try {
                if (cancelled) return;
                // Another tile / an earlier open may have finished it while queued.
                const again = acquireDecryptedMedia(key);
                if (again) { held = true; setUrl(again); return; }
                const blob = await trackActivity('gif:decrypt', () => loadGifFile(fav));
                const made = putDecryptedMediaBlob(key, blob);
                // Unmounted while decrypting: leave it warm in the cache, unheld.
                if (cancelled) { releaseDecryptedMedia(key); return; }
                held = true;
                setUrl(made);
            } catch { /* broken entry — stays a skeleton, as before */ }
            finally { release(); }
        })();
        return () => {
            cancelled = true;
            if (held) releaseDecryptedMedia(key);
        };
        // Keyed on the file, not the object: a library reload hands us new
        // objects for the same GIF and must not re-decrypt it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [near, favId, favFile]);
    return url
        ? <img src={url} alt={fav.label ?? 'GIF'} style={imgStyle} decoding="async" draggable={false} />
        : <span ref={holderRef} className="gif-skel" aria-hidden />;
});

// ── Component ─────────────────────────────────────────────────────────────────

const GifPicker: React.FC<Props> = ({ anchorRect, onGifSelect, onKlipySelect, onClose }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollRef    = useRef<HTMLDivElement>(null);
    const searchRef    = useRef<HTMLInputElement>(null);
    const sentinelRef  = useRef<HTMLDivElement>(null);
    const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({
        opacity: 0, pointerEvents: 'none',
    });

    const toast = useToast();
    const { userId, deviceId, token } = useAuth();
    const { syncing, syncNow } = useGifLibrarySync({ userId, deviceId, token });
    const { settings: { klipyEnabled, klipyNoticeDismissed }, setKlipyEnabled, dismissKlipyNotice } = useGifSettings();
    const online = useNetworkStatus();
    const configured = useMemo(() => klipyConfigured(), []);

    const [tab, setTab] = useState<Tab>(() => initialGifTab({
        configured, enabled: klipyEnabled, noticeDismissed: klipyNoticeDismissed, last: lastTab,
    }));
    useEffect(() => { lastTab = tab; }, [tab]);

    const [queries, setQueries] = useState<Record<Tab, string>>({ klipy: '', saved: '' });
    const search = queries[tab];
    const setSearch = (v: string) => setQueries(q => ({ ...q, [tab]: v }));

    // ── Saved library state ──────────────────────────────────────────────
    const [gifs, setGifs]         = useState<FavoriteGif[]>([]);
    const [loading, setLoading]   = useState(false);
    const [removing, setRemoving] = useState<string | null>(null);

    // ── KLIPY state ──────────────────────────────────────────────────────
    const [klipy, setKlipy] = useState<KlipyState>({ status: 'idle' });
    const [focusIndex, setFocusIndex] = useState(0);
    const reqSeq  = useRef(0);
    const abortRef = useRef<AbortController | null>(null);
    const debouncedQuery = useDebounced(queries.klipy.trim(), KLIPY_SEARCH_DEBOUNCE_MS);

    // ── Position above anchor using the rect captured at click time ───────
    useLayoutEffect(() => {
        if (!anchorRect) return;
        setPopoverStyle({
            position:      'fixed',
            bottom:        window.innerHeight - anchorRect.top + 8,
            right:         window.innerWidth  - anchorRect.right,
            zIndex:        9999,
            opacity:       1,
            pointerEvents: 'auto',
        });
    }, [anchorRect]);

    // ── Close on outside click — and consume the click so it doesn't fire
    // through to the chat row's save toggle behind us.
    useDismissOnOutsideClick(containerRef, true, onClose);
    useEscape(onClose);

    // ── Saved: load GIFs and decrypt thumbnails (local files only — a KLIPY
    // reference has no file and is shown from KLIPY instead) ─────────────
    const reload = useCallback(() => {
        // PERF: this used to read AND decrypt every saved GIF file (often
        // MBs each) on every open, all in parallel, before any of them could
        // show. Each tile now decrypts itself when it scrolls near the
        // viewport (SavedLocalThumb), a few at a time.
        // One tile per KLIPY slug: the same GIF saved on two devices syncs as
        // two entries (gifLibrarySync.dedupeKlipyRefs).
        setGifs(dedupeKlipyRefs(loadFavorites()));
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    // Opening the picker is the sync trigger — the library is multi-MB and is
    // only ever looked at from here, so there is no background poller.
    useEffect(() => { syncNow(); }, [syncNow]);

    useEffect(() => {
        const onChange = () => { void reload(); };
        window.addEventListener(GIF_LIBRARY_CHANGED, onChange);
        return () => window.removeEventListener(GIF_LIBRARY_CHANGED, onChange);
    }, [reload]);

    // ── KLIPY: fetch a page ──────────────────────────────────────────────
    // The ONLY condition under which the picker talks to KLIPY. The client
    // module re-checks the opt-in and the key before any request, too.
    const klipyActive = tab === 'klipy' && configured && klipyEnabled;

    const loadKlipy = useCallback(async (q: string, page: number) => {
        abortRef.current?.abort();
        const ac = new AbortController();
        abortRef.current = ac;
        const seq = ++reqSeq.current;
        if (page === 1) setKlipy({ status: 'loading' });
        else setKlipy(s => (s.status === 'ready' ? { ...s, loadingMore: true, moreError: false } : s));
        try {
            const res = q ? await searchKlipy(q, page, ac.signal) : await fetchKlipyTrending(page, ac.signal);
            if (seq !== reqSeq.current) return;
            setKlipy(s => {
                const prev = page > 1 && s.status === 'ready' ? s.results : [];
                const seen = new Set(prev.map(g => g.slug));
                return {
                    status: 'ready',
                    results: [...prev, ...res.results.filter(g => !seen.has(g.slug))],
                    page: res.page,
                    hasNext: res.hasNext,
                    loadingMore: false,
                    moreError: false,
                };
            });
            if (page === 1) { setFocusIndex(0); scrollRef.current?.scrollTo({ top: 0 }); }
        } catch (err) {
            if (isAbort(err) || seq !== reqSeq.current) return;
            const kind = klipyErrorKind(err);
            if (page === 1) setKlipy({ status: 'error', kind, detail: klipyErrorDetail(err) });
            else setKlipy(s => (s.status === 'ready' ? { ...s, loadingMore: false, moreError: true } : s));
        }
    }, []);

    // New query (debounced) / tab switch / opting in / back online → page 1.
    useEffect(() => {
        if (!klipyActive || !online) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-change: the loading state must flip before the request starts
        void loadKlipy(debouncedQuery, 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [klipyActive, online, debouncedQuery]);

    useEffect(() => () => abortRef.current?.abort(), []);

    const klipyPage = klipy.status === 'ready' ? klipy.page : 0;
    const retryMore = useCallback(() => { void loadKlipy(debouncedQuery, klipyPage + 1); }, [loadKlipy, debouncedQuery, klipyPage]);

    // Infinite scroll: load the next page when the sentinel scrolls into view.
    const canLoadMore = klipy.status === 'ready' && klipy.hasNext && !klipy.loadingMore && !klipy.moreError;
    useEffect(() => {
        if (!klipyActive || !canLoadMore) return;
        const el = sentinelRef.current;
        if (!el || typeof IntersectionObserver === 'undefined') return;
        const io = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting) && klipy.status === 'ready') {
                io.disconnect();
                void loadKlipy(debouncedQuery, klipy.page + 1);
            }
        }, { root: scrollRef.current, rootMargin: '200px 0px' });
        io.observe(el);
        return () => io.disconnect();
    }, [klipyActive, canLoadMore, klipy, debouncedQuery, loadKlipy]);

    // ── Saved: import / remove / send ─────────────────────────────────────
    const handleImport = async () => {
        const result = await (window as any).electronAPI.showOpenDialog({
            title:      'Add GIF',
            filters:    [{ name: 'GIF Images', extensions: ['gif'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths?.length) return;
        setLoading(true);
        try {
            const ab    = await (window as any).electronAPI.readFile(result.filePaths[0]) as ArrayBuffer;
            const blob  = new Blob([ab], { type: 'image/gif' });
            const label = (result.filePaths[0] as string).split(/[\\/]/).pop() ?? 'animation.gif';
            await addFavorite(blob, 'local', { label });
            await reload();
        } catch (err) {
            console.error('[GifPicker] import failed', err);
            toast.push({ kind: 'error', title: 'Import Failed', message: 'Could not add that GIF.' });
        } finally {
            setLoading(false);
        }
    };

    const handleRemove = async (e: React.SyntheticEvent, id: string) => {
        e.stopPropagation();
        setRemoving(id);
        try {
            await removeFavorite(id);
            await reload();
        } finally {
            setRemoving(null);
        }
    };

    const handleSelectSaved = async (fav: FavoriteGif) => {
        // A saved KLIPY GIF is re-sent as the same reference — no bytes.
        if (isKlipyRefEntry(fav)) { onKlipySelect(fav.klipy); return; }
        try {
            // The preview already holds the decrypted GIF — don't read and
            // decrypt the file a second time just to send it.
            const blob = peekDecryptedMediaBlob(gifCacheKey(fav.id)) ?? await loadGifFile(fav);
            const name = fav.label ?? 'animation.gif';
            onGifSelect(new File([blob], name, { type: fav.mimeType }));
        } catch (err) {
            console.error('[GifPicker] select failed', err);
            toast.push({ kind: 'error', title: 'GIF Error', message: 'Could not load that GIF. It may be missing or corrupted.' });
        }
    };

    // ── KLIPY: send / save ────────────────────────────────────────────────
    const savedSlugs = useMemo(() => {
        const s = new Set<string>();
        for (const g of gifs) if (isKlipyRefEntry(g)) s.add(g.klipy.slug);
        return s;
    }, [gifs]);

    const handleSendKlipy = useCallback((gif: KlipyGif) => {
        // A reference goes on the wire; recipients load it from KLIPY
        // themselves (if they have opted in). Nothing is downloaded here.
        onKlipySelect(klipyRefOf(gif));
    }, [onKlipySelect]);

    const handleToggleSaveKlipy = useCallback(async (gif: KlipyGif) => {
        const existing = findKlipyFavorite(gifs, gif.slug);
        try {
            if (existing) {
                await removeFavorite(existing.id);
            } else {
                // Reference only: slug + rendition. No media bytes are stored.
                addKlipyFavorite(klipyRefOf(gif));
            }
            await reload();
        } catch (err) {
            console.error('[GifPicker] KLIPY save failed', (err as Error)?.message);
            toast.push({ kind: 'error', title: existing ? "Couldn't remove favorite" : "Couldn't favorite GIF", message: 'Please try again.' });
        }
    }, [gifs, reload, toast]);

    // ── Keyboard ──────────────────────────────────────────────────────────
    const savedFiltered = useMemo(() => {
        const q = queries.saved.trim().toLowerCase();
        return q ? gifs.filter(g => (g.label ?? g.fileName).toLowerCase().includes(q)) : gifs;
    }, [gifs, queries.saved]);

    const itemCount = tab === 'klipy'
        ? (klipyActive && klipy.status === 'ready' ? klipy.results.length : 0)
        : savedFiltered.length;

    const focusCell = useCallback((i: number) => {
        const el = scrollRef.current?.querySelector<HTMLElement>(`[data-gif-index="${i}"]`);
        el?.focus();
        el?.scrollIntoView({ block: 'nearest' });
    }, []);

    const onGridKey = useCallback((e: React.KeyboardEvent, index: number) => {
        if (tab === 'klipy' && (e.key === 's' || e.key === 'S') && klipy.status === 'ready') {
            e.preventDefault();
            const gif = klipy.results[index];
            if (gif) void handleToggleSaveKlipy(gif);
            return;
        }
        if (tab === 'saved' && (e.key === 'Delete' || e.key === 'Backspace')) {
            const g = savedFiltered[index];
            if (g) { e.preventDefault(); void handleRemove(e, g.id); }
            return;
        }
        const next = nextGridIndex(index, e.key, itemCount, COLUMNS);
        if (next === null) return;
        e.preventDefault();
        if (next === 'search') { searchRef.current?.focus(); return; }
        setFocusIndex(next);
        focusCell(next);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tab, klipy, savedFiltered, itemCount, focusCell, handleToggleSaveKlipy]);

    const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' && itemCount > 0) {
            e.preventDefault();
            const i = Math.min(focusIndex, itemCount - 1);
            setFocusIndex(i);
            focusCell(i);
        } else if (e.key === 'Enter' && itemCount > 0) {
            // Enter in the box sends the first result, like Discord/Slack —
            // only once the results on screen belong to what's typed.
            e.preventDefault();
            const settled = queries.klipy.trim() === debouncedQuery;
            if (tab === 'klipy' && settled && klipy.status === 'ready') handleSendKlipy(klipy.results[0]);
            else if (tab === 'saved') void handleSelectSaved(savedFiltered[0]);
        }
    };

    const switchTab = (t: Tab) => {
        if (t === tab) return;
        setTab(t);
        setFocusIndex(0);
        scrollRef.current?.scrollTo({ top: 0 });
        requestAnimationFrame(() => searchRef.current?.focus());
    };

    const handleTurnOn = () => {
        setKlipyEnabled(true);
        requestAnimationFrame(() => searchRef.current?.focus());
    };
    const handleNotNow = () => {
        dismissKlipyNotice();
        switchTab('saved');
    };

    const onTabKey = (e: React.KeyboardEvent) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            switchTab(tab === 'klipy' ? 'saved' : 'klipy');
            requestAnimationFrame(() => {
                containerRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
            });
        }
    };

    // ── Render helpers ────────────────────────────────────────────────────
    const renderMessage = (icon: string, text: React.ReactNode, action?: React.ReactNode) => (
        <div className="gif-msg" role="status">
            <span style={{ fontSize: 30 }} aria-hidden>{icon}</span>
            <span style={{ fontSize: 13, lineHeight: 1.5 }}>{text}</span>
            {action}
        </div>
    );

    const retryButton = (
        <ClButton variant="ghost" size="sm" className="gif-import-btn" onClick={() => void loadKlipy(debouncedQuery, 1)}>
            Try again
        </ClButton>
    );
    const toSavedButton = (
        <ClButton variant="ghost" size="sm" className="gif-import-btn" onClick={() => switchTab('saved')}>
            Show favorites
        </ClButton>
    );

    const renderKlipy = () => {
        if (!configured) return renderMessage('🎞️', KLIPY_NOT_AVAILABLE_TEXT, toSavedButton);
        if (!klipyEnabled) {
            // The opt-in. Nothing has been sent to KLIPY at this point.
            return (
                <div className="gif-msg gif-optin" role="region" aria-label="Turn on GIF search">
                    <span style={{ fontSize: 13, lineHeight: 1.5, color: 'rgba(255,255,255,0.7)' }}>{KLIPY_NOTICE_TEXT}</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <ClButton variant="primary" size="sm" onClick={handleTurnOn}>
                            Turn on
                        </ClButton>
                        <ClButton variant="ghost" size="sm" className="gif-import-btn" onClick={handleNotNow}>
                            Not now
                        </ClButton>
                    </div>
                </div>
            );
        }
        if (!online) return renderMessage('📡', klipyErrorMessage('offline'), toSavedButton);
        if (klipy.status === 'error') {
            return renderMessage('⚠️', (
                <>
                    {klipyErrorMessage(klipy.kind)}
                    <span style={{ display: 'block', marginTop: 4, fontSize: 11, opacity: 0.6 }} data-testid="klipy-error-detail">
                        {klipy.detail}
                    </span>
                </>
            ), retryButton);
        }
        if (klipy.status === 'idle' || klipy.status === 'loading') {
            return (
                <div style={gridStyle} aria-busy="true" aria-label="Loading GIFs">
                    {Array.from({ length: 12 }, (_, i) => (
                        <div key={i} style={cellStyle}><span className="gif-skel" /></div>
                    ))}
                </div>
            );
        }
        if (klipy.results.length === 0) {
            return debouncedQuery
                ? renderMessage('🔍', <>No GIFs found for “{debouncedQuery}”</>)
                : renderMessage('🎞️', 'Nothing trending right now.', retryButton);
        }
        return (
            <>
                <div style={gridStyle} role="grid" aria-label={debouncedQuery ? `KLIPY results for ${debouncedQuery}` : 'Trending on KLIPY'}>
                    {klipy.results.map((gif, i) => (
                        <KlipyCell
                            key={gif.slug}
                            gif={gif}
                            index={i}
                            focusable={i === Math.min(focusIndex, klipy.results.length - 1)}
                            saved={savedSlugs.has(gif.slug)}
                            onSend={handleSendKlipy}
                            onToggleSave={handleToggleSaveKlipy}
                            onGridKey={onGridKey}
                            onFocusIndex={setFocusIndex}
                        />
                    ))}
                </div>
                <div ref={sentinelRef} style={{ height: 1 }} />
                {klipy.loadingMore && <div className="gif-more"><span className="gif-spinner gif-spinner--sm" /> Loading more…</div>}
                {klipy.moreError && (
                    <div className="gif-more">
                        Couldn’t load more.{' '}
                        <button type="button" className="gif-link" onClick={retryMore}>Retry</button>
                    </div>
                )}
            </>
        );
    };

    const renderSaved = () => {
        if (savedFiltered.length === 0) {
            return search
                ? renderMessage('🔍', <>No favorites match “{search}”</>)
                : renderMessage('🎞️', <>No favorite GIFs yet.<br />Click <strong style={{ color: 'rgba(255,255,255,0.4)' }}>+</strong> to add a GIF from your device{configured ? ', or favorite one from KLIPY' : ''}.</>);
        }
        return (
            <div style={gridStyle} role="grid" aria-label="Your favorite GIFs">
                {savedFiltered.map((gif, i) => {
                    const isRef = isKlipyRefEntry(gif);
                    return (
                        <div key={gif.id} className="gif-cell" role="gridcell" style={cellStyle}>
                            <button
                                type="button"
                                className="gif-cell-btn"
                                data-gif-index={i}
                                tabIndex={i === Math.min(focusIndex, savedFiltered.length - 1) ? 0 : -1}
                                onClick={() => handleSelectSaved(gif)}
                                onKeyDown={e => onGridKey(e, i)}
                                onFocus={() => setFocusIndex(i)}
                                title={`${gif.label ?? (isRef ? 'KLIPY GIF' : gif.fileName)} — Enter to send, Delete to remove`}
                                aria-label={`Send ${gif.label ?? 'GIF'}${isRef ? ' (from KLIPY)' : ''}`}
                                aria-keyshortcuts="Delete"
                                style={cellBtnStyle}
                            >
                                {isRef ? (
                                    <SavedKlipyThumb fav={gif} enabled={configured && klipyEnabled} online={online} />
                                ) : (
                                    <SavedLocalThumb fav={gif} />
                                )}
                            </button>
                            {/* Bookmark button — filled (already saved); hover reveals
                                it, click removes. Plain <button>, not ClButton —
                                ClButton's `style` prop lands on the outer wrapper span,
                                not the inner .cap that actually renders. Sizing/
                                position live in .gif-bookmark-btn (index.css). */}
                            <button
                                type="button"
                                onClick={e => handleRemove(e, gif.id)}
                                disabled={removing === gif.id}
                                tabIndex={-1}
                                title="Remove from favorites"
                                aria-label="Remove from favorites"
                                className="gif-bookmark-btn gif-remove-btn"
                            >
                                <Bookmark style={{ width: 12, height: 12, fill: 'currentColor' }} />
                            </button>
                        </div>
                    );
                })}
            </div>
        );
    };

    const klipyInputDisabled = tab === 'klipy' && !(configured && klipyEnabled);

    // ── Render ────────────────────────────────────────────────────────────
    return createPortal(
        <div
            ref={containerRef}
            role="dialog"
            aria-label="GIF picker"
            style={{
                ...popoverStyle,
                width:          352,
                height:         400,
                background:     '#1e2024',
                border:         '1px solid rgba(255,255,255,0.08)',
                borderRadius:   12,
                boxShadow:      '0 8px 32px rgba(0,0,0,0.6)',
                display:        'flex',
                flexDirection:  'column',
                overflow:       'hidden',
            }}
            onClick={e => e.stopPropagation()}
        >
            {/* ── Header: tabs, then search (+ import on Saved) ─────────── */}
            <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
                <div role="tablist" aria-label="GIF source" className="gif-tabs" onKeyDown={onTabKey}>
                    {([['klipy', 'KLIPY'], ['saved', `Favorites${gifs.length ? ` · ${gifs.length}` : ''}`]] as const).map(([t, label]) => (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            id={`gif-tab-${t}`}
                            aria-selected={tab === t}
                            aria-controls="gif-tabpanel"
                            tabIndex={tab === t ? 0 : -1}
                            className={`gif-tab${tab === t ? ' on' : ''}`}
                            onClick={() => switchTab(t)}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'stretch', gap: 6, marginTop: 8 }}>
                    <div style={{ position: 'relative', flex: 1 }}>
                        <ClSearch
                            ref={searchRef}
                            icon={<Search style={{ width: 14, height: 14 }} />}
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            onKeyDown={onSearchKey}
                            // "Search KLIPY" is a REQUIRED attribution string per
                            // KLIPY's guidelines — keep it verbatim.
                            placeholder={tab === 'klipy' ? KLIPY_SEARCH_PLACEHOLDER : 'Search your favorites'}
                            maxLength={tab === 'klipy' ? KLIPY_MAX_QUERY_LENGTH : undefined}
                            disabled={klipyInputDisabled}
                            aria-label={tab === 'klipy' ? KLIPY_SEARCH_PLACEHOLDER : 'Search your favorites'}
                            autoFocus
                            className="gif-search-input"
                        />
                        {search && (
                            <ClButton
                                icon
                                variant="ghost"
                                size="sm"
                                onClick={() => { setSearch(''); searchRef.current?.focus(); }}
                                aria-label="Clear search"
                                className="gif-clear-btn"
                                style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)' }}
                            >
                                <X style={{ width: 12, height: 12 }} />
                            </ClButton>
                        )}
                    </div>
                    {tab === 'saved' && (
                        <ClButton
                            icon
                            variant="ghost"
                            size="sm"
                            onClick={handleImport}
                            disabled={loading}
                            loading={loading}
                            tooltip="Add GIF from file"
                            className="gif-import-btn"
                            style={{ flexShrink: 0 }}
                        >
                            <Plus style={{ width: 15, height: 15 }} />
                        </ClButton>
                    )}
                </div>
            </div>

            {/* ── Grid ─────────────────────────────────────────────────── */}
            <div
                ref={scrollRef}
                data-gif-scroll
                id="gif-tabpanel"
                role="tabpanel"
                aria-labelledby={`gif-tab-${tab}`}
                style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 8, minHeight: 0 }}
            >
                {tab === 'klipy' ? renderKlipy() : renderSaved()}
            </div>

            {/* ── Footer ───────────────────────────────────────────────── */}
            <div className="gif-footer">
                {tab === 'klipy'
                    ? <>Powered by <strong>KLIPY</strong></>
                    : <>{gifs.length} GIF{gifs.length !== 1 ? 's' : ''} · encrypted on your device{syncing ? ' · syncing…' : ''}</>}
            </div>

            {/* Local styles — portal content can't use Tailwind here. */}
            <style>{`
                .gif-cell:hover { background: rgba(255,255,255,0.09) !important; }
                .gif-cell-btn:focus-visible { outline: 2px solid rgba(37,224,200,0.9); outline-offset: -2px; border-radius: 6px; }
                .gif-cell:focus-within .gif-bookmark-btn { opacity: 1; }
                .gif-remove-btn:hover { background: rgba(220,38,38,0.75) !important; }
                .gif-save-btn:hover { background: rgba(37,224,200,0.75) !important; color: #0b0d10; }
                .gif-cell.is-saved .gif-save-btn { opacity: 1; background: rgba(37,224,200,0.85); color: #0b0d10; }
                .gif-cell.is-saved .gif-save-btn:hover { background: rgba(220,38,38,0.75) !important; color: #fff; }
                /* The kit's .inp is navy (--surface); this popover is neutral
                   gray (#1e2024), so the search field matches it instead of
                   standing out as a blue bar. Focus stays neutral too. */
                .gif-search-input.inp {
                    background: rgba(255,255,255,0.06) !important;
                    border-color: rgba(255,255,255,0.10) !important;
                }
                .gif-search-input.inp:focus {
                    background: rgba(255,255,255,0.08) !important;
                    border-color: rgba(255,255,255,0.32) !important;
                    box-shadow: 0 0 0 3px rgba(255,255,255,0.07) !important;
                    animation: none !important;
                }
                .srch:focus-within > svg { stroke: rgba(255,255,255,0.7) !important; }
                /* ClButton's ghost variant defaults to --surface/--border
                   (navy), tuned for the app's navy chrome. This popover is a
                   neutral gray (#1e2024), so match the search input's own
                   rgba-white resting/hover treatment instead. */
                /* The search field's clear (X) button: the kit's ghost button is
                   navy/teal; here it's a quiet gray to match the neutral field. */
                .gif-clear-btn .cap {
                    background-color: transparent !important;
                    box-shadow: none !important;
                    color: rgba(255,255,255,0.5) !important;
                }
                .gif-clear-btn .cap svg { stroke: currentColor !important; }
                .gif-clear-btn .cap:hover {
                    background-color: rgba(255,255,255,0.10) !important;
                    color: rgba(255,255,255,0.85) !important;
                }
                .gif-import-btn .cap {
                    background-color: rgba(255,255,255,0.07) !important;
                    box-shadow: inset 0 0 0 1.5px rgba(255,255,255,0.10) !important;
                }
                .gif-import-btn .cap:hover {
                    box-shadow: inset 0 0 0 1.5px rgba(37,224,200,0.65) !important;
                }
                .gif-tabs { display: flex; gap: 4px; }
                .gif-tab {
                    all: unset; cursor: pointer;
                    padding: 4px 10px; border-radius: 6px;
                    font-size: 12px; font-weight: 700; letter-spacing: 0.01em;
                    color: rgba(255,255,255,0.45);
                }
                .gif-tab:hover { color: rgba(255,255,255,0.75); background: rgba(255,255,255,0.05); }
                .gif-tab.on { color: #fff; background: rgba(255,255,255,0.09); }
                .gif-tab:focus-visible { outline: 2px solid rgba(37,224,200,0.9); outline-offset: 1px; }
                .gif-msg {
                    display: flex; flex-direction: column; align-items: center; justify-content: center;
                    height: 100%; gap: 12px; padding: 0 24px; text-align: center;
                    color: rgba(255,255,255,0.35);
                }
                .gif-skel {
                    display: block; width: 100%; height: 100%;
                    background: linear-gradient(90deg, rgba(255,255,255,0.03), rgba(255,255,255,0.08), rgba(255,255,255,0.03));
                    background-size: 200% 100%;
                    animation: gif-shimmer 1.2s ease-in-out infinite;
                }
                .gif-skel--still { animation: none; }
                .gif-ref-tile {
                    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
                    width: 100%; height: 100%; padding: 6px; box-sizing: border-box;
                    color: rgba(255,255,255,0.45); font-size: 10.5px; text-align: center;
                }
                .gif-ref-badge {
                    font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em;
                    padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.08);
                }
                .gif-ref-title { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                @keyframes gif-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
                .gif-spinner {
                    width: 20px; height: 20px; border-radius: 50%;
                    border: 2px solid rgba(255,255,255,0.25); border-top-color: #fff;
                    animation: spin 0.8s linear infinite; display: inline-block;
                }
                .gif-spinner--sm { width: 11px; height: 11px; border-width: 1.5px; }
                .gif-more {
                    display: flex; align-items: center; justify-content: center; gap: 6px;
                    padding: 8px 0 2px; font-size: 11.5px; color: rgba(255,255,255,0.35);
                }
                .gif-link { all: unset; cursor: pointer; color: rgba(37,224,200,0.9); text-decoration: underline; }
                .gif-footer {
                    flex-shrink: 0; border-top: 1px solid rgba(255,255,255,0.07);
                    padding: 5px 12px; font-size: 11px; color: rgba(255,255,255,0.25);
                    text-align: center; user-select: none;
                }
                .gif-footer strong { color: rgba(255,255,255,0.45); font-weight: 800; letter-spacing: 0.02em; }
                @media (prefers-reduced-motion: reduce) {
                    .gif-skel, .gif-spinner { animation: none; }
                }
                @keyframes spin { to { transform: rotate(360deg); } }
            `}</style>
        </div>,
        document.body,
    );
};

export default GifPicker;
