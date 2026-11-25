/* eslint-disable -- harness, not shipped */
// "Size follows the media" + direction C + click-to-enlarge (2026-11-24,
// embeds-media-sizing) in the REAL Electron main + preload + CSP + clmedia://
// (harness/media-sizing-electron.mjs). The API is the loopback stub.
//
//   ?role=build     builds the messages a sender's app would send for the
//                   test media (a TikTok, a YouTube Short, a vertical Medal
//                   clip, a vertical X video, a vertical and a square video
//                   file, a 16:9 YouTube video, a page card, a post picture,
//                   a GIF loop), with REAL pictures (frames of the real videos,
//                   the real YouTube thumbnails, real photos) handed in by the
//                   driver as bytes; every picture goes through the real
//                   thumbnail uploader (AES-256-GCM, uploaded to the stub), as
//                   a sender's does. Image links (a vertical photo, a wide
//                   photo, a .gif) carry no sender preview, as today.
//   ?role=receiver  draws those messages the way ChatPane does (SenderEmbed /
//                   MessageEmbed in a .cl-embed-row), &layout=, &theme=.
import { createRoot } from 'react-dom/client';
import React from 'react';
import { Hash, Users, Pin, Search } from 'lucide-react';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/theme-light-kit.css';
import '../src/styles/layout-drift.css';
import '../src/styles/formatting.css';
import '../src/styles/theme-light.css';
import { loadWebFonts } from '../src/utils/webFonts';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import { MessageEmbed } from '../src/components/embeds/MessageEmbed';
import { SenderEmbed } from '../src/components/embeds/SenderEmbed';
import { senderEmbedsFor } from '../src/components/embeds/senderEmbeds';
import { EmbedPlaybackContext, PlaybackScope } from '../src/components/embeds/embedPlayback';
import { createThumbUploader } from '../src/utils/linkEmbeds/uploadThumb';
import { embedUrlsOf } from '../src/utils/formatting/plainText';
import { API_BASE } from '../src/constants';
import { ToastProvider } from '../src/contexts/ToastContext';
import { setEmbedCompact } from '../src/utils/embedPrefs';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { base64ToBytes } from '../src/utils/linkEmbeds/thumb';

loadWebFonts();
const q = new URLSearchParams(location.search);
engine.applyTheme(themes.resolveTheme(q.get('theme') ?? 'dark'));
const ROLE = q.get('role') ?? 'receiver';
const LAYOUT = (q.get('layout') === 'compact' ? 'compact' : 'expanded') as 'compact' | 'expanded';
try { await secureLocalStore.hydrate(); } catch (e) { console.warn('[harness] hydrate failed', e); }
if (ROLE === 'receiver') setEmbedCompact(LAYOUT === 'compact');
const STUB = API_BASE.replace(/\/v1$/, '');
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE)) throw new Error(`harness: API_BASE must be the loopback stub, got ${API_BASE}`);

const TIKTOK = 'https://www.tiktok.com/@scout2015/video/6718335390845095173';
const SHORT = 'https://youtube.com/shorts/4_owvrzTk9c';
const MEDAL = 'https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt';
const XVID = 'https://x.com/someone/status/1859912345678901234';
const VFILE = 'https://upload.wikimedia.org/wikipedia/commons/5/56/Cr%C3%A8me_br%C3%BBl%C3%A9e.webm';
const SQFILE = 'https://upload.wikimedia.org/wikipedia/commons/d/d9/Mandelbrot_set_deep_zoom_animation_by_Graphiq.webm';
const YT = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const VIMG = 'https://upload.wikimedia.org/wikipedia/commons/1/10/Empire_State_Building_%28aerial_view%29.jpg';
const WIMG = 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/96/Hong_Kong_Skyline_viewed_from_Victoria_Peak.jpg/1280px-Hong_Kong_Skyline_viewed_from_Victoria_Peak.jpg';
const GIFLOOP = 'https://giphy.com/gifs/cat-JIX9t2j0ZTN9S';
const GIFFILE = 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif';
const PAGE = 'https://en.wikipedia.org/wiki/Lake_Bled';
const XPIC = 'https://x.com/someone/status/1859912345678901235';

/** One row per test medium: the text, and the embed a sender's app would attach (built from `pic`). */
const ROWS: { key: string; text: string; embed?: (pic: (name: string) => Promise<any>) => Promise<any> }[] = [
    { key: 'tiktok', text: `this trend ${TIKTOK}`, embed: async (pic) => ({ url: TIKTOK, kind: 'player', player: { provider: 'tiktok', id: '6718335390845095173' }, site: 'TikTok', title: 'Scout, Suki & Stella', author: 'scout2015', thumb: await pic('tiktok') }) },
    { key: 'short', text: `a short ${SHORT}`, embed: async (pic) => ({ url: SHORT, kind: 'player', player: { provider: 'youtube', id: '4_owvrzTk9c' }, site: 'YouTube', title: 'NASA Hired Stunt Pilots to Catch a Capsule. It Crashed #shorts', author: 'Spaceflightpedia', thumb: await pic('yt-short') }) },
    { key: 'medal-vertical', text: `cut a vertical one ${MEDAL}`, embed: async (pic) => ({ url: MEDAL, kind: 'video', site: 'Medal', title: 'Vertical clip for my story', tag: 'Valorant', author: 'jun_tv', media: { url: 'https://cdn.medal.tv/mediac/vertical-demo.mp4', mime: 'video/mp4', width: 1080, height: 1920, duration_s: 12 }, thumb: await pic('creme') }) },
    { key: 'x-vertical', text: `look ${XVID}`, embed: async (pic) => ({ url: XVID, kind: 'post', site: 'X', author: 'Someone', author_handle: '@someone', description: 'shot this on my phone at the expo today', media: { url: 'https://video.twimg.com/ext_tw_video/1859912345678901234/pu/vid/720x1280/demo.mp4', mime: 'video/mp4', width: 720, height: 1280, duration_s: 9 }, thumb: await pic('arin') }) },
    { key: 'file-vertical', text: `dessert ${VFILE}`, embed: async (pic) => ({ url: VFILE, kind: 'video', site: 'upload.wikimedia.org', title: 'Crème brûlée', media: { url: VFILE, mime: 'video/webm', width: 1080, height: 1920, duration_s: 13 }, thumb: await pic('creme') }) },
    { key: 'file-square', text: `square ${SQFILE}`, embed: async (pic) => ({ url: SQFILE, kind: 'video', site: 'upload.wikimedia.org', title: 'Mandelbrot set deep zoom', media: { url: SQFILE, mime: 'video/webm', width: 600, height: 600, duration_s: 60 }, thumb: await pic('mandel') }) },
    { key: 'youtube', text: `the classic ${YT}`, embed: async (pic) => ({ url: YT, kind: 'player', player: { provider: 'youtube', id: 'jNQXAC9IVRw' }, site: 'YouTube', title: 'Me at the zoo', author: 'jawed', thumb: await pic('yt-wide') }) },
    { key: 'image-vertical', text: `view from the top ${VIMG}` },
    { key: 'image-wide', text: `skyline ${WIMG}` },
    { key: 'gif-loop', text: `lol ${GIFLOOP}`, embed: async () => ({ url: GIFLOOP, kind: 'video', site: 'GIPHY', title: 'Cat GIF' }) },
    { key: 'gif-file', text: `same ${GIFFILE}` },
    { key: 'page', text: `going here ${PAGE}`, embed: async (pic) => ({ url: PAGE, kind: 'card', site: 'Wikipedia', title: 'Lake Bled', description: 'Lake Bled is a lake in the Julian Alps of the Upper Carniolan region of northwestern Slovenia.', color: '#3366cc', thumb: await pic('bled') }) },
    { key: 'x-picture', text: `the view ${XPIC}`, embed: async (pic) => ({ url: XPIC, kind: 'post', site: 'X', author: 'Someone', author_handle: '@someone', description: 'top of the Empire State', images: [await pic('empire')] }) },
];

// ── build (the sender's side) ───────────────────────────────────────────────
function Build() {
    (window as any).__build = async (fixtures: Record<string, { b64: string; w: number; h: number }>) => {
        const upload = createThumbUploader({ token: 'harness-token', apiBase: API_BASE, conversationId: '22222222-2222-4222-8222-222222222222' });
        const pic = async (name: string) => {
            const f = fixtures[name];
            const blob = new Blob([base64ToBytes(f.b64) as BlobPart], { type: 'image/jpeg' });
            const up = await upload(blob);
            return { mime: 'image/jpeg', width: f.w, height: f.h, ...up };
        };
        const messages = [];
        for (const r of ROWS) {
            const e = r.embed ? await r.embed(pic) : null;
            messages.push({ type: 'text', text: r.text, client_msg_id: `c-${r.key}`, ...(e ? { embeds: [e] } : {}) });
        }
        await fetch(`${STUB}/harness/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
        return messages.length;
    };
    return <div style={{ color: 'var(--cl-text)', padding: 20 }}>build</div>;
}

// ── receiver ────────────────────────────────────────────────────────────────
const WHO = [{ who: 'Mira', color: '#FF8BA7' }, { who: 'Sam', color: '#6FE3A1' }, { who: 'Jo', color: '#F4B860' }];
function Text({ text }: { text: string }) {
    const parts = text.split(/(https?:\/\/\S+)/g);
    return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <span key={i} style={{ color: 'var(--cl-lume-text)' }}>{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}
function Row({ content, i, scope }: { content: any; i: number; scope: PlaybackScope }) {
    const text: string = content.text ?? '';
    const urls = embedUrlsOf(text);
    const sent = senderEmbedsFor(text, content.embeds, urls);
    const w = WHO[i % WHO.length];
    return (
        <div className="msg-row" data-row={i} data-key={content.client_msg_id?.slice(2)} style={{ display: 'flex', gap: 12, padding: '6px 16px', minWidth: 0 }}>
            <span style={{ width: 40, height: 40, borderRadius: '50%', background: w.color, flex: 'none', marginTop: 2 }} />
            <div data-col style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, color: 'var(--cl-text)', fontSize: 15 }}>{w.who}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--cl-faint)' }}>Today at 9:{String(10 + i).padStart(2, '0')} PM</span>
                </div>
                <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cl-text)', overflowWrap: 'anywhere' }}><Text text={text} /></div>
                <EmbedPlaybackContext.Provider value={scope}>
                    <div className="cl-embed-row flex flex-col gap-1 w-full items-start">
                        {urls.slice(0, 5).map((u, k) => {
                            const e = sent.find((x) => x.url === u);
                            return <div key={k} data-link={u} data-from={e ? 'sender' : 'local'} style={{ display: 'contents' }}>
                                {e ? <SenderEmbed embed={e} /> : <MessageEmbed url={u} />}
                            </div>;
                        })}
                    </div>
                </EmbedPlaybackContext.Provider>
            </div>
        </div>
    );
}
function Receiver() {
    const [msgs, setMsgs] = React.useState<any[] | null>(null);
    const scope = React.useMemo(() => new PlaybackScope(), []);
    React.useEffect(() => {
        (async () => {
            const d = await (await fetch(`${STUB}/harness/message`)).json();
            setMsgs(d.messages ?? []);
            (window as any).__msgs = d.messages ?? [];
        })();
    }, []);
    return (
        <Frame>
            <div id="feed" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
                {msgs?.map((c, i) => <Row key={i} content={c} i={i} scope={scope} />)}
            </div>
            <div style={{ padding: '0 16px 16px' }}>
                <div style={{ height: 44, borderRadius: 22, background: 'var(--cl-surface)', color: 'var(--cl-faint)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message #clips</div>
            </div>
        </Frame>
    );
}

// The app's own chat layout: server rail, channel list, chat, member list from 1280 px (Dashboard's widths).
function paneWidths(W: number) {
    const max = Math.max(500, Math.round(W * 0.35));
    const clampW = (v: number, min: number) => Math.max(min, Math.min(max, v));
    return { left: clampW(0.18 * W, 200), right: clampW(0.2 * W, 240) };
}
const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };
function Frame({ children }: { children: React.ReactNode }) {
    const [W, setW] = React.useState(window.innerWidth);
    React.useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
    const { left, right } = paneWidths(W);
    const showRight = W >= 1280;
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)', fontFamily: 'Nunito, system-ui, sans-serif' }}>
            <nav style={{ width: 72, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 12 }}>
                {[0, 1, 2, 3].map(i => <span key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 1 ? 'var(--cl-lume)' : 'var(--cl-raise)' }} />)}
            </nav>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px' }}>
                <aside style={{ ...card, width: left, flex: 'none', padding: 12, gap: 6 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, padding: '4px 6px 10px' }}>Night Shift</div>
                    {['general', 'clips', 'memes', 'lfg'].map((c) => (
                        <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderRadius: 8, background: c === 'clips' ? 'var(--cl-raise)' : 'transparent', color: c === 'clips' ? 'var(--cl-text)' : 'var(--cl-dim)' }}>
                            <Hash size={15} /> {c}
                        </div>
                    ))}
                </aside>
                <div style={{ width: 10, flex: 'none' }} />
                <main id="chat" className="chat-pane-root" style={{ ...card, flex: 1, minWidth: 0, background: 'var(--cl-abyss)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--cl-border)' }}>
                        <Hash size={17} style={{ color: 'var(--cl-dim)' }} />
                        <span style={{ fontWeight: 800 }}>clips</span>
                        <span style={{ flex: 1 }} />
                        <Pin size={16} style={{ color: 'var(--cl-dim)' }} /><Users size={16} style={{ color: 'var(--cl-dim)' }} /><Search size={16} style={{ color: 'var(--cl-dim)' }} />
                    </div>
                    {children}
                </main>
                {showRight && <div style={{ width: 10, flex: 'none' }} />}
                {showRight && (
                    <aside style={{ ...card, width: right, flex: 'none', padding: 14, gap: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'var(--cl-faint)' }}>ONLINE — 3</div>
                        {WHO.map((m, i) => (
                            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <span style={{ width: 28, height: 28, borderRadius: '50%', background: m.color }} />{m.who}
                            </div>
                        ))}
                    </aside>
                )}
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<ToastProvider>{ROLE === 'build' ? <Build /> : <Receiver />}</ToastProvider>);
(window as unknown as { __ready: boolean }).__ready = true;
