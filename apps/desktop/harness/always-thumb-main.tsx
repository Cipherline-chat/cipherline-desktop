/* eslint-disable -- harness, not shipped */
// "Always a thumbnail" (2026-11-24, embeds-always-thumb) in the REAL Electron
// main + preload + CSP + unfurler + clmedia:// + snapshotter
// (harness/always-thumb-electron.mjs), two profiles = two devices:
//
//   ?role=sender    useComposerEmbeds builds previews of LIVE links through
//                   main (Medal in five URL shapes, two of them clips whose
//                   real thumbnail is a black first frame; a direct .mp4; an
//                   X video; a Twitch clip; a TikTok; a Giphy loop; a page with
//                   no picture; a bot wall). The picture chain runs for real:
//                   frame grabs through clmedia://, snapshots in main, the
//                   designed picture. window.__send() runs the real send path
//                   (pictures re-encoded, encrypted, uploaded to the loopback
//                   stub). window.__sendFast() sends a black-thumbnail Medal
//                   clip BEFORE its frame is grabbed and runs the shipped late
//                   attach (runLateAttach). window.__legacy() builds what
//                   staging .277 sent for such a clip (its black picture,
//                   re-encoded by the real thumb.ts) and a message from an app
//                   with no embeds at all.
//   ?role=receiver  a separate profile applies the messages AND the edits
//                   through the real reader path and draws the rows the way
//                   ChatPane does; &layout=, &theme=.
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
import { ComposerEmbedPreviews } from '../src/components/embeds/ComposerEmbedPreviews';
import { EmbedPlaybackContext, PlaybackScope } from '../src/components/embeds/embedPlayback';
import { useComposerEmbeds, awaitFinalPreview } from '../src/hooks/useComposerEmbeds';
import { finalizeEmbeds, takeAndFinalize } from '../src/utils/linkEmbeds/prepare';
import { reencodeThumb } from '../src/utils/linkEmbeds/thumb';
import { runLateAttach } from '../src/utils/linkEmbeds/lateAttach';
import { createThumbUploader } from '../src/utils/linkEmbeds/uploadThumb';
import { embedUrlsOf } from '../src/utils/formatting/plainText';
import { applyIncomingDmMessages } from '../src/utils/dmInbound';
import { API_BASE } from '../src/constants';
import { ToastProvider } from '../src/contexts/ToastContext';
import { setEmbedCompact } from '../src/utils/embedPrefs';
import { secureLocalStore } from '../src/utils/secureLocalStore';

loadWebFonts();
const q = new URLSearchParams(location.search);
engine.applyTheme(themes.resolveTheme(q.get('theme') ?? 'dark'));
const ROLE = q.get('role') ?? 'receiver';
const LAYOUT = (q.get('layout') === 'compact' ? 'compact' : 'expanded') as 'compact' | 'expanded';
try { await secureLocalStore.hydrate(); } catch (e) { console.warn('[harness] hydrate failed', e); }
if (ROLE === 'receiver') setEmbedCompact(LAYOUT === 'compact');
const STUB = API_BASE.replace(/\/v1$/, '');
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE)) throw new Error(`harness: API_BASE must be the loopback stub, got ${API_BASE}`);

export const SENT_TEXTS = [
    'my clip https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt',
    'short link https://medal.tv/clips/nUci1cDBLkatMF9jV',
    'with invite https://medal.tv/games/valorant/clips/nXtJpyei2S02P1Z2Z?invite=cr-MSxsdkEsMjM0NTY3LA',
    'slug + mobilebypass https://medal.tv/games/minecraft/clips/nUEyPasSnYTjxqpiw/d1337abcdef?mobilebypass=true',
    'the /clip/ shape https://medal.tv/clip/nTRtkRTuFjGCzGbP8',
    'a direct mp4 https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    'x video https://x.com/elonmusk/status/1585341984679469056',
    'twitch https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR',
    'tiktok https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'gif https://giphy.com/gifs/cat-JIX9t2j0ZTN9S',
    'a page with nothing https://example.com/',
    'a bot wall https://stackoverflow.com/questions/11227809',
];
const FAST_TEXT = 'sent before its frame https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt?invite=cr-fast';
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

// ── sender ──────────────────────────────────────────────────────────────────
const upload = () => createThumbUploader({ token: 'harness-token', apiBase: API_BASE, conversationId: '22222222-2222-4222-8222-222222222222' });
(window as any).__chain = {};
function Composer({ text, index }: { text: string; index: number }) {
    const previews = useComposerEmbeds(text, true);
    for (const it of previews.items) if (it.prepared) (window as any).__chain[it.url] = it.prepared.snapshotResult ?? (it.prepared.thumb?.designed ? 'designed' : it.prepared.thumb ? 'provider' : 'none');
    (window as any).__senders ??= {};
    (window as any).__senders[index] = async () => {
        const t0 = performance.now();
        const late: string[] = [];
        const embeds = await takeAndFinalize(text, previews.take, upload(), 1500, (u) => late.push(...u));
        return { content: { type: 'text', text, ...(embeds.length ? { embeds } : {}) }, ms: Math.round(performance.now() - t0), late };
    };
    return (
        <div style={{ padding: '0 16px 8px' }}>
            <ComposerEmbedPreviews embeds={previews} />
            <div className="cl-composer" style={{ minHeight: 34, borderRadius: 18, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', color: 'var(--cl-text)', display: 'flex', alignItems: 'center', padding: '4px 14px', fontSize: 12.5, overflowWrap: 'anywhere' }}>{text}</div>
        </div>
    );
}
function FastComposer() {
    const [text, setText] = React.useState('');
    const previews = useComposerEmbeds(text, true);
    const ref = React.useRef(previews);
    ref.current = previews;
    (window as any).__typeFast = () => setText(FAST_TEXT);
    (window as any).__sendFast = async () => {
        const startedAt = Date.now();
        const late: string[] = [];
        const embeds = await takeAndFinalize(FAST_TEXT, ref.current.take, upload(), 1500, (u) => late.push(...u));
        const content = { type: 'text', text: FAST_TEXT, client_msg_id: 'c-fast', ...(embeds.length ? { embeds } : {}) };
        setText('');
        const sentAt = Date.now();
        const edits: any[] = [];
        const outcome = late.length ? await runLateAttach({ text: FAST_TEXT, sent: embeds, late, startedAt, upload: upload() }, {
            awaitFinal: awaitFinalPreview,
            finalize: finalizeEmbeds,
            findRow: () => ({ id: 'm-fast', content }),
            send: async (e) => { edits.push(e); },
        }) : 'not-late';
        return { content, late, sentPicture: (embeds[0] as any)?.thumb ?? null, outcome, edits, editAfterMs: Date.now() - sentAt };
    };
    return (
        <div style={{ padding: '0 16px 8px' }} data-fast>
            <ComposerEmbedPreviews embeds={previews} />
            <div className="cl-composer" style={{ minHeight: 34, borderRadius: 18, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-lume)', color: 'var(--cl-text)', display: 'flex', alignItems: 'center', padding: '4px 14px', fontSize: 12.5 }}>{text || '(fast composer)'}</div>
        </div>
    );
}
(window as any).__legacy = async () => {
    // What staging .277 sent for a clip whose thumbnail is its black first frame:
    // Medal's real thumbnail bytes (saved live), through the real re-encode.
    const bytes = new Uint8Array(await (await fetch('/electron/unfurl/__fixtures__/live/medal-thumb-black.avif')).arrayBuffer());
    const t = await reencodeThumb(bytes);
    const b64 = t ? btoa(String.fromCharCode(...new Uint8Array(await t.blob.arrayBuffer()))) : '';
    const url = 'https://medal.tv/games/minecraft/clips/nUci1cDBLkatMF9jV';
    const old = {
        type: 'text', text: `from staging .277 ${url}`, client_msg_id: 'c-legacy',
        embeds: [{ url, kind: 'video', site: 'Medal', title: '@elmeriizzz caught walking in the countryside fields', tag: 'Minecraft',
            media: { url: 'https://cdn.medal.tv/mediac/legacy.mp4', mime: 'video/mp4', width: 1280, height: 720, duration_s: 16.08 },
            ...(t ? { thumb: { mime: 'image/webp', width: t.width, height: t.height, inline_b64: b64 } } : {}) }],
    };
    const noEmbeds = { type: 'text', text: 'from an app with no previews https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt', client_msg_id: 'c-noembeds' };
    return { messages: [old, noEmbeds], legacyThumb: t ? { flat: !!t.flat, bytes: t.blob.size, w: t.width, h: t.height } : null };
};
function Sender() {
    (window as any).__send = async () => {
        const out = [];
        for (const k of Object.keys((window as any).__senders)) out.push(await (window as any).__senders[k]());
        return out;
    };
    (window as any).__publish = async (payload: any) => {
        await fetch(`${STUB}/harness/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    };
    return (
        <Frame>
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {SENT_TEXTS.map((t, i) => <Composer key={i} text={t} index={i} />)}
                <FastComposer />
            </div>
        </Frame>
    );
}

// ── receiver ────────────────────────────────────────────────────────────────
const WHO = [{ who: 'Mira', color: '#FF8BA7' }, { who: 'Sam', color: '#6FE3A1' }, { who: 'Jo', color: '#F4B860' }];
function Text({ text }: { text: string }) {
    const parts = text.split(/(https?:\/\/\S+)/g);
    return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <span key={i} className="harness-link" style={{ color: 'var(--cl-lume-text)' }}>{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}
function Row({ row, i, scope }: { row: any; i: number; scope: PlaybackScope }) {
    const content = row.content;
    const text: string = content.text ?? '';
    const urls = embedUrlsOf(text);
    const sent = senderEmbedsFor(text, content.embeds, urls);
    const w = WHO[i % WHO.length];
    return (
        <div className="msg-row" data-row={i} data-id={row.id} data-edited={row.edited ? 'true' : undefined} style={{ display: 'flex', gap: 12, padding: '6px 16px', minWidth: 0 }}>
            <span style={{ width: 40, height: 40, borderRadius: '50%', background: w.color, flex: 'none', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, color: 'var(--cl-text)', fontSize: 15 }}>{w.who}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--cl-faint)' }}>Today at 9:{String(10 + i).padStart(2, '0')} PM</span>
                    {row.edited && <span className="text-[10px] text-cl-faint italic" data-edited-mark>(edited)</span>}
                </div>
                <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cl-text)', overflowWrap: 'anywhere' }}><Text text={text} /></div>
                <EmbedPlaybackContext.Provider value={scope}>
                    <div className="cl-embed-row flex flex-col gap-1 w-full items-start">
                        {urls.slice(0, 5).map((u, k) => {
                            const e = sent.find((x) => x.url === u);
                            return <div key={k} data-link={u} data-from={e ? 'sender' : 'local'} data-sent-thumb={e?.thumb ? (e.thumb.designed ? 'designed' : 'real') : 'none'} style={{ display: 'contents' }}>
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
    const [rows, setRows] = React.useState<any[] | null>(null);
    const scope = React.useMemo(() => new PlaybackScope(), []);
    React.useEffect(() => {
        (async () => {
            const d = await (await fetch(`${STUB}/harness/message`)).json();
            const base = (d.messages ?? []).map((c: any, i: number) => ({ id: c.client_msg_id === 'c-fast' ? 'm-fast' : `m${i}`, content: c, sender_device_id: DEVICE, sender_user_id: USER, timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString() }));
            const edits = (d.edits ?? []).map((c: any, i: number) => ({ id: `e${i}`, content: c, sender_device_id: DEVICE, sender_user_id: USER, timestamp: new Date().toISOString() }));
            const threads = applyIncomingDmMessages({ conv: base } as any, { conv: edits } as any) as any;
            const list = threads.conv;
            setRows(list);
            (window as any).__msgs = list;
        })();
    }, []);
    return (
        <Frame>
            <div id="feed" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
                {rows?.map((r, i) => <Row key={r.id} row={r} i={i} scope={scope} />)}
            </div>
            <div style={{ padding: '0 16px 16px' }}>
                <div style={{ height: 44, borderRadius: 22, background: 'var(--cl-surface)', color: 'var(--cl-faint)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message #clips</div>
            </div>
        </Frame>
    );
}

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

createRoot(document.getElementById('root')!).render(<ToastProvider>{ROLE === 'sender' ? <Sender /> : <Receiver />}</ToastProvider>);
(window as unknown as { __ready: boolean }).__ready = true;
