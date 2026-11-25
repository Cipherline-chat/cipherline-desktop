/**
 * embed:register-post-media (phase 4): a reader plays the video a SENDER's
 * X / Reddit post embed names only when the page is really a post and the
 * file is on that provider's own media host. Main's own parse decides.
 */
import { describe, it, expect } from 'vitest';
import { LINK_EMBED_CHANNELS, registerLinkEmbedIpc, registerSenderPostMedia, postMediaHostAllowed, type IpcMainLike } from './ipc';
import { MediaRegistry } from './media-registry';

const X_PAGE = 'https://x.com/elonmusk/status/1585341984679469056';
const X_FILE = 'https://video.twimg.com/ext_tw_video/1585341912877146112/pu/vid/1280x720/cwj11yOgYZ05R_sY.mp4?tag=14';
const R_PAGE = 'https://www.reddit.com/r/aww/comments/90bu6w/heat_index/';
const R_FILE = 'https://v.redd.it/zv89llsvexb11/DASH_720.mp4?source=fallback';

describe('registerSenderPostMedia', () => {
    it('an X video and a Reddit video on their own hosts get a clmedia:// URL', () => {
        const registry = new MediaRegistry();
        const x = registerSenderPostMedia(X_PAGE, X_FILE, { registry });
        const r = registerSenderPostMedia(R_PAGE, R_FILE, { registry });
        expect(x.ok && x.src.startsWith('clmedia://')).toBe(true);
        expect(r.ok && r.src.startsWith('clmedia://')).toBe(true);
    });

    it('POSITIVE CONTROL: a file on another host, the other provider\'s host, a non-post page, http, a non-video path: refused', () => {
        const registry = new MediaRegistry();
        const cases: [unknown, unknown][] = [
            [X_PAGE, 'https://evil.example/a.mp4'],
            [X_PAGE, R_FILE],
            [R_PAGE, X_FILE],
            ['https://example.com/watch', X_FILE],
            ['https://medal.tv/clips/abcdef', X_FILE],
            [X_PAGE, X_FILE.replace('https:', 'http:')],
            [X_PAGE, 'https://video.twimg.com/ext_tw_video/1/pu/img/poster.jpg'],
            [X_PAGE, 'https://video.twimg.com.evil.example/a.mp4'],
            [X_PAGE, 'https://user:pw@video.twimg.com/a.mp4'],
            [X_PAGE, 5],
            [7, X_FILE],
        ];
        for (const [page, file] of cases) expect(registerSenderPostMedia(page, file, { registry }), `${page} ${file}`).toEqual({ ok: false });
        expect(registerSenderPostMedia(X_PAGE, X_FILE, {})).toEqual({ ok: false });
    });

    it('the streaming host rule follows redirects too', () => {
        expect(postMediaHostAllowed('x', 'video.twimg.com')).toBe(true);
        expect(postMediaHostAllowed('x', 'pbs.twimg.com')).toBe(false);
        expect(postMediaHostAllowed('reddit', 'v.redd.it')).toBe(true);
        expect(postMediaHostAllowed('reddit', 'i.redd.it')).toBe(false);
    });

    it('is wired on its channel', async () => {
        const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
        const ipc: IpcMainLike = { handle: (c, l) => { handlers.set(c, l); } };
        registerLinkEmbedIpc(ipc, { registry: new MediaRegistry() });
        expect(LINK_EMBED_CHANNELS.registerPostMedia).toBe('embed:register-post-media');
        const res = await handlers.get('embed:register-post-media')!({}, X_PAGE, X_FILE) as { ok: boolean };
        expect(res.ok).toBe(true);
    });
});
