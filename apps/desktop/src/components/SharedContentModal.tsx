/**
 * SharedContentModal — the browsable viewer behind the context panel's
 * Shared · Media / Files / Links tiles (DMs + group chats).
 *
 * Data source is the conversation's in-memory/retained messages (same list
 * the counts are computed from — nothing new leaves the device). Media and
 * files decrypt lazily per item through the exact ChatPane pipeline: local
 * encrypted-bytes cache first, MinIO fallback (cached on success), then
 * AES-GCM decrypt to an object URL that is revoked on unmount.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    Download, ExternalLink, FileText, ImageIcon as ImageIco, Link as LinkIcon,
    FolderOpen, Play, X, Film, FileAudio, FileArchive, MessageSquare,
} from 'lucide-react';
import { ClModal, ClSegment, ClButton } from './cl';
import { ImageLightbox } from './ImageLightbox';
import { useEscape } from '../hooks/useEscape';
import { importKeyFromBase64, decryptBlob } from '../utils/crypto';
import { openExternalLink } from '../utils/openExternalLink';
import { getEncryptedAttachment, putEncryptedAttachment } from '../utils/attachmentCache';
import { downloadEncryptedAttachment } from '../utils/attachmentDownload';
import { API_BASE } from '../constants';

export type SharedTab = 'media' | 'files' | 'links';

interface SharedContentModalProps {
    open: boolean;
    initialTab: SharedTab;
    onClose: () => void;
    /** The conversation's message list (Dashboard messagesState[convId]). */
    messages: any[];
    token: string | null;
    /** Conversation title for the header. */
    title: string;
    /** Closes the modal and scrolls the chat to the item's original message. */
    onJumpToMessage?: (msgId: string) => void;
    /** Resolve a sender user id to a display name ('You', username, …). */
    resolveSenderName?: (senderUserId: string | null) => string | null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const MEDIA_CAP = 60;
const LIST_CAP = 200;

interface AttachmentItem {
    msgId: string;
    attachmentId: string;
    fileKeyB64: string;
    fileNonceB64: string;
    mime: string;
    filename: string;
    byteSize: number;
    at: number;
    senderId: string | null;
}

interface LinkItem {
    msgId: string;
    url: string;
    at: number;
    senderId: string | null;
}

/** Coarse human label + icon for a mime type (details view). */
function fileKind(mime: string, filename: string): { label: string; icon: React.ReactNode } {
    const ext = (filename.split('.').pop() || '').toUpperCase();
    if (mime.startsWith('audio/')) return { label: ext || 'Audio', icon: <FileAudio size={16} /> };
    if (mime.startsWith('video/')) return { label: ext || 'Video', icon: <Film size={16} /> };
    if (mime.startsWith('image/')) return { label: ext || 'Image', icon: <ImageIco size={16} /> };
    if (/zip|rar|7z|tar|gzip|compressed/.test(mime) || /^(ZIP|RAR|7Z|TAR|GZ)$/.test(ext)) {
        return { label: ext || 'Archive', icon: <FileArchive size={16} /> };
    }
    return { label: ext || 'File', icon: <FileText size={16} /> };
}

function msgTime(m: any): number {
    return new Date(m.sent_at_client || m.timestamp || m.received_at_server || 0).getTime();
}

function fmtBytes(n: number): string {
    if (!n || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDate(t: number): string {
    if (!t) return '';
    const d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

/** Open in the system browser — validated, shared with ChatPane's identical
 *  former copy of this function. See utils/openExternalLink.ts. */
function openUrl(url: string) {
    const result = openExternalLink(url);
    if (!result.ok) {
        console.warn(`[SharedContentModal] refused to open link (${result.reason}):`, url);
    }
}

/** Cache-first decrypt to an object URL. Throws on failure. */
async function decryptToUrl(item: AttachmentItem, token: string | null): Promise<string> {
    let encBlob: Blob | null = await getEncryptedAttachment(item.attachmentId);
    if (!encBlob) {
        encBlob = await downloadEncryptedAttachment(item.attachmentId, token!, API_BASE);
        putEncryptedAttachment(item.attachmentId, encBlob).catch(() => {});
    }
    const key = await importKeyFromBase64(item.fileKeyB64);
    const blob = await decryptBlob(encBlob, key, item.fileNonceB64, item.mime);
    return URL.createObjectURL(blob);
}

/** In-memory poster cache — regenerating a frame on every remount is wasteful. */
const posterCache = new Map<string, string>();

/**
 * Decode one representative frame of a video into a JPEG data URL.
 *
 * An offscreen <video> driven by muted PLAYBACK, not by preload/seek:
 * Chromium defers media loading entirely in several situations (hidden or
 * occluded pages among them) and a bare `preload`/`currentTime` request can
 * sit at readyState 0 forever. A muted play() forces the load pipeline, and
 * capturing from the playing stream a beat in also skips the black frame 0
 * of most screen recordings.
 */
function makeVideoPoster(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        let settled = false;
        // On wall-clock timeout, the brightest frame in hand beats no poster.
        const timeout = setTimeout(() => {
            if (bestShot || lastShot) accept(bestShot ?? lastShot);
            else fail(new Error('poster timeout (media never loaded)'));
        }, 8000);
        const cleanup = () => {
            clearTimeout(timeout);
            try { v.pause(); } catch { /* already dead */ }
            v.removeAttribute('src');
            try { v.load(); } catch { /* detached */ }
        };
        const fail = (e: unknown) => { if (!settled) { settled = true; cleanup(); reject(e); } };
        // Don't trust early frames: clips routinely open on seconds of black
        // (fade-ins, screen recordings, dashcam boots). Playback only forces
        // the load pipeline; the hunt itself SEEKS across the whole clip —
        // near-instant on a local blob — sampling luminance at each stop and
        // keeping the brightest frame seen as the fallback.
        let canvas: HTMLCanvasElement | null = null;
        let ctx: CanvasRenderingContext2D | null = null;
        let lastShot: string | null = null;   // most recent frame
        let bestShot: string | null = null;   // brightest frame so far
        let bestLum = -1;
        const sampleFrame = (): number | null => {
            const w = v.videoWidth, h = v.videoHeight;
            if (!w || !h) return null;
            if (!canvas) {
                const scale = Math.min(1, 320 / Math.max(w, h));
                canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));
                ctx = canvas.getContext('2d', { willReadFrequently: true });
            }
            if (!ctx) return null;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            lastShot = canvas.toDataURL('image/jpeg', 0.72);
            const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const stride = Math.max(1, Math.floor(px.length / 4 / 400)) * 4;
            let max = 0;
            for (let i = 0; i < px.length; i += stride) {
                const lum = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
                if (lum > max) max = lum;
            }
            if (max > bestLum) { bestLum = max; bestShot = lastShot; }
            return max;
        };
        const accept = (shot: string | null) => {
            if (settled || !shot) return;
            settled = true;
            cleanup();
            resolve(shot);
        };
        const BRIGHT = 26; // 0–255 max-luminance floor for "has content"
        // Seek-probe positions across the clip, front-loaded.
        const PROBES = [0.12, 0.25, 0.4, 0.55, 0.7, 0.85];
        let probeIdx = -1;  // -1 = still in the initial playback warm-up
        const nextProbe = () => {
            probeIdx++;
            if (!Number.isFinite(v.duration) || probeIdx >= PROBES.length) {
                // Out of places to look — brightest frame wins, dark or not.
                accept(bestShot ?? lastShot);
                return;
            }
            try { v.currentTime = Math.max(0.1, v.duration * PROBES[probeIdx]); }
            catch { accept(bestShot ?? lastShot); }
        };
        v.onseeked = () => {
            if (settled) return;
            const lum = sampleFrame();
            if (lum !== null && lum > BRIGHT) accept(lastShot);
            else nextProbe();
        };
        v.ontimeupdate = () => {
            if (settled || probeIdx >= 0 || v.readyState < 2) return;
            // Loaded and rendering — grade the live frame, then switch from
            // playback to seek-probing.
            const lum = sampleFrame();
            v.pause();
            if (lum !== null && lum > BRIGHT) accept(lastShot);
            else nextProbe();
        };
        v.onerror = () => fail(v.error ?? new Error('video decode error'));
        v.src = url;
        v.play().catch((e) => {
            // Autoplay rejection (shouldn't happen muted) — seek directly.
            console.warn('[shared] poster play() rejected, probing via seek', e);
            v.onloadeddata = () => { if (!settled && probeIdx < 0) nextProbe(); };
        });
    });
}

// ── Video lightbox — dim overlay with a real player (grid cells are far too
//    small for native controls; clicking a thumbnail opens this instead) ─────

const VideoLightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
    useEscape(onClose);

    return createPortal(
        <div
            className="fade-enter"
            style={{ position: 'fixed', inset: 0, zIndex: 10002, background: 'rgba(5,8,18,.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32 }}
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <video
                src={src}
                controls
                autoPlay
                className="fade-pop-enter"
                style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: 14, outline: 'none', boxShadow: '0 24px 64px rgba(0,0,0,.6)' }}
            />
            <div style={{ position: 'fixed', top: 44, right: 16, zIndex: 10004 }}>
                <ClButton icon variant="ghost" size="sm" onClick={onClose} tooltip="Close">
                    <X size={15} />
                </ClButton>
            </div>
        </div>,
        document.body,
    );
};

// ── Media cell — lazy decrypt; images zoom, videos open the player ──────────

const MediaCell: React.FC<{
    item: AttachmentItem;
    token: string | null;
    onOpenImage: (url: string) => void;
    onOpenVideo: (url: string) => void;
    onJump?: () => void;
}> = ({ item, token, onOpenImage, onOpenVideo, onJump }) => {
    const [url, setUrl] = useState<string | null>(null);
    const [poster, setPoster] = useState<string | null>(() => posterCache.get(item.attachmentId) ?? null);
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);
    const isVideo = item.mime.startsWith('video/');

    useEffect(() => {
        let revoked: string | null = null;
        let cancelled = false;
        decryptToUrl(item, token)
            .then(u => { if (cancelled) { URL.revokeObjectURL(u); return; } revoked = u; setUrl(u); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; if (revoked) URL.revokeObjectURL(revoked); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [item.attachmentId]);

    // Videos: capture one decoded frame offscreen and show it as an image.
    // If the offscreen capture fails, fall back to a visible inline video that
    // plays muted for a couple of frames and pauses — a VISIBLE element always
    // loads and paints, at the cost of a live media element per cell.
    const [posterFailed, setPosterFailed] = useState(false);
    useEffect(() => {
        if (!isVideo || !url || poster) return;
        let cancelled = false;
        makeVideoPoster(url)
            .then(p => {
                posterCache.set(item.attachmentId, p);
                if (!cancelled) setPoster(p);
            })
            .catch((e) => {
                console.warn('[shared] video poster capture failed —', item.filename, e);
                if (!cancelled) setPosterFailed(true);
            });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVideo, url]);

    return (
        <div className="relative group" style={{ aspectRatio: '1 / 1' }}>
            <button
                type="button"
                className="absolute inset-0 w-full h-full rounded-xl overflow-hidden bg-cl-sink border border-cl-border/40 p-0 transition-transform duration-150 group-hover:scale-[1.02] focus-visible:scale-[1.02]"
                style={{ cursor: url ? (isVideo ? 'pointer' : 'zoom-in') : 'default' }}
                onClick={() => { if (!url) return; isVideo ? onOpenVideo(url) : onOpenImage(url); }}
                title={item.filename}
                aria-label={item.filename}
                disabled={!url && !failed}
            >
                {failed ? (
                    /* Codec/decrypt failure — still clickable so the lightbox can
                       try (audio may play even when a frame can't be decoded). */
                    <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-cl-faint">
                        {isVideo ? <Film size={18} /> : <ImageIco size={18} />}
                        <span className="text-[10px]">{isVideo ? 'No preview' : 'Unavailable'}</span>
                    </div>
                ) : !url || (isVideo && !poster && !posterFailed) ? (
                    <div className="w-full h-full animate-pulse bg-white/[0.04]" />
                ) : isVideo && !poster && posterFailed ? (
                    /* Offscreen capture failed — visible fallback: play muted for a
                       couple of frames, then freeze. Visible elements always load. */
                    <video
                        src={url}
                        muted
                        playsInline
                        autoPlay
                        className="w-full h-full object-cover pointer-events-none"
                        onTimeUpdate={(e) => {
                            const el = e.currentTarget;
                            if (el.currentTime > 0.15 && !el.paused) { el.pause(); setLoaded(true); }
                        }}
                        onError={() => setFailed(true)}
                    />
                ) : (
                    /* Videos render their captured poster frame as a plain image —
                       an in-DOM <video> can't be trusted to rasterize a thumbnail. */
                    <img
                        src={isVideo ? poster! : url}
                        alt={item.filename}
                        className={`w-full h-full object-cover transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
                        loading="lazy"
                        onLoad={() => setLoaded(true)}
                        onError={() => setFailed(true)}
                    />
                )}
                {isVideo && !failed && url && (poster || posterFailed) && (
                    <span className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                        <span
                            className="flex items-center justify-center rounded-full transition-transform duration-150 group-hover:scale-110"
                            style={{ width: 34, height: 34, background: 'rgba(5,8,18,.68)', border: '1px solid rgba(255,255,255,.18)' }}
                        >
                            <Play size={14} className="text-white" style={{ marginLeft: 2 }} fill="currentColor" />
                        </span>
                    </span>
                )}
            </button>
            {/* Jump to the original message — hover affordance in the corner. */}
            {onJump && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onJump(); }}
                    title="Show in chat"
                    aria-label="Show in chat"
                    className="absolute top-1.5 right-1.5 z-10 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer border-none"
                    style={{ width: 24, height: 24, background: 'rgba(5,8,18,.72)', color: 'var(--cl-muted)' }}
                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--cl-lume)')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--cl-muted)')}
                >
                    <MessageSquare size={12} />
                </button>
            )}
        </div>
    );
};

// ── Files table — explorer-style details view. Row click jumps to the
//    message; the trailing action downloads (decrypt-and-save). ─────────────

const FILE_GRID = 'minmax(0, 1fr) 72px 88px minmax(0, 96px) 34px';

const FileRow: React.FC<{
    item: AttachmentItem;
    token: string | null;
    sender: string | null;
    onJump?: () => void;
}> = ({ item, token, sender, onJump }) => {
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const kind = fileKind(item.mime, item.filename);

    const save = async () => {
        if (busy) return;
        setBusy(true);
        setFailed(false);
        try {
            const url = await decryptToUrl(item, token);
            const a = document.createElement('a');
            a.href = url;
            a.download = item.filename || 'download';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            // Give the save a beat before releasing the blob.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch {
            setFailed(true);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className={`grid items-center gap-2 px-2 rounded-lg transition-colors group ${onJump ? 'cursor-pointer hover:bg-cl-surface' : ''}`}
            style={{ gridTemplateColumns: FILE_GRID, height: 40 }}
            onClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                onJump?.();
            }}
            title={onJump ? 'Show in chat' : undefined}
        >
            <span className="flex items-center gap-2.5 min-w-0">
                <span className="shrink-0 text-cl-lume flex">{kind.icon}</span>
                <span className="text-[13px] font-semibold text-cl-text truncate">
                    {item.filename || 'File'}
                    {failed && <span className="text-cl-flash font-normal"> — couldn’t decrypt</span>}
                </span>
            </span>
            <span className="text-[11.5px] text-cl-faint text-right" style={{ fontFamily: 'var(--cl-font-mono)' }}>{fmtBytes(item.byteSize) || '—'}</span>
            <span className="text-[11.5px] text-cl-faint text-right">{fmtDate(item.at) || '—'}</span>
            <span className="text-[11.5px] text-cl-muted truncate text-right">{sender ?? '—'}</span>
            <button
                type="button"
                className="msgbar-btn"
                title={busy ? 'Decrypting…' : 'Decrypt & save'}
                aria-label="Download"
                onClick={save}
                disabled={busy}
                style={busy ? { opacity: 0.5, cursor: 'progress' } : undefined}
            >
                <Download size={14} />
            </button>
        </div>
    );
};

/**
 * Empty state for a tab inside this modal. Icon + two lines rather than the
 * 64px MascotEmpty: these panes sit inside modal chrome that a mascot would
 * out-weigh, and all three tabs can be empty at once. The three tabs used to
 * render the same bare `text-cl-faint` line with a different noun.
 */
const EmptyTab: React.FC<{ icon: React.ReactNode; title: string; sub: string }> = ({ icon, title, sub }) => (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
        <span className="text-cl-faint/60 mb-3">{icon}</span>
        <p className="text-[13px] font-medium text-cl-muted m-0">{title}</p>
        <p className="text-[11.5px] text-cl-faint mt-1 m-0 max-w-[260px] leading-snug">{sub}</p>
    </div>
);

// ── Modal ────────────────────────────────────────────────────────────────────

export const SharedContentModal: React.FC<SharedContentModalProps> = ({
    open, initialTab, onClose, messages, token, title, onJumpToMessage, resolveSenderName,
}) => {
    const [tab, setTab] = useState<SharedTab>(initialTab);
    const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
    const [videoUrl, setVideoUrl] = useState<string | null>(null);
    useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
    useEffect(() => { if (!open) { setLightboxUrl(null); setVideoUrl(null); } }, [open]);

    const { media, files, links } = useMemo(() => {
        const media: AttachmentItem[] = [];
        const files: AttachmentItem[] = [];
        const links: LinkItem[] = [];
        for (const m of messages) {
            const c: any = m?.content;
            if (!c) continue;
            if (c.type === 'attachment' && c.attachment_id && c.file_key_b64) {
                const item: AttachmentItem = {
                    msgId: m.id,
                    attachmentId: c.attachment_id,
                    fileKeyB64: c.file_key_b64,
                    fileNonceB64: c.file_nonce_b64,
                    mime: typeof c.mime === 'string' ? c.mime : '',
                    filename: c.filename || c.name || 'File',
                    byteSize: c.byte_size || 0,
                    at: msgTime(m),
                    senderId: m.sender_user_id ?? null,
                };
                if (item.mime.startsWith('image/') || item.mime.startsWith('video/')) media.push(item);
                else files.push(item);
            } else if (c.type === 'text' && typeof c.text === 'string') {
                for (const url of c.text.match(URL_RE) ?? []) {
                    links.push({ msgId: m.id, url, at: msgTime(m), senderId: m.sender_user_id ?? null });
                }
            }
        }
        // Newest first everywhere.
        media.sort((a, b) => b.at - a.at);
        files.sort((a, b) => b.at - a.at);
        links.sort((a, b) => b.at - a.at);
        return { media, files, links };
    }, [messages]);

    const shownMedia = media.slice(0, MEDIA_CAP);
    const shownFiles = files.slice(0, LIST_CAP);
    const shownLinks = links.slice(0, LIST_CAP);

    return (
        <>
            <ClModal
                open={open}
                onClose={onClose}
                width={640}
                label={`Shared in ${title}`}
                cardStyle={{ padding: 20, display: 'flex', flexDirection: 'column', maxHeight: 'min(78vh, 720px)' }}
            >
                <div className="flex items-center justify-between gap-3 mb-3.5">
                    <h3 className="text-[17px] m-0" style={{ fontFamily: 'var(--cl-font-display)', fontWeight: 600, color: 'var(--cl-text)' }}>
                        Shared in {title}
                    </h3>
                </div>
                <ClSegment<SharedTab>
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: 'media', label: <span className="inline-flex items-center gap-1.5"><ImageIco size={13} />Media <span className="opacity-70" style={{ fontFamily: 'var(--cl-font-mono)', fontSize: 10 }}>{media.length}</span></span> },
                        { value: 'files', label: <span className="inline-flex items-center gap-1.5"><FolderOpen size={13} />Files <span className="opacity-70" style={{ fontFamily: 'var(--cl-font-mono)', fontSize: 10 }}>{files.length}</span></span> },
                        { value: 'links', label: <span className="inline-flex items-center gap-1.5"><LinkIcon size={13} />Links <span className="opacity-70" style={{ fontFamily: 'var(--cl-font-mono)', fontSize: 10 }}>{links.length}</span></span> },
                    ]}
                />

                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar mt-3.5" style={{ overscrollBehavior: 'contain' }}>
                    {tab === 'media' && (
                        shownMedia.length === 0 ? (
                            <EmptyTab
                                icon={<ImageIco size={34} />}
                                title="Nothing shared yet"
                                sub="Photos and videos from this chat collect here — decrypted only on your devices."
                            />
                        ) : (
                            <>
                                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
                                    {shownMedia.map(item => (
                                        <MediaCell
                                            key={item.msgId}
                                            item={item}
                                            token={token}
                                            onOpenImage={setLightboxUrl}
                                            onOpenVideo={setVideoUrl}
                                            onJump={onJumpToMessage ? () => onJumpToMessage(item.msgId) : undefined}
                                        />
                                    ))}
                                </div>
                                {media.length > MEDIA_CAP && (
                                    <p className="text-[11px] text-cl-faint text-center mt-3 m-0">
                                        Showing the {MEDIA_CAP} most recent of {media.length}.
                                    </p>
                                )}
                            </>
                        )
                    )}

                    {tab === 'files' && (
                        shownFiles.length === 0 ? (
                            <EmptyTab
                                icon={<FolderOpen size={34} />}
                                title="No files yet"
                                sub="Anything attached to this chat shows up here."
                            />
                        ) : (
                            <div className="rounded-xl border border-cl-border/40 bg-cl-sink/40 px-1.5 py-1.5">
                                {/* Column headers — explorer details style */}
                                <div
                                    className="grid gap-2 px-2 pb-1.5 mb-1 border-b border-cl-border/40"
                                    style={{ gridTemplateColumns: FILE_GRID }}
                                >
                                    {['Name', 'Size', 'Shared', 'From', ''].map((h, i) => (
                                        <span
                                            key={i}
                                            className={`text-[9.5px] font-semibold uppercase text-cl-faint ${i > 0 && i < 4 ? 'text-right' : ''}`}
                                            style={{ fontFamily: 'var(--cl-font-mono)', letterSpacing: '1px' }}
                                        >
                                            {h}
                                        </span>
                                    ))}
                                </div>
                                <div className="flex flex-col gap-0.5">
                                    {shownFiles.map(item => (
                                        <FileRow
                                            key={item.msgId}
                                            item={item}
                                            token={token}
                                            sender={resolveSenderName?.(item.senderId) ?? null}
                                            onJump={onJumpToMessage ? () => onJumpToMessage(item.msgId) : undefined}
                                        />
                                    ))}
                                </div>
                            </div>
                        )
                    )}

                    {tab === 'links' && (
                        shownLinks.length === 0 ? (
                            <EmptyTab
                                icon={<LinkIcon size={34} />}
                                title="No links yet"
                                sub="Links posted in this chat collect here."
                            />
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                {shownLinks.map((l, i) => {
                                    const sender = resolveSenderName?.(l.senderId) ?? null;
                                    return (
                                        <div
                                            key={`${l.msgId}-${i}`}
                                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-cl-surface border border-cl-border/40 cursor-pointer hover:border-cl-lume/40 transition-colors group"
                                            title={l.url}
                                            onClick={(e) => {
                                                if ((e.target as HTMLElement).closest('button')) return;
                                                openUrl(l.url);
                                            }}
                                        >
                                            <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-cl-lume/10 text-cl-lume">
                                                <LinkIcon size={15} />
                                            </span>
                                            <span className="flex-1 min-w-0">
                                                <span className="block text-[13px] font-semibold text-cl-text truncate">{l.url.replace(/^https?:\/\//i, '')}</span>
                                                <span className="block text-[11px] text-cl-faint mt-0.5 truncate">
                                                    {[fmtDate(l.at), sender ? `from ${sender}` : null].filter(Boolean).join(' · ')}
                                                </span>
                                            </span>
                                            {onJumpToMessage && (
                                                <button
                                                    type="button"
                                                    onClick={() => onJumpToMessage(l.msgId)}
                                                    title="Show in chat"
                                                    aria-label="Show in chat"
                                                    className="shrink-0 flex items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer border-none bg-transparent text-cl-faint hover:text-cl-lume"
                                                    style={{ width: 26, height: 26 }}
                                                >
                                                    <MessageSquare size={13} />
                                                </button>
                                            )}
                                            <ExternalLink size={13} className="text-cl-faint shrink-0 group-hover:text-cl-lume transition-colors" />
                                        </div>
                                    );
                                })}
                            </div>
                        )
                    )}
                </div>
            </ClModal>

            {lightboxUrl && (
                <ImageLightbox src={lightboxUrl} alt="Shared media" onClose={() => setLightboxUrl(null)} />
            )}
            {videoUrl && (
                <VideoLightbox src={videoUrl} onClose={() => setVideoUrl(null)} />
            )}
        </>
    );
};
