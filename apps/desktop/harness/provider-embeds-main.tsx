/* eslint-disable -- harness, not shipped */
// Link embeds phase 4 (Twitch, X, TikTok, Reddit) in the REAL Electron main +
// preload + CSP (harness/provider-embeds-electron.mjs). Same shape as the
// phase-3 harness (sender-embeds-main.tsx):
//
//   ?role=sender    useComposerEmbeds builds previews of LIVE provider links
//                   through main's unfurler (this device visits them), and
//                   window.__send() runs the real send path (pictures
//                   re-encoded, encrypted, uploaded to the loopback API stub).
//   ?role=receiver  a separate profile draws the rows the way ChatPane does,
//                   &layout=compact|expanded &theme=dark|light, &embeds=off sets
//                   Settings → Privacy → "Show embeds" off (the real setting).
//   ?role=settings  the real Privacy settings pane (the "Show embeds" row).
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
import '../src/styles/settings-descent.css';
import { loadWebFonts } from '../src/utils/webFonts';
import * as engine from '../src/theme/engine';
import * as themes from '../src/theme/themes';
import { MessageEmbed } from '../src/components/embeds/MessageEmbed';
import { SenderEmbed } from '../src/components/embeds/SenderEmbed';
import { senderEmbedsFor } from '../src/components/embeds/senderEmbeds';
import { ComposerEmbedPreviews } from '../src/components/embeds/ComposerEmbedPreviews';
import { EmbedPlaybackContext, PlaybackScope } from '../src/components/embeds/embedPlayback';
import { useComposerEmbeds } from '../src/hooks/useComposerEmbeds';
import { usePrivacySettings, PRIVACY_SETTINGS_CHANGED_EVENT } from '../src/hooks/usePrivacySettings';
import PrivacySettings from '../src/components/PrivacySettings';
import { finalizeEmbeds } from '../src/utils/linkEmbeds/prepare';
import { createThumbUploader } from '../src/utils/linkEmbeds/uploadThumb';
import { bytesToBase64, reencodeThumb } from '../src/utils/linkEmbeds/thumb';
import { embedUrlsOf } from '../src/utils/formatting/plainText';
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
if (ROLE === 'receiver' || ROLE === 'settings') {
    // The real "Show embeds" setting (Settings → Privacy), written where the app keeps it.
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(secureLocalStore.getItem('cipherline_privacy_settings') ?? '{}'); } catch { /* fresh */ }
    secureLocalStore.setItem('cipherline_privacy_settings', JSON.stringify({ ...cur, showEmbeds: q.get('embeds') !== 'off' }));
}
// Flip "Show embeds" the way another usePrivacySettings copy (Settings) does: write + the change event.
(window as any).__setShowEmbeds = (on: boolean) => {
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(secureLocalStore.getItem('cipherline_privacy_settings') ?? '{}'); } catch { /* fresh */ }
    secureLocalStore.setItem('cipherline_privacy_settings', JSON.stringify({ ...cur, showEmbeds: on }));
    window.dispatchEvent(new Event(PRIVACY_SETTINGS_CHANGED_EVENT));
};
const STUB = API_BASE.replace(/\/v1$/, '');
// Never let a harness run talk to a real API: Vite must be started with VITE_API_HOST=127.0.0.1:<stub>.
if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE)) throw new Error(`harness: API_BASE must be the loopback stub, got ${API_BASE}`);

export const SENT_TEXTS = [
    'clip from last night https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR and the whole vod https://www.twitch.tv/videos/2931745878',
    'he is live later https://www.twitch.tv/shroud',
    'lol https://x.com/elonmusk/status/1585341984679469056',
    'two more https://x.com/Interior/status/463440424141459456 https://x.com/JagexWest/status/1154749074500964359',
    'this one https://www.tiktok.com/@scout2015/video/6718335390845095173',
    'aww https://www.reddit.com/r/aww/comments/90bu6w/heat_index_was_110_degrees_so_we_offered_him_a/',
];

// ── sender ──────────────────────────────────────────────────────────────────
function Composer({ text, index }: { text: string; index: number }) {
    const previews = useComposerEmbeds(text, true);
    (window as any).__senders ??= {};
    (window as any).__senders[index] = async () => {
        const t0 = performance.now();
        const prepared = await previews.take(text, 1500);
        const upload = createThumbUploader({ token: 'harness-token', apiBase: API_BASE, conversationId: '22222222-2222-4222-8222-222222222222' });
        const embeds = await finalizeEmbeds(text, prepared, upload, Math.max(300, 1500 - (performance.now() - t0)));
        return { content: { type: 'text', text, ...(embeds.length ? { embeds } : {}) }, ms: Math.round(performance.now() - t0) };
    };
    return (
        <div style={{ padding: '0 16px 8px' }}>
            <ComposerEmbedPreviews embeds={previews} />
            <div className="cl-composer" style={{ minHeight: 40, borderRadius: 20, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', color: 'var(--cl-text)', display: 'flex', alignItems: 'center', padding: '6px 16px', fontSize: 13.5, overflowWrap: 'anywhere' }}>{text}</div>
        </div>
    );
}
function Sender() {
    (window as any).__send = async () => {
        const out = [];
        for (const k of Object.keys((window as any).__senders)) out.push(await (window as any).__senders[k]());
        await fetch(`${STUB}/harness/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: out.map((o) => o.content) }) });
        return out;
    };
    return (
        <Frame>
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {SENT_TEXTS.map((t, i) => <Composer key={i} text={t} index={i} />)}
            </div>
        </Frame>
    );
}

// ── a sample Reddit gallery post (NSFW) the way a sender on a network that
// Reddit does not block would send it: built HERE from small local pictures,
// re-encoded by the real thumb path, inline. Labelled as a sample in the text.
async function sampleRedditGallery(): Promise<any> {
    const pic = async (hue: number) => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 480;
        const g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, 640, 480); grad.addColorStop(0, `hsl(${hue} 60% 55%)`); grad.addColorStop(1, `hsl(${hue + 40} 60% 25%)`);
        g.fillStyle = grad; g.fillRect(0, 0, 640, 480);
        g.fillStyle = 'rgba(255,255,255,.85)'; g.beginPath(); g.moveTo(80, 400); g.lineTo(260, 160); g.lineTo(400, 330); g.lineTo(480, 240); g.lineTo(600, 400); g.fill();
        const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/png'));
        const t = (await reencodeThumb(new Uint8Array(await blob.arrayBuffer()), 320))!;
        return { mime: t.mime, width: t.width, height: t.height, inline_b64: bytesToBase64(new Uint8Array(await t.blob.arrayBuffer())) };
    };
    const url = 'https://www.reddit.com/r/EarthPorn/comments/1abcd2e/three_views_of_the_same_valley/';
    return {
        type: 'text', text: `(sample post, built in the harness) ${url}`,
        embeds: [{ url, kind: 'post', site: 'Reddit', title: 'Three views of the same valley [OC]', author: 'r/EarthPorn', author_handle: 'u/some_hiker',
            published_at: '2026-11-17T17:20:00Z', score: 8421, comments: 212, nsfw: true, images: [await pic(200), await pic(20), await pic(120)] }],
    };
}

// ── receiver ────────────────────────────────────────────────────────────────
const WHO = [{ who: 'Mira', color: '#FF8BA7' }, { who: 'Sam', color: '#6FE3A1' }, { who: 'Jo', color: '#F4B860' }];
function Text({ text }: { text: string }) {
    const parts = text.split(/(https?:\/\/\S+)/g);
    return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <span key={i} className="harness-link" style={{ color: 'var(--cl-lume-text)' }}>{p}</span> : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}
function Row({ content, i, scope }: { content: any; i: number; scope: PlaybackScope }) {
    const text: string = content.text ?? '';
    const urls = embedUrlsOf(text);
    const sent = senderEmbedsFor(text, content.embeds, urls);
    const shown = urls.slice(0, sent.length ? 5 : 3);
    const w = WHO[i % WHO.length];
    return (
        <div className="msg-row" data-row={i} style={{ display: 'flex', gap: 12, padding: '6px 16px', minWidth: 0 }}>
            <span style={{ width: 40, height: 40, borderRadius: '50%', background: w.color, flex: 'none', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, color: 'var(--cl-text)', fontSize: 15 }}>{w.who}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--cl-faint)' }}>Today at 9:{String(10 + i).padStart(2, '0')} PM</span>
                </div>
                <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cl-text)', overflowWrap: 'anywhere' }}><Text text={text} /></div>
                <EmbedPlaybackContext.Provider value={scope}>
                    <div className="cl-embed-row flex flex-col gap-1 w-full items-start">
                        {shown.map((u, k) => {
                            const e = sent.find((x) => x.url === u);
                            return e ? <SenderEmbed key={k} embed={e} /> : <MessageEmbed key={k} url={u} />;
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
            const list = [...(d.messages ?? [])];
            list.push(await sampleRedditGallery());
            // POSITIVE CONTROL: a preview whose player id is another clip than the visible link names.
            list.push({ type: 'text', text: 'forged player https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR', embeds: [{ url: 'https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR', kind: 'player', title: 'FORGED', player: { provider: 'twitch', id: 'clip:SomeoneElsesClipX' } }] });
            setMsgs(list);
            (window as any).__msgs = list;
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

function Settings() {
    const privacy = usePrivacySettings();
    const screenLock: any = { settings: { enabled: false, pinLength: 4, timeoutMinutes: 0, lockOnOsLock: false }, setPin: async () => true, changePin: async () => true, disable: async () => true, setTimeoutMinutes: () => {}, setLockOnOsLock: () => {}, lockNow: () => {} };
    const keybinds: any = { binds: {} };
    return (
        <div style={{ height: '100vh', overflowY: 'auto', background: 'var(--cl-abyss)', color: 'var(--cl-text)', padding: '24px 40px', fontFamily: 'Nunito, system-ui, sans-serif' }}>
            <div className="sd-pane" style={{ maxWidth: 740, margin: '0 auto' }}>
                <PrivacySettings privacy={privacy} screenLock={screenLock} keybinds={keybinds} />
            </div>
        </div>
    );
}

// ── Dashboard-shaped frame (pane widths follow Dashboard's rules) ───────────
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

createRoot(document.getElementById('root')!).render(<ToastProvider>{ROLE === 'sender' ? <Sender /> : ROLE === 'settings' ? <Settings /> : <Receiver />}</ToastProvider>);
(window as unknown as { __ready: boolean }).__ready = true;
