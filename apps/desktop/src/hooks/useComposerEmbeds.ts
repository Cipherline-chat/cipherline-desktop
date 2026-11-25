/**
 * Link previews for the message being written (docs/plans/embeds.md §5,
 * phase 3).
 *
 * While "Generate link previews" is on (Settings → Privacy), each previewable
 * link in the composer (utils/linkEmbeds/prepare.ts previewableUrls: the
 * reader's own embed rules, https only, at most five) starts building a
 * preview once typing pauses (DEBOUNCE_MS). The previews show above the
 * composer with an × to drop each one (ComposerEmbedPreviews.tsx).
 *
 * PAGE SNAPSHOTS (2026-11-23, page-snapshots) and FRAME GRABS (2026-11-24,
 * embeds-always-thumb): a preview with no usable picture of its own comes back
 * `snapshot: 'pending'` with the designed picture; it is ready at once and a
 * better picture is made next (prepare.ts completePicture: a frame of its
 * video, else a snapshot of its page → main's page-snapshot.ts, one at a
 * time). When it arrives the preview gets it as its picture. A snapshot is CANCELLED as soon as nobody
 * wants it any more: its link left every composer's draft (deleted, or × on
 * its preview) and no sent message is waiting for it.
 *
 * At send, `take(deadlineMs)` hands back the ready previews in link order,
 * waiting for ones still building only until the deadline: a slow site is
 * sent with the MINIMAL card (its site; prepare.ts minimalPrepared) instead of
 * its preview (sending never waits more than ~1.5 s). A preview that was not
 * ready, or whose snapshot was still coming, is marked `late`: the message is
 * sent without it and the chat attaches it afterwards with an embeds-only
 * edit (awaitFinalPreview + utils/linkEmbeds/lateAttach.ts). `reset()` clears
 * the dismissals for the next message.
 *
 * A built preview is kept for the session per URL (bounded), so editing a
 * message, or typing around a link, never rebuilds what is already here.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cancelFrameGrab, completePicture, minimalPrepared, prepareLinkEmbed, previewableUrls, type PreparedEmbed } from '../utils/linkEmbeds/prepare';

export const DEBOUNCE_MS = 450;
export const SEND_DEADLINE_MS = 1500;
/** A late preview is held (not cancelled) this long after the send that wanted it. */
export const LATE_HOLD_MS = 15_000;
const CACHE_MAX = 32;

interface Upgrade { token: string; promise: Promise<PreparedEmbed>; cancelled?: boolean }
type Entry =
    | { status: 'loading'; promise: Promise<PreparedEmbed | null> }
    | { status: 'ready'; prepared: PreparedEmbed; previewUrl: string | null; upgrade?: Upgrade }
    | { status: 'none' };

// Session cache, shared by every composer (switching chats keeps what was built).
const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

// Who still wants a link's snapshot: the composers that have it in their
// draft (per hook instance), and sent messages waiting to attach it.
const draftHolders = new Map<string, ReadonlySet<string>>();
const lateHolds = new Map<string, number>();

/**
 * The better-picture calls (prepare.ts completePicture: a frame of the video,
 * else a snapshot of the page); swapped in tests.
 */
const snapshotApi = {
    upgrade: (p: PreparedEmbed, token: string) => completePicture(p, token),
    cancel: (token: string): void => {
        cancelFrameGrab(token);
        void window.electronAPI?.cancelPageSnapshot?.(token)?.catch?.(() => {});
    },
    now: () => Date.now(),
};

function isWanted(url: string): boolean {
    const held = lateHolds.get(url);
    if (held !== undefined && held > snapshotApi.now()) return true;
    for (const s of draftHolders.values()) if (s.has(url)) return true;
    return false;
}

const pictureOf = (p: PreparedEmbed | null | undefined) => p?.thumb ?? p?.images?.[0] ?? p?.icon;

function remember(url: string, e: Entry) {
    const old = cache.get(url);
    if (old?.status === 'ready' && old.previewUrl && (e.status !== 'ready' || e.previewUrl !== old.previewUrl)) URL.revokeObjectURL(old.previewUrl);
    cache.delete(url);
    cache.set(url, e);
    while (cache.size > CACHE_MAX) {
        const [k, v] = cache.entries().next().value as [string, Entry];
        if (v.status === 'loading' || (v.status === 'ready' && v.upgrade)) break; // never evict a run in flight
        if (v.status === 'ready' && v.previewUrl) URL.revokeObjectURL(v.previewUrl);
        cache.delete(k);
    }
}

let tokenSeq = 0;
function newToken(): string {
    const r = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2);
    return `snap${(++tokenSeq).toString(36)}${r}`.slice(0, 48);
}

/** Start the snapshot of a ready card that is waiting for one (if anyone still wants it). */
function startUpgrade(url: string) {
    const e = cache.get(url);
    if (e?.status !== 'ready' || e.prepared.snapshot !== 'pending' || e.upgrade || !isWanted(url)) return;
    const token = newToken();
    const base = e.prepared;
    const promise = snapshotApi.upgrade(base, token).catch((): PreparedEmbed => ({ ...base, snapshot: undefined, snapshotResult: 'failed' })).then((up) => {
        const cur = cache.get(url);
        if (cur?.status === 'ready' && cur.upgrade?.token === token) {
            if (up.snapshotResult === 'cancelled') {
                // Still a card waiting for a snapshot: a later draft with this link takes one
                // (or right away, when the link came back while the cancel was on its way).
                remember(url, { status: 'ready', prepared: base, previewUrl: cur.previewUrl });
                startUpgrade(url);
            } else {
                const pic = pictureOf(up);
                remember(url, { status: 'ready', prepared: up, previewUrl: pic ? URL.createObjectURL(pic.blob) : null });
            }
            notify();
        }
        return up;
    });
    remember(url, { ...e, upgrade: { token, promise } });
}

/** Cancel every running / queued snapshot nobody wants any more. */
function cancelUnwanted() {
    for (const [url, e] of cache) {
        if (e.status === 'ready' && e.upgrade && !e.upgrade.cancelled && !isWanted(url)) {
            e.upgrade.cancelled = true;
            snapshotApi.cancel(e.upgrade.token);
        }
    }
}

type Prepare = (url: string) => Promise<PreparedEmbed | null>;

function start(url: string, prepare: Prepare): Promise<PreparedEmbed | null> {
    const hit = cache.get(url);
    if (hit?.status === 'loading') return hit.promise;
    if (hit?.status === 'ready') { startUpgrade(url); return Promise.resolve(hit.prepared); }
    if (hit?.status === 'none') return Promise.resolve(null);
    const promise = prepare(url).catch(() => null).then((p) => {
        // The composer chip's picture: the thumbnail, else a post's first picture, else the author's.
        const pic = pictureOf(p);
        if (p) remember(url, { status: 'ready', prepared: p, previewUrl: pic ? URL.createObjectURL(pic.blob) : null });
        else remember(url, { status: 'none' });
        if (p?.snapshot === 'pending') startUpgrade(url);
        notify();
        return p;
    });
    remember(url, { status: 'loading', promise });
    return promise;
}

function untilAt<T>(p: Promise<T>, at: number): Promise<T | null> {
    return new Promise((ok) => {
        const t = setTimeout(() => ok(null), Math.max(0, at - snapshotApi.now()));
        p.then((v) => { clearTimeout(t); ok(v); }, () => { clearTimeout(t); ok(null); });
    });
}

/**
 * The best preview of `url` this device will have by `deadlineAt` (epoch ms):
 * waits for the page read and then for its snapshot, never past the deadline,
 * and releases the late hold. Null when there is none.
 */
export async function awaitFinalPreview(url: string, deadlineAt: number): Promise<PreparedEmbed | null> {
    try {
        let e = cache.get(url);
        if (e?.status === 'loading') { await untilAt(e.promise, deadlineAt); e = cache.get(url); }
        if (e?.status === 'ready' && e.upgrade) { await untilAt(e.upgrade.promise, deadlineAt); e = cache.get(url); }
        return e?.status === 'ready' ? e.prepared : null;
    } finally {
        lateHolds.delete(url);
        cancelUnwanted();
    }
}

export interface ComposerEmbedItem {
    url: string;
    status: 'loading' | 'ready';
    prepared?: PreparedEmbed;
    previewUrl?: string | null;
    /** A snapshot of the page is being taken for this card. */
    snapshotting?: boolean;
}

export interface ComposerEmbeds {
    items: ComposerEmbedItem[];
    dismiss: (url: string) => void;
    /** The previews to send for `text`, waiting at most `deadlineMs` for ones still building. */
    take: (text: string, deadlineMs?: number) => Promise<PreparedEmbed[]>;
    /** Forget the dismissals (after a send / cancel). */
    reset: () => void;
    /** Was this URL dropped with × for the current message? */
    isDismissed: (url: string) => boolean;
}

export function useComposerEmbeds(text: string, enabled: boolean, prepare: Prepare = prepareLinkEmbed): ComposerEmbeds {
    const [, bump] = useState(0);
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
    const dismissedRef = useRef(dismissed);
    useLayoutEffect(() => { dismissedRef.current = dismissed; }, [dismissed]);
    const urls = useMemo(() => (enabled ? previewableUrls(text) : []), [text, enabled]);
    const [settledUrls, setSettledUrls] = useState<string[]>([]);
    const [holderId] = useState(() => `h${Math.random().toString(36).slice(2)}`);

    useEffect(() => {
        const l = () => bump((n) => n + 1);
        listeners.add(l);
        return () => { listeners.delete(l); };
    }, []);

    // What this composer's draft still wants: a link deleted or dropped with ×
    // cancels its snapshot right away (unless a sent message is waiting for it).
    useEffect(() => {
        draftHolders.set(holderId, new Set(urls.filter((u) => !dismissed.has(u))));
        cancelUnwanted();
    }, [holderId, urls, dismissed]);
    useEffect(() => () => { draftHolders.delete(holderId); cancelUnwanted(); }, [holderId]);

    // Start building once typing pauses (a URL half-typed is not fetched).
    useEffect(() => {
        // (No links: nothing to start. `items` below only lists links still in the text.)
        if (urls.length === 0) return;
        const t = setTimeout(() => {
            setSettledUrls(urls);
            for (const u of urls) if (!dismissedRef.current.has(u)) void start(u, prepare);
            bump((n) => n + 1);
        }, DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [urls, prepare]);

    const items: ComposerEmbedItem[] = [];
    for (const u of settledUrls) {
        if (!urls.includes(u) || dismissed.has(u)) continue;
        const e = cache.get(u);
        if (e?.status === 'loading') items.push({ url: u, status: 'loading' });
        else if (e?.status === 'ready') items.push({ url: u, status: 'ready', prepared: e.prepared, previewUrl: e.previewUrl, ...(e.upgrade ? { snapshotting: true } : {}) });
    }

    const dismiss = useCallback((url: string) => {
        setDismissed((s) => {
            const next = new Set(s).add(url);
            dismissedRef.current = next; // a send right after the × must already skip it
            return next;
        });
    }, []);
    const reset = useCallback(() => { dismissedRef.current = new Set(); setDismissed(new Set()); }, []);
    const isDismissed = useCallback((url: string) => dismissedRef.current.has(url), []);

    const take = useCallback(async (sendText: string, deadlineMs = SEND_DEADLINE_MS): Promise<PreparedEmbed[]> => {
        if (!enabled) return [];
        const wanted = previewableUrls(sendText).filter((u) => !dismissedRef.current.has(u));
        if (wanted.length === 0) return [];
        const timeout = new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(0, deadlineMs)));
        const got = await Promise.all(wanted.map(async (u): Promise<PreparedEmbed | null> => {
            const p = await Promise.race([start(u, prepare), timeout]);
            const e = cache.get(u);
            // What is here NOW (a snapshot may have landed while waiting).
            const now = e?.status === 'ready' ? e.prepared : p;
            const coming = e?.status === 'loading' || (e?.status === 'ready' && e.prepared.snapshot === 'pending');
            const out = now ?? minimalPrepared(u);
            if (!out) return null;
            if (!coming) return out;
            // Keep it going after the composer clears: the message is sent now and gets it by an edit.
            lateHolds.set(u, snapshotApi.now() + LATE_HOLD_MS);
            return { ...out, late: true };
        }));
        return got.filter((p): p is PreparedEmbed => !!p);
    }, [enabled, prepare]);

    return { items, dismiss, take, reset, isDismissed };
}

/** Test seam. */
export function _clearComposerEmbedCache(): void {
    for (const e of cache.values()) if (e.status === 'ready' && e.previewUrl) URL.revokeObjectURL(e.previewUrl);
    cache.clear();
    draftHolders.clear();
    lateHolds.clear();
}

/** Test seam: the snapshot calls and the clock. */
export function _setSnapshotApi(api: Partial<typeof snapshotApi>): void {
    Object.assign(snapshotApi, api);
}
