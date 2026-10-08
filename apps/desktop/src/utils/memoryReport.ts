/**
 * "Where is the renderer's memory right now?" — one line for the Performance
 * log's Copy button (Settings → Advanced).
 *
 * The per-process working-set rows the main process records say HOW MUCH each
 * process uses; they cannot say WHAT for. On the owner's machine the browser
 * process grew ~110-125 MB and the renderer ~270-350 MB after startup, and the
 * candidates are things only real data produces: decrypted media held for fast
 * re-display (its Blob bytes live in the BROWSER process), avatar and custom
 * emoji images (same), link-preview images, how much history is resident, how
 * many images the DOM holds decoded. This line names each of them with a number.
 *
 * PRIVACY: counts and sizes only — no ids, names, URLs or content, the same rule
 * as the rest of the log.
 */
import { decryptedMediaCacheStats } from './decryptedMediaCache';
import { remoteImageCacheStats } from './remoteImageCache';
import { avatarCacheStats } from '../hooks/useEncryptedAvatar';
import { emojiCacheStats } from './serverEmojiLoader';
import { historyStats } from './messageStore';

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)}MB`;

export interface MemorySources {
    jsHeap: () => { used: number; total: number } | null;
    dom: () => { nodes: number; images: number; imagePixels: number; canvases: number; videos: number };
}

const browserSources: MemorySources = {
    jsHeap: () => {
        const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
        return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize } : null;
    },
    dom: () => {
        let imagePixels = 0;
        const images = typeof document === 'undefined' ? [] : Array.from(document.images);
        for (const img of images) if (img.complete) imagePixels += (img.naturalWidth || 0) * (img.naturalHeight || 0);
        return {
            nodes: typeof document === 'undefined' ? 0 : document.getElementsByTagName('*').length,
            images: images.length,
            imagePixels,
            canvases: typeof document === 'undefined' ? 0 : document.getElementsByTagName('canvas').length,
            videos: typeof document === 'undefined' ? 0 : document.getElementsByTagName('video').length,
        };
    },
};

/** One line, e.g. "renderer now: js 41/60MB | dom 2400 nodes, 37 img 9.4MP, 0 canvas, 0 video | media 40.0MB/31 (12 held) | ...". */
export function rendererMemoryLine(src: MemorySources = browserSources): string {
    const parts: string[] = [];
    const js = src.jsHeap();
    parts.push(js ? `js ${Math.round(js.used / 1048576)}/${Math.round(js.total / 1048576)}MB` : 'js n/a');
    const d = src.dom();
    parts.push(`dom ${d.nodes} nodes, ${d.images} img ${(d.imagePixels / 1e6).toFixed(1)}MP, ${d.canvases} canvas, ${d.videos} video`);
    const { media, thumbs } = decryptedMediaCacheStats();
    parts.push(`media ${mb(media.bytes)}/${media.entries} (${media.held} held)`);
    parts.push(`thumbs ${mb(thumbs.bytes)}/${thumbs.entries}`);
    const link = remoteImageCacheStats();
    parts.push(`link-img ${mb(link.bytes)}/${link.entries}`);
    const av = avatarCacheStats();
    parts.push(`avatars ${mb(av.bytes)}/${av.entries}`);
    const em = emojiCacheStats();
    parts.push(`emoji ${mb(em.bytes)}/${em.entries}`);
    const h = historyStats();
    parts.push(`history ${h.threads} threads/${h.messages} msgs`);
    return `renderer now: ${parts.join(' | ')}`;
}
