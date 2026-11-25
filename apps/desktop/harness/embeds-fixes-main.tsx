/* eslint-disable -- harness, not shipped */
// Link-embed FIXES (2026-11-23: favicons / letter tiles, Tenor as a GIF at its
// real shape, a card for every website incl. amazon.com and bot walls, every
// provider card with a picture) in the REAL Electron main + preload + CSP
// (harness/embeds-fixes-electron.mjs). Same shape as the phase-4 harness
// (provider-embeds-main.tsx):
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
    'morning https://tenor.com/view/morning-morning-coffee-morning-cat-coffee-cat-bad-hair-cat-gif-3162456205570563299',
    'shopping https://www.amazon.com/ and https://www.amazon.com/dp/B0D1XD1ZV3',
    'reading https://en.wikipedia.org/wiki/Cat https://github.com/electron/electron https://www.bbc.com/news https://www.nytimes.com/',
    'reddit https://www.reddit.com/r/aww/comments/1y332n4/my_new_cat_discovered_the_christmas_tree/ and a text post https://www.reddit.com/r/AskReddit/comments/1y2r0ea/how_would_you_react_if_a_former_resident_of_your/',
    'no-picture sites https://example.com/ https://stackoverflow.com/questions/11227809 https://docs.google.com/document/d/1Ka9vB9ixNMb5HVbeAgLNxOxEaR-CQ_4kMDB3yrRxmAI/edit http://neverssl.com/ https://unreachable-host.invalid/page',
    'providers https://www.youtube.com/watch?v=jNQXAC9IVRw https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt https://clips.twitch.tv/DifficultBumblingHornetPeteZaroll-kszkMZEotS107MhR https://x.com/Interior/status/463440424141459456 https://www.tiktok.com/@scout2015/video/6718335390845095173',
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
            if (q.get('extra') === 'localtenor') {
                // ONLY a bare Tenor link (an older client / previews off): the phase-2 local path.
                const only = [{ type: 'text', text: 'older client, no preview: https://tenor.com/view/morning-morning-coffee-morning-cat-coffee-cat-bad-hair-cat-gif-3162456205570563299' }];
                setMsgs(only); (window as any).__msgs = only; return;
            }
            const list = [...(d.messages ?? [])];
            // The Tenor preview exactly as the PREVIOUS staging build sent it (kind video, no loop flag): still a GIF.
            const tenor = (list[0]?.embeds ?? [])[0];
            if (tenor) list.push({ type: 'text', text: `from staging .275: ${tenor.url}`, embeds: [{ ...tenor, media: tenor.media ? { url: tenor.media.url, mime: tenor.media.mime, width: tenor.media.width, height: tenor.media.height } : undefined }] });
            // A link from an older client / previews off: no sender preview at all, the card is drawn locally.
            list.push({ type: 'text', text: 'from an older client: https://www.bbc.com/news/articles/cr894gjz0j0yo' });
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
