/* eslint-disable -- harness, not shipped */
// "Media everywhere" (2026-11-24, embeds-media-everywhere) in the REAL Electron
// main + preload + CSP + unfurler + media probe + embed:media-copy + clmedia://
// (harness/media-everywhere-electron.mjs), two profiles = two devices:
//
//   ?role=sender    useComposerEmbeds builds previews of LIVE links through
//                   main: a real Discord CDN GIF (signed ex/is/hm params), the
//                   owner's KLIPY page link, a Tenor page, a Giphy page, an
//                   extensionless image, a direct mp4 on a random host, an
//                   animated WebP, an EXPIRED Discord attachment link (Discord's
//                   real 404) and a broken 404 .gif. window.__send() runs the
//                   real send path (pictures AND the Discord copy re-encoded /
//                   encrypted / uploaded to the loopback stub); a copy whose
//                   upload misses the deadline goes by the shipped late attach.
//                   window.__legacy(): the owner's bug as sent by an app with no
//                   previews (a bare expired Discord GIF link).
//   ?role=receiver  a separate profile applies messages + edits through the
//                   real reader path and draws each row the way ChatPane does,
//                   INCLUDING the bare-link rule (bareMediaLink.ts + the CSS in
//                   formatting.css); &layout=, &theme=.
import { createRoot } from 'react-dom/client';
import React from 'react';
import { Hash } from 'lucide-react';
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
import { runLateAttach } from '../src/utils/linkEmbeds/lateAttach';
import { createThumbUploader } from '../src/utils/linkEmbeds/uploadThumb';
import { setMediaCopyUploadLimit } from '../src/utils/linkEmbeds/mediaCopy';
import { embedUrlsOf } from '../src/utils/formatting/plainText';
import { isBareMediaLinkMessage } from '../src/utils/formatting/bareMediaLink';
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
// The free tier's per-file limit (100 MB): the copy caps (8 / 25 MB) bind.
setMediaCopyUploadLimit(100 * 1024 * 1024);

const SIG = 'ex=6745d2a1&is=67448121&hm=9f3c2e1d0b8a7f6e5d4c3b2a19f8e7d6c5b4a39281f0e9d8c7b6a5f4e3d2c1b0&';
export const SENT_TEXTS = [
    `https://cdn.discordapp.com/emojis/1113579886439833690.gif?size=128&quality=lossless&${SIG}`,
    'https://klipy.com/gifs/livvy-dunne',
    'https://tenor.com/view/morning-morning-coffee-morning-cat-coffee-cat-bad-hair-cat-gif-3162456205570563299',
    'https://giphy.com/gifs/cat-JIX9t2j0ZTN9S',
    'an extensionless image https://www.gravatar.com/avatar/00000000000000000000000000000000?d=identicon&s=128',
    'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    'https://mathiasbynens.be/demo/animated-webp-supported.webp',
    'https://cdn.discordapp.com/attachments/1083749285425856633/1176234513312391178/cat.gif?ex=656a5c4b&is=6557e74b&hm=2b0ef6b2c6b8e63bd3a6e1f2e2c9c54d0f0e0c5c4b3a2a1a0f9e8d7c6b5a4938&',
    'https://mathiasbynens.be/demo/does-not-exist-12345.gif',
];
const DEVICE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const USER = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';

// ── sender ──────────────────────────────────────────────────────────────────
const upload = () => createThumbUploader({ token: 'harness-token', apiBase: API_BASE, conversationId: '22222222-2222-4222-8222-222222222222' });
(window as any).__chain = {};
function Composer({ text, index }: { text: string; index: number }) {
    const previews = useComposerEmbeds(text, true);
    for (const it of previews.items) if (it.prepared) (window as any).__chain[it.url] = { kind: it.prepared.embed.kind, picture: it.prepared.snapshotResult ?? (it.prepared.thumb?.designed ? 'designed' : it.prepared.thumb ? 'provider' : 'none'), copy: it.prepared.copyResult ?? (it.prepared.copyOffer ? 'offered' : null), copyBytes: it.prepared.copy?.blob.size };
    (window as any).__senders ??= {};
    (window as any).__senders[index] = async () => {
        const t0 = performance.now();
        const late: string[] = [];
        const embeds = await takeAndFinalize(text, previews.take, upload(), 1500, (u) => late.push(...u));
        const content: any = { type: 'text', text, client_msg_id: `c${index}`, ...(embeds.length ? { embeds } : {}) };
        const ms = Math.round(performance.now() - t0);
        let edit: any = null;
        let outcome = 'not-late';
        if (late.length) {
            outcome = await runLateAttach({ text, sent: embeds, late, startedAt: Date.now(), upload: upload() }, {
                awaitFinal: awaitFinalPreview,
                finalize: finalizeEmbeds,
                findRow: () => ({ id: `m${index}`, content, send_state: 'sent' }),
                send: async (e) => { edit = e; },
            });
        }
        return { content, ms, late, outcome, edit };
    };
    return (
        <div style={{ padding: '0 16px 8px' }}>
            <ComposerEmbedPreviews embeds={previews} />
            <div className="cl-composer" style={{ minHeight: 34, borderRadius: 18, background: 'var(--cl-surface)', border: '1.5px solid var(--cl-border)', color: 'var(--cl-text)', display: 'flex', alignItems: 'center', padding: '4px 14px', fontSize: 12.5, overflowWrap: 'anywhere' }}>{text}</div>
        </div>
    );
}
(window as any).__legacy = async () => ({
    // The owner's report as an app with NO previews sent it: a bare expired Discord GIF link.
    messages: [{ type: 'text', text: 'https://cdn.discordapp.com/attachments/1083749285425856633/1176234513312391178/cat.gif?ex=656a5c4b&is=6557e74b&hm=2b0ef6b2c6b8e63bd3a6e1f2e2c9c54d0f0e0c5c4b3a2a1a0f9e8d7c6b5a4938&', client_msg_id: 'c-legacy' }],
});
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
            </div>
        </Frame>
    );
}

// ── receiver ────────────────────────────────────────────────────────────────
const WHO = [{ who: 'Mira', color: '#FF8BA7' }, { who: 'Sam', color: '#6FE3A1' }, { who: 'Jo', color: '#F4B860' }];
function Text({ text }: { text: string }) {
    const parts = text.split(/(https?:\/\/\S+)/g);
    return <>{parts.map((p, i) => /^https?:\/\//.test(p) ? <a key={i} href={p} className="harness-link" style={{ color: 'var(--cl-lume-text)' }} onClick={(e) => e.preventDefault()}>{p}</a> : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}
function Row({ row, i, scope }: { row: any; i: number; scope: PlaybackScope }) {
    const content = row.content;
    const text: string = content.text ?? '';
    const urls = embedUrlsOf(text);
    const sent = senderEmbedsFor(text, content.embeds, urls);
    const w = WHO[i % WHO.length];
    // ChatPane's rule (bareMediaLink.ts): a bare picture link's text is wrapped, and the CSS
    // in formatting.css hides it only while its picture really rendered.
    const bare = isBareMediaLinkMessage(text, content.embeds);
    const body = <div className="cl-msg-body" data-text style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cl-text)', overflowWrap: 'anywhere' }}><Text text={text} /></div>;
    return (
        <div className="msg-row" data-row={i} data-id={row.id} data-edited={row.edited ? 'true' : undefined} style={{ display: 'flex', gap: 12, padding: '6px 16px', minWidth: 0 }}>
            <span style={{ width: 40, height: 40, borderRadius: '50%', background: w.color, flex: 'none', marginTop: 2 }} />
            <div className="cl-msg-col" style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, color: 'var(--cl-text)', fontSize: 15 }}>{w.who}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--cl-faint)' }}>Today at 9:{String(10 + i).padStart(2, '0')} PM</span>
                    {row.edited && <span className="text-[10px] text-cl-faint italic" data-edited-mark>(edited)</span>}
                </div>
                {bare ? <div className="cl-bare-media-text">{body}</div> : body}
                <EmbedPlaybackContext.Provider value={scope}>
                    <div className="cl-embed-row flex flex-col gap-1 w-full items-start">
                        {urls.slice(0, 5).map((u, k) => {
                            const e = sent.find((x) => x.url === u);
                            return <div key={k} data-link={u} data-from={e ? 'sender' : 'local'} data-kind={e?.kind} data-copy-attached={e?.media?.file ? 'yes' : 'no'} style={{ display: 'contents' }}>
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
            const base = (d.messages ?? []).map((c: any, i: number) => ({ id: `m${i}`, content: c, sender_device_id: DEVICE, sender_user_id: USER, timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString() }));
            const edits = (d.edits ?? []).map((c: any, i: number) => ({ id: `e${i}`, content: c, sender_device_id: DEVICE, sender_user_id: USER, timestamp: new Date().toISOString() }));
            const threads = applyIncomingDmMessages({ conv: base } as any, { conv: edits } as any) as any;
            setRows(threads.conv);
            (window as any).__msgs = threads.conv;
        })();
    }, []);
    return (
        <Frame>
            <div id="feed" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
                {rows?.map((r, i) => <Row key={r.id} row={r} i={i} scope={scope} />)}
            </div>
        </Frame>
    );
}

function Frame({ children }: { children: React.ReactNode }) {
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)', fontFamily: 'Nunito, system-ui, sans-serif' }}>
            <nav style={{ width: 72, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 12 }}>
                {[0, 1, 2, 3].map(i => <span key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 1 ? 'var(--cl-lume)' : 'var(--cl-raise)' }} />)}
            </nav>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px' }}>
                <aside style={{ background: 'var(--cl-deep)', borderRadius: 16, width: 240, flex: 'none', padding: 12 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, padding: '4px 6px 10px' }}>Night Shift</div>
                    {['general', 'gifs'].map((c) => <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', color: c === 'gifs' ? 'var(--cl-text)' : 'var(--cl-dim)' }}><Hash size={15} /> {c}</div>)}
                </aside>
                <div style={{ width: 10, flex: 'none' }} />
                <main id="chat" className="chat-pane-root" style={{ background: 'var(--cl-abyss)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
                    {children}
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<ToastProvider>{ROLE === 'sender' ? <Sender /> : <Receiver />}</ToastProvider>);
(window as unknown as { __ready: boolean }).__ready = true;
