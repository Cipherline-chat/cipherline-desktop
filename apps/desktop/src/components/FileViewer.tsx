import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, Download, FileCode, FileText, FileSpreadsheet } from 'lucide-react';
import { useGifFavorite } from '../hooks/useGifFavorite';
import { sanitizeMime } from '../utils/crypto';
import { ImageLightbox } from './ImageLightbox';
import { GifPlayer } from './GifPlayer';
import { acquireMediaThumb, peekMediaThumb, putMediaThumb, releaseMediaThumb, type MediaThumb } from '../utils/decryptedMediaCache';
import { ClButton } from './cl';

interface FileViewerProps {
    objectUrl: string | null;
    filename: string;
    mime: string;
}

// ── Image thumbnail ──────────────────────────────────────────────────────────
// Chat thumbnails are rendered inside a 320×320 box. 500px gives us ~1.5×
// headroom for high-DPR displays while being a fraction of the size of the
// original (a 4000×3000px phone photo → a ~50–80 KB JPEG instead of multi-MB).
// Full resolution is always available via the lightbox (click to enlarge).
const THUMB_MAX_PX = 500;
const THUMB_QUALITY = 0.75;

function shouldSkipThumb(mime: string) {
    return mime === 'image/gif' || mime === 'image/svg+xml';
}

// ── Type helpers ─────────────────────────────────────────────────────────────
function ext(filename: string) {
    return filename.split('.').pop()?.toLowerCase() ?? '';
}

function isPdfFile(mime: string, f: string) {
    return mime === 'application/pdf' || ext(f) === 'pdf';
}

function isExcelFile(mime: string, f: string) {
    const e = ext(f);
    return ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(e) ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'application/vnd.ms-excel';
}

function isWordFile(mime: string, f: string) {
    const e = ext(f);
    return ['docx', 'doc'].includes(e) ||
        mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mime === 'application/msword';
}

function isCsvFile(mime: string, f: string) {
    const e = ext(f);
    return mime === 'text/csv' || mime === 'text/tab-separated-values' || e === 'csv' || e === 'tsv';
}

const TEXT_MIME_SET = new Set([
    'application/json', 'application/javascript', 'application/x-javascript',
    'application/typescript', 'application/x-typescript',
    'application/yaml', 'application/x-yaml', 'application/toml',
    'application/xml', 'application/xhtml+xml', 'application/ld+json',
    'application/graphql',
]);
const TEXT_EXTS = new Set([
    'txt','md','markdown','yaml','yml','toml','json','jsonc',
    'js','ts','jsx','tsx','mjs','cjs',
    'py','rb','go','rs','java','kt','swift','c','cpp','h','cs',
    'sh','bash','zsh','fish','env',
    'html','htm','css','scss','less',
    'xml','svg','graphql','gql',
    'ini','cfg','conf','properties','sql','log',
    'gitignore','editorconfig','prettierrc','eslintrc','babelrc',
]);
const TEXT_DOTFILES = new Set(['dockerfile','makefile','procfile','vagrantfile','gemfile']);

function isTextLike(mime: string, f: string) {
    if (mime.startsWith('text/')) return true;
    if (TEXT_MIME_SET.has(mime)) return true;
    const e = ext(f);
    if (e && TEXT_EXTS.has(e)) return true;
    if (TEXT_DOTFILES.has(f.toLowerCase())) return true;
    return false;
}

function langLabel(mime: string, f: string) {
    const e = ext(f);
    const map: Record<string, string> = {
        json:'JSON', jsonc:'JSON', yaml:'YAML', yml:'YAML', toml:'TOML',
        js:'JS', mjs:'JS', cjs:'JS', ts:'TS', jsx:'JSX', tsx:'TSX',
        py:'Python', rb:'Ruby', go:'Go', rs:'Rust', java:'Java',
        kt:'Kotlin', swift:'Swift', c:'C', cpp:'C++', h:'C/C++', cs:'C#',
        sh:'Shell', bash:'Shell', zsh:'Shell', fish:'Shell', env:'ENV',
        html:'HTML', htm:'HTML', css:'CSS', scss:'SCSS', less:'Less',
        xml:'XML', svg:'SVG', graphql:'GraphQL', gql:'GraphQL',
        sql:'SQL', md:'Markdown', markdown:'Markdown',
        ini:'INI', cfg:'Config', conf:'Config', log:'Log', txt:'Text',
    };
    if (e && map[e]) return map[e];
    if (['dockerfile','makefile','procfile'].includes(f.toLowerCase())) return 'Config';
    if (TEXT_MIME_SET.has(mime)) {
        if (mime.includes('json'))       return 'JSON';
        if (mime.includes('yaml'))       return 'YAML';
        if (mime.includes('javascript')) return 'JS';
        if (mime.includes('typescript')) return 'TS';
        if (mime.includes('xml'))        return 'XML';
    }
    return 'Text';
}

// ── CSV parser ───────────────────────────────────────────────────────────────
function parseCsv(text: string, delimiter: string): string[][] {
    const rows: string[][] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const cells: string[] = [];
        let cell = '', inQuote = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
                if (inQuote && line[i + 1] === '"') { cell += '"'; i++; }
                else inQuote = !inQuote;
            } else if (ch === delimiter && !inQuote) { cells.push(cell); cell = ''; }
            else cell += ch;
        }
        cells.push(cell);
        rows.push(cells);
    }
    return rows;
}

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_TABLE_ROWS = 6;
const MAX_TABLE_COLS = 7;
const PREVIEW_LINES  = 8;
const PREVIEW_CHARS  = 600;

// ── Shared styles ────────────────────────────────────────────────────────────
const cardBase: React.CSSProperties = {
    width: '100%', maxWidth: '340px', background: 'rgba(0,0,0,0.35)',
    border: '1px solid var(--cl-border)',
    borderRadius: '12px', overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
};
const cardHeader: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '9px 12px',
    borderBottom: '1px solid var(--cl-border)',
    background: 'rgba(255,255,255,0.03)',
};
const cardFooter: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '4px',
    padding: '7px 10px',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    background: 'rgba(255,255,255,0.02)',
};
const badge = (color: string): React.CSSProperties => ({
    fontSize: '0.68rem', padding: '2px 6px', borderRadius: '4px',
    background: `${color}22`, color, fontWeight: 600,
    letterSpacing: '0.03em', flexShrink: 0,
});

function DownloadLink({ href, filename }: { href: string; filename: string }) {
    const [hov, setHov] = useState(false);
    return (
        <a href={href} download={filename} onClick={e => e.stopPropagation()}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                fontSize: '0.72rem', textDecoration: 'none', padding: '4px 8px',
                borderRadius: '6px', border: 'none', cursor: 'pointer',
                color: hov ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                background: hov ? 'rgba(255,255,255,0.07)' : 'transparent',
                transition: 'color 150ms, background 150ms',
            }}
            onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
            <Download size={12} /> Download
        </a>
    );
}

// ── Spreadsheet table (shared by CSV and Excel) ──────────────────────────────
function SheetTable({ rows, totalRows, totalCols }: {
    rows: string[][];
    totalRows: number;
    totalCols: number;
}) {
    const colCount = Math.min(totalCols, MAX_TABLE_COLS);
    const extraCols = totalCols > MAX_TABLE_COLS;
    const extraRows = totalRows > MAX_TABLE_ROWS;

    return (
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.72rem', tableLayout: 'fixed' }}>
                <colgroup>
                    {Array.from({ length: colCount }).map((_, i) => (
                        <col key={i} style={{ width: `${100 / colCount}%` }} />
                    ))}
                    {extraCols && <col style={{ width: '20px' }} />}
                </colgroup>
                <tbody>
                    {rows.map((row, ri) => (
                        <tr key={ri} style={{
                            background: ri === 0
                                ? 'rgba(255,255,255,0.05)'
                                : ri % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent',
                        }}>
                            {Array.from({ length: colCount }).map((_, ci) => {
                                const Tag = ri === 0 ? 'th' : 'td';
                                return (
                                    <Tag key={ci} style={{
                                        padding: '4px 8px',
                                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                                        fontWeight: ri === 0 ? 600 : 400,
                                        opacity: ri === 0 ? 0.85 : 0.65,
                                        overflow: 'hidden', textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap', textAlign: 'left',
                                    }}>
                                        {row[ci] ?? ''}
                                    </Tag>
                                );
                            })}
                            {extraCols && (
                                <td style={{ padding: '4px 2px', opacity: 0.3, fontSize: '0.65rem', textAlign: 'center' }}>…</td>
                            )}
                        </tr>
                    ))}
                    {extraRows && (
                        <tr>
                            <td colSpan={colCount + (extraCols ? 1 : 0)}
                                style={{ padding: '4px 8px', opacity: 0.3, fontSize: '0.68rem', fontStyle: 'italic' }}>
                                … {totalRows - MAX_TABLE_ROWS} more row{totalRows - MAX_TABLE_ROWS !== 1 ? 's' : ''}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

// ── Component ────────────────────────────────────────────────────────────────
const FileViewer: React.FC<FileViewerProps> = ({ objectUrl, filename, mime }) => {
    const [textContent, setTextContent] = useState<string | null>(null);
    const [showLightbox, setShowLightbox] = useState(false);
    const [gifBlob, setGifBlob]           = useState<Blob | null>(null);

    // Excel: list of { name, rows } per sheet
    const [excelSheets, setExcelSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
    const [activeSheet, setActiveSheet] = useState(0);

    // Word: extracted plain-text paragraphs
    const [wordText, setWordText] = useState<string | null>(null);

    // Preview parse failure — rendered instead of the permanent "Loading preview…" spinner (P2-REND-14)
    const [previewError, setPreviewError] = useState<string | null>(null);

    // Root element ref — used to dispatch cipherline:content-loaded so ChatPane
    // can snap to bottom the moment any content type finishes rendering.
    const rootRef = useRef<HTMLDivElement | null>(null);
    const notifyLoaded = () => {
        rootRef.current?.dispatchEvent(new CustomEvent('cipherline:content-loaded', { bubbles: true }));
    };

    // Media detection MUST use the same clamped type decryptBlob stamped onto
    // the Blob. Branching on the raw sender-supplied `mime` meant an
    // attachment whose type isn't on the safe list (a .mov video, a .bmp
    // image) rendered a <video>/<img> pointing at an application/octet-stream
    // blob — a player that could never play and an image that could never
    // load, silently, with no error surfaced anywhere. When the type doesn't
    // survive sanitisation we now fall through to the download card, which is
    // honest about what the user can actually do with the file.
    const effectiveMime = sanitizeMime(mime);

    // Set when <video>/<audio> reports it can't decode this file, which demotes
    // it to the download card. Keyed off objectUrl so switching to a different
    // attachment re-arms the player instead of inheriting the previous one's
    // failure.
    const [mediaError, setMediaError] = useState(false);
    useEffect(() => { setMediaError(false); }, [objectUrl]);
    const isImage = effectiveMime.startsWith('image/');
    // The decrypted GIF bytes, only for GIFs: they identify the file against
    // the favorites library (shows "favorited", prevents a duplicate save).
    const wantsGifBlob = effectiveMime === 'image/gif' && !!objectUrl;
    useEffect(() => {
        if (!wantsGifBlob) { setGifBlob(null); return; }
        let cancelled = false;
        fetch(objectUrl).then(r => r.blob()).then(b => { if (!cancelled) setGifBlob(b); }).catch(() => {});
        return () => { cancelled = true; };
    }, [wantsGifBlob, objectUrl]);
    const { saved: gifSaved, busy: gifSaving, toggle: toggleGifFavorite } = useGifFavorite(gifBlob, filename);
    const isVideo = effectiveMime.startsWith('video/');
    const isAudio = effectiveMime.startsWith('audio/');
    const isPdf   = isPdfFile(mime, filename);
    const isExcel = !isPdf && isExcelFile(mime, filename);
    const isWord  = !isPdf && !isExcel && isWordFile(mime, filename);
    const isCsv   = !isPdf && !isExcel && !isWord && isCsvFile(mime, filename);
    const isText  = !isPdf && !isExcel && !isWord && !isCsv && isTextLike(mime, filename);

    // Image thumbnail. Cached per full-size URL (utils/decryptedMediaCache)
    // so a remount — every chat switch — shows it on the first paint instead
    // of decoding the full image and re-encoding a JPEG again.
    const wantsThumb = !!objectUrl && isImage && !shouldSkipThumb(mime);
    const [thumb, setThumb] = useState<MediaThumb | null>(() => (wantsThumb ? peekMediaThumb(objectUrl!) : null));
    const thumbUrl = thumb?.url ?? null;

    useEffect(() => {
        if (!objectUrl || !isImage || shouldSkipThumb(mime)) return;
        let cancelled = false;
        let held = false;
        const take = (t: MediaThumb) => {
            if (cancelled) { releaseMediaThumb(objectUrl); return; }
            held = true;
            setThumb(t);
        };
        const hit = acquireMediaThumb(objectUrl);
        if (hit) take(hit);
        else {
            (async () => {
                const img = new window.Image();
                img.src = objectUrl;
                // decode() decodes off the main thread; drawing a merely
                // loaded <img> decoded the whole photo synchronously here.
                try { await img.decode(); } catch { return; }
                if (cancelled) return;
                const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
                const ratio = Math.min(1, THUMB_MAX_PX / Math.max(nw, nh));
                const w = Math.max(1, Math.round(nw * ratio));
                const h = Math.max(1, Math.round(nh * ratio));
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx || cancelled) return;
                ctx.drawImage(img, 0, 0, w, h);
                canvas.toBlob(blob => {
                    if (!blob) return;
                    const made = putMediaThumb(objectUrl, URL.createObjectURL(blob), blob.size, w, h);
                    take(made);
                }, 'image/jpeg', THUMB_QUALITY);
            })();
        }
        return () => {
            cancelled = true;
            if (held) releaseMediaThumb(objectUrl);
        };
    }, [objectUrl, isImage, mime]);
    // Reserve the inline image's box from the thumbnail's known size (same
    // 320 px caps as the style below), so it doesn't jump while decoding.
    const thumbBox = thumb?.width && thumb?.height
        ? (() => { const k = Math.min(1, 320 / thumb.width!, 320 / thumb.height!); return { width: Math.round(thumb.width! * k), height: Math.round(thumb.height! * k) }; })()
        : null;

    // Text / CSV content — cancellation guard prevents stale setState (P2-REND-14)
    useEffect(() => {
        if (!objectUrl || (!isText && !isCsv)) return;
        let cancelled = false;
        fetch(objectUrl).then(r => r.text()).then(text => {
            if (!cancelled) { setTextContent(text); notifyLoaded(); }
        }).catch(err => {
            console.error('FileViewer: text load failed', err);
            if (!cancelled) setPreviewError('Preview failed to load.');
        });
        return () => { cancelled = true; };
    }, [objectUrl, isText, isCsv]);

    // Excel parsing via ExcelJS (MIT) — replaces SheetJS which is commercially locked post-0.18.5
    useEffect(() => {
        if (!objectUrl || !isExcel) return;
        let cancelled = false;

        async function loadExcel() {
            const [buf, mod] = await Promise.all([
                fetch(objectUrl!).then(r => r.arrayBuffer()),
                import('exceljs'),
            ]);
            if (cancelled) return;

            const ExcelJS = (mod as any).default ?? mod;
            const wb = new ExcelJS.Workbook();
            await wb.xlsx.load(buf);

            const sheets: { name: string; rows: string[][] }[] = [];
            wb.eachSheet((ws: any) => {
                const rows: string[][] = [];
                let maxCols = 0;
                ws.eachRow({ includeEmpty: false }, (row: any) => {
                    const vals: any[] = Array.isArray(row.values) ? row.values : [];
                    const cells = vals.slice(1).map((v: any) => {
                        if (v == null) return '';
                        if (v instanceof Date) return v.toLocaleDateString();
                        if (typeof v === 'object') {
                            if (Array.isArray(v.richText)) return v.richText.map((rt: any) => rt.text ?? '').join('');
                            if ('result' in v) return String(v.result ?? '');
                            if ('error' in v) return String(v.error);
                            return '';
                        }
                        return String(v);
                    });
                    maxCols = Math.max(maxCols, cells.length);
                    rows.push(cells);
                });
                // Pad to rectangular array so the table renderer can rely on uniform widths
                const padded = rows.map(r => [...r, ...Array(Math.max(0, maxCols - r.length)).fill('')]);
                while (padded.length > 0 && padded[padded.length - 1].every((c: string) => c === '')) padded.pop();
                sheets.push({ name: ws.name, rows: padded });
            });
            if (cancelled) return;
            setExcelSheets(sheets);
            setActiveSheet(0);
            notifyLoaded();
        }

        loadExcel().catch(err => {
            console.error('FileViewer: Excel parse failed', err);
            if (!cancelled) setPreviewError('Preview failed to load.');
        });
        return () => { cancelled = true; };
    }, [objectUrl, isExcel]);

    // Word parsing via mammoth (browser build aliased in vite.config)
    useEffect(() => {
        if (!objectUrl || !isWord) return;
        let cancelled = false;
        Promise.all([
            fetch(objectUrl).then(r => r.arrayBuffer()),
            import('mammoth'),
        ]).then(([buf, mod]) => {
            if (cancelled) return;
            const mammoth = (mod as any).default ?? mod;
            return mammoth.extractRawText({ arrayBuffer: buf });
        }).then(result => {
            if (!cancelled && result) { setWordText((result as any).value); notifyLoaded(); }
        }).catch(err => {
            console.error('FileViewer: Word parse failed', err);
            if (!cancelled) setPreviewError('Preview failed to load.');
        });
        return () => { cancelled = true; };
    }, [objectUrl, isWord]);

    // ── Loading ──────────────────────────────────────────────────────────────
    if (!objectUrl) {
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}>
                <div style={{ width: '16px', height: '16px', border: '2px solid var(--cl-border)', borderTopColor: 'var(--cl-lume)', borderRadius: '50%', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                <span style={{ fontSize: '0.9rem', opacity: 0.7 }}>Decrypting {filename}…</span>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    // ── Image ────────────────────────────────────────────────────────────────
    if (isImage) {
        const isGif    = effectiveMime === 'image/gif';
        const inlineSrc = shouldSkipThumb(mime) ? objectUrl : (thumbUrl ?? objectUrl);

        const handleSaveGif = (e: React.MouseEvent) => {
            e.stopPropagation();
            void toggleGifFavorite();
        };

        return (
            <>
                <div style={{ display: 'inline-block', maxWidth: '320px', position: 'relative' }}
                     className="gif-msg-wrapper"
                     onClick={(e) => { e.stopPropagation(); setShowLightbox(true); }}>
                    {isGif ? (
                        /* Animated GIF — use GifPlayer so playback respects
                           window-focus and the autoPlayGifs preference. */
                        <GifPlayer
                            src={inlineSrc ?? ''}
                            imgStyle={{ display: 'block', width: 'auto', height: 'auto', maxWidth: '320px', maxHeight: '320px', borderRadius: '12px', cursor: 'zoom-in' }}
                            onLoad={notifyLoaded}
                        />
                    ) : (
                        <img src={inlineSrc} alt={filename}
                            decoding="async"
                            style={{ display: 'block', width: 'auto', height: 'auto', maxWidth: '320px', maxHeight: '320px', borderRadius: '12px', cursor: 'zoom-in', ...(thumbBox ?? {}) }}
                            onLoad={e => e.currentTarget.dispatchEvent(new CustomEvent('cipherline:content-loaded', { bubbles: true }))} />
                    )}
                    {/* Save-to-GIF-library button — GIFs only. Plain <button>,
                        not ClButton — ClButton's `style` prop lands on the
                        outer wrapper span, not the inner .cap that actually
                        renders, so shrinking below the kit's default 46px
                        silently failed. Sizing/position now live in
                        .gif-msg-save-btn (index.css); hover-reveal is set
                        there too, the per-button hover accent color stays
                        below since it's local to this component. */}
                    {isGif && (
                        <button
                            type="button"
                            onClick={handleSaveGif}
                            disabled={gifSaving || !gifBlob}
                            title={gifSaved ? 'Remove from favorites' : 'Favorite GIF'}
                            aria-label={gifSaved ? 'Remove from favorites' : 'Favorite GIF'}
                            className={`gif-msg-save-btn${gifSaved ? ' saved' : ''}`}
                        >
                            <Bookmark size={13} style={{ fill: gifSaved ? 'currentColor' : 'none' }} />
                        </button>
                    )}
                </div>
                {/* Hover accent — index.css handles reveal-on-hover; only the
                    accent color is local to this component. Was an off-brand
                    indigo (rgba(79,70,229,...)) that doesn't appear anywhere
                    else in the app's palette — every other hover accent is
                    lume teal, this one had just drifted. */}
                {isGif && (
                    <style>{`
                        .gif-msg-save-btn:hover { background: rgba(37,224,200,0.9) !important; }
                    `}</style>
                )}
                {showLightbox && objectUrl && (
                    <ImageLightbox
                        src={objectUrl}
                        filename={filename}
                        onClose={() => setShowLightbox(false)}
                    />
                )}
            </>
        );
    }

    // ── Video ────────────────────────────────────────────────────────────────
    // Always attempt the player for a video type, and only drop to the file
    // card if the browser actually reports it can't decode this one (mediaError
    // below). Deciding up-front from the MIME alone gets it wrong in both
    // directions — a container Chromium supports gets needlessly demoted, and
    // one it doesn't renders controls that doing nothing. Let the decoder
    // answer, then believe it.
    if (isVideo && !mediaError) {
        return (
            <video
                src={objectUrl}
                controls
                preload="metadata"
                playsInline
                style={{ width: '100%', maxWidth: '400px', maxHeight: '320px', borderRadius: '12px', display: 'block', background: '#000' }}
                onLoadedMetadata={notifyLoaded}
                onError={() => setMediaError(true)}
            />
        );
    }

    // ── Audio ────────────────────────────────────────────────────────────────
    if (isAudio && !mediaError) {
        return (
            <audio
                src={objectUrl}
                controls
                preload="metadata"
                style={{ width: '100%', maxWidth: '300px', marginTop: '4px' }}
                onLoadedMetadata={notifyLoaded}
                onError={() => setMediaError(true)}
            />
        );
    }

    // ── PDF — inline embed, no modal ─────────────────────────────────────────
    if (isPdf) {
        return (
            <div ref={rootRef} style={{ ...cardBase, width: '100%', maxWidth: '420px' }}>
                <div style={cardHeader}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                        <rect x="3" y="1" width="14" height="18" rx="2" stroke="#e74c3c" strokeWidth="1.5" />
                        <path d="M17 1l4 4h-4V1z" fill="#e74c3c" />
                        <text x="5.5" y="14.5" fontSize="5.5" fontWeight="700" fill="#e74c3c" fontFamily="sans-serif">PDF</text>
                    </svg>
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
                        {filename}
                    </span>
                    <span style={badge('#e74c3c')}>PDF</span>
                </div>

                {/* Inline PDF preview.
                    #toolbar=0 / navpanes=0 hide Chromium's chrome.
                    The native PDF scrollbar is rendered by the plugin — CSS
                    scrollbar-width has no effect on it. Instead we make the
                    <embed> 17 px wider than its container (the standard
                    scrollbar width) so the scrollbar is pushed off-screen,
                    then clip it with overflow:hidden on the position:relative
                    parent. This works reliably now that the parent card has a
                    definite pixel width (from the flex-1 content column fix). */}
                <div style={{ position: 'relative', height: '340px', overflow: 'hidden' }}>
                    <embed
                        src={`${objectUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
                        type="application/pdf"
                        style={{
                            position: 'absolute', top: 0, left: 0,
                            width: 'calc(100% + 17px)',
                            height: '100%',
                            border: 'none',
                        }}
                        onLoad={notifyLoaded}
                    />
                </div>

                <div style={cardFooter}>
                    <DownloadLink href={objectUrl} filename={filename} />
                </div>
            </div>
        );
    }

    // ── Excel ────────────────────────────────────────────────────────────────
    if (isExcel) {
        const sheet   = excelSheets?.[activeSheet];
        const allRows = sheet?.rows ?? [];
        const preview = allRows.slice(0, MAX_TABLE_ROWS + 1);
        const totalCols = allRows.reduce((m, r) => Math.max(m, r.length), 0);

        return (
            <div ref={rootRef} style={cardBase}>
                <div style={cardHeader}>
                    <FileSpreadsheet size={14} style={{ opacity: 0.7, flexShrink: 0, color: '#1d6f42' }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
                        {filename}
                    </span>
                    <span style={badge('#1d6f42')}>Excel</span>
                </div>

                {/* Sheet tabs (only if multiple sheets) */}
                {excelSheets && excelSheets.length > 1 && (
                    <div style={{ display: 'flex', gap: '2px', padding: '6px 8px 0', overflowX: 'auto', flexShrink: 0 }}>
                        {excelSheets.map((s, i) => (
                            <ClButton key={i} variant="ghost" size="sm" active={i === activeSheet} onClick={() => setActiveSheet(i)} style={{
                                padding: '3px 10px', fontSize: '0.7rem', borderRadius: '5px 5px 0 0',
                                whiteSpace: 'nowrap',
                                background: i === activeSheet ? 'rgba(29,111,66,0.25)' : 'rgba(255,255,255,0.05)',
                                color: i === activeSheet ? '#1d6f42' : 'rgba(255,255,255,0.5)',
                                fontWeight: i === activeSheet ? 600 : 400,
                            }}>
                                {s.name}
                            </ClButton>
                        ))}
                    </div>
                )}

                {excelSheets === null ? (
                    <div style={{ padding: '14px 12px', fontSize: '0.78rem', opacity: 0.5, color: previewError ? 'var(--cl-flash)' : undefined }}>
                        {previewError ?? 'Loading…'}
                    </div>
                ) : allRows.length === 0 ? (
                    <div style={{ padding: '14px 12px', fontSize: '0.78rem', opacity: 0.3, fontStyle: 'italic' }}>(empty sheet)</div>
                ) : (
                    <SheetTable rows={preview.slice(0, MAX_TABLE_ROWS)} totalRows={allRows.length} totalCols={totalCols} />
                )}

                {excelSheets && allRows.length > 0 && (
                    <div style={{ padding: '4px 12px 0', fontSize: '0.67rem', opacity: 0.3 }}>
                        {allRows.length} row{allRows.length !== 1 ? 's' : ''} · {totalCols} col{totalCols !== 1 ? 's' : ''}
                        {excelSheets.length > 1 && ` · ${excelSheets.length} sheets`}
                    </div>
                )}

                <div style={cardFooter}>
                    <DownloadLink href={objectUrl} filename={filename} />
                </div>
            </div>
        );
    }

    // ── Word ─────────────────────────────────────────────────────────────────
    if (isWord) {
        const allParas = (wordText ?? '').split(/\n+/).filter(p => p.trim());
        const preview  = allParas.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
        const isTrunc  = allParas.length > PREVIEW_LINES || (wordText ?? '').length > PREVIEW_CHARS;

        return (
            <div ref={rootRef} style={cardBase}>
                <div style={cardHeader}>
                    <FileText size={14} style={{ opacity: 0.7, flexShrink: 0, color: '#2b5eb8' }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
                        {filename}
                    </span>
                    <span style={badge('#2b5eb8')}>Word</span>
                </div>

                <div style={{
                    padding: '10px 12px', fontSize: '0.75rem', lineHeight: '1.6',
                    color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', overflowY: 'hidden',
                    minHeight: wordText === null ? '72px' : undefined,
                    display: 'flex', flexDirection: 'column',
                    alignItems: wordText === null ? 'center' : undefined,
                    justifyContent: wordText === null ? 'center' : undefined,
                }}>
                    {wordText === null
                        ? <span style={{ opacity: 0.5, color: previewError ? 'var(--cl-flash)' : undefined }}>{previewError ?? 'Loading preview…'}</span>
                        : preview || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>(empty document)</span>
                    }
                    {wordText !== null && isTrunc && (
                        <span style={{ opacity: 0.3, marginTop: '4px' }}>…</span>
                    )}
                </div>

                <div style={cardFooter}>
                    <DownloadLink href={objectUrl} filename={filename} />
                </div>
            </div>
        );
    }

    // ── CSV / TSV ────────────────────────────────────────────────────────────
    if (isCsv) {
        const delimiter = ext(filename) === 'tsv' || mime === 'text/tab-separated-values' ? '\t' : ',';
        const label     = ext(filename) === 'tsv' ? 'TSV' : 'CSV';
        const allRows   = textContent ? parseCsv(textContent, delimiter) : [];
        const totalCols = allRows.reduce((m, r) => Math.max(m, r.length), 0);

        return (
            <div ref={rootRef} style={cardBase}>
                <div style={cardHeader}>
                    <FileSpreadsheet size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
                        {filename}
                    </span>
                    <span style={badge('#27ae60')}>{label}</span>
                </div>

                {textContent === null ? (
                    <div style={{ padding: '14px 12px', fontSize: '0.78rem', opacity: 0.5, color: previewError ? 'var(--cl-flash)' : undefined }}>
                        {previewError ?? 'Loading preview…'}
                    </div>
                ) : allRows.length === 0 ? (
                    <div style={{ padding: '14px 12px', fontSize: '0.78rem', opacity: 0.3, fontStyle: 'italic' }}>(empty file)</div>
                ) : (
                    <SheetTable rows={allRows.slice(0, MAX_TABLE_ROWS)} totalRows={allRows.length} totalCols={totalCols} />
                )}

                {textContent !== null && allRows.length > 0 && (
                    <div style={{ padding: '4px 12px 0', fontSize: '0.67rem', opacity: 0.3 }}>
                        {allRows.length} row{allRows.length !== 1 ? 's' : ''} · {totalCols} col{totalCols !== 1 ? 's' : ''}
                    </div>
                )}

                <div style={cardFooter}>
                    <DownloadLink href={objectUrl} filename={filename} />
                </div>
            </div>
        );
    }

    // ── Text / Code ──────────────────────────────────────────────────────────
    if (isText) {
        const label    = langLabel(mime, filename);
        const rawLines = (textContent ?? '').split('\n');
        const preview  = rawLines.slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
        const isTrunc  = rawLines.length > PREVIEW_LINES || (textContent ?? '').length > PREVIEW_CHARS;

        return (
            <div ref={rootRef} style={cardBase}>
                <div style={cardHeader}>
                    <FileCode size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.8rem', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>
                        {filename}
                    </span>
                    <span style={badge('#25E0C8')}>{label}</span>
                </div>

                <div style={{
                    padding: '10px 12px',
                    fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",ui-monospace,monospace',
                    fontSize: '0.75rem', lineHeight: '1.6',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                    overflowY: 'hidden', color: 'rgba(255,255,255,0.75)',
                    minHeight: textContent === null ? '72px' : undefined,
                    display: 'flex', flexDirection: 'column',
                    alignItems: textContent === null ? 'center' : undefined,
                    justifyContent: textContent === null ? 'center' : undefined,
                }}>
                    {textContent === null
                        ? <span style={{ opacity: 0.5, fontFamily: 'sans-serif', color: previewError ? 'var(--cl-flash)' : undefined }}>{previewError ?? 'Loading preview…'}</span>
                        : preview || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>(empty file)</span>
                    }
                    {textContent !== null && isTrunc && (
                        <span style={{ opacity: 0.3, marginTop: '4px' }}>…</span>
                    )}
                </div>

                <div style={cardFooter}>
                    <DownloadLink href={objectUrl} filename={filename} />
                </div>
            </div>
        );
    }

    // ── Generic ──────────────────────────────────────────────────────────────
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: '12px', width: '100%', maxWidth: '400px' }}>
            <FileText size={20} style={{ opacity: 0.4, flexShrink: 0 }} />
            <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 500, fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filename}</span>
                {/* When we got here because playback failed, say so — otherwise
                    a video silently rendering as a file row looks like a bug. */}
                <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
                    {mediaError ? "Can't play this format here — download to watch" : mime}
                </span>
            </div>
            <a href={objectUrl} download={filename}
                style={{ color: 'var(--cl-text)', opacity: 0.6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', background: 'rgba(255,255,255,0.06)', textDecoration: 'none' }}
                onMouseOver={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(255,255,255,0.12)'; }}
                onMouseOut={e => { e.currentTarget.style.opacity = '0.6'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}>
                <Download size={16} />
            </a>
        </div>
    );
};

export default FileViewer;
