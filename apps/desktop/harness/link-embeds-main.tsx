/* eslint-disable -- harness, not shipped */
// Link embeds (docs/plans/embeds.md phases 1-2) in a chat view: the REAL
// MessageEmbed (YouTube facade, inline video, clip pages, image / GIF, link
// card) under real message text, inside a Dashboard-shaped frame whose pane
// widths follow Dashboard's rules. Meant to run inside the real Electron main
// (harness/link-embeds-electron.mjs) so clmedia://, the embed IPC, the CSP
// and the permission policy are the shipped ones.
//   ?theme=dark|light
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
import { EmbedPlaybackContext, PlaybackScope } from '../src/components/embeds/embedPlayback';
import { embedUrlsOf } from '../src/utils/formatting/plainText';
import { ToastProvider } from '../src/contexts/ToastContext';
import { setEmbedCompact } from '../src/utils/embedPrefs';
import { secureLocalStore } from '../src/utils/secureLocalStore';

loadWebFonts();
const q = new URLSearchParams(location.search);
engine.applyTheme(themes.resolveTheme(q.get('theme') ?? 'dark'));
// ?layout=compact|expanded: the Settings → Appearance → Compact embeds switch,
// through the real store (hydrated first, as main.tsx does before render).
try { await secureLocalStore.hydrate(); } catch (e) { console.warn('[harness] hydrate failed', e); }
setEmbedCompact(q.get('layout') === 'compact');

const MESSAGES: { who: string; color: string; time: string; text: string }[] = [
    { who: 'Alex', color: '#7C9CFF', time: 'Today at 8:02 PM', text: 'ok this is the one I was talking about https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5' },
    { who: 'Mira', color: '#FF8BA7', time: 'Today at 8:03 PM', text: 'my clip from last night 😤 https://medal.tv/games/valorant/clips/nYiYMMGqugp5N9XWt' },
    { who: 'Jo', color: '#F4B860', time: 'Today at 8:05 PM', text: 'raw file works too https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4' },
    { who: 'Sam', color: '#6FE3A1', time: 'Today at 8:06 PM', text: 'https://media1.tenor.com/m/gs59zxSVz8AAAAAC/aww-yeah.gif' },
    { who: 'Mira', color: '#FF8BA7', time: 'Today at 8:06 PM', text: 'gg https://tenor.com/view/aww-yeah-get-over-here-gif-27631439' },
    { who: 'Alex', color: '#7C9CFF', time: 'Today at 8:07 PM', text: 'and a picture https://i.imgur.com/A61SaA1l.jpg' },
    { who: 'Jo', color: '#F4B860', time: 'Today at 8:08 PM', text: 'shorts are vertical now https://www.youtube.com/shorts/dQw4w9WgXcQ' },
    { who: 'Mira', color: '#FF8BA7', time: 'Today at 8:09 PM', text: 'https://streamable.com/moo and the docs https://github.com/electron/electron' },
];

function paneWidths(W: number) {
    const max = Math.max(500, Math.round(W * 0.35));
    const clampW = (v: number, min: number) => Math.max(min, Math.min(max, v));
    return { left: clampW(0.18 * W, 200), right: clampW(0.2 * W, 240) };
}
const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };

function Text({ text }: { text: string }) {
    const parts = text.split(/(https?:\/\/\S+)/g);
    return <>{parts.map((p, i) => /^https?:\/\//.test(p)
        ? <span key={i} style={{ color: 'var(--cl-lume-text)', cursor: 'pointer' }}>{p}</span>
        : <React.Fragment key={i}>{p}</React.Fragment>)}</>;
}

const Row: React.FC<{ m: typeof MESSAGES[number]; scope: PlaybackScope }> = ({ m, scope }) => {
    const urls = embedUrlsOf(m.text).slice(0, 3);
    const bare = /^https?:\/\/\S+$/.test(m.text.trim()) && /\.(gif|jpe?g|png|webp)$/i.test(m.text.trim());
    return (
        <div className="msg-row" style={{ display: 'flex', gap: 12, padding: '6px 16px', minWidth: 0 }}>
            <span style={{ width: 40, height: 40, borderRadius: '50%', background: m.color, flex: 'none', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, color: 'var(--cl-text)', fontSize: 15 }}>{m.who}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--cl-faint)' }}>{m.time}</span>
                </div>
                {!bare && <div style={{ fontSize: 15, lineHeight: '22px', color: 'var(--cl-text)', overflowWrap: 'anywhere' }}><Text text={m.text} /></div>}
                {urls.length > 0 && (
                    <EmbedPlaybackContext.Provider value={scope}>
                        <div className="cl-embed-row flex flex-col gap-1 w-full items-start">
                            {urls.map((u, i) => <MessageEmbed key={i} url={u} />)}
                        </div>
                    </EmbedPlaybackContext.Provider>
                )}
            </div>
        </div>
    );
};

const App: React.FC = () => {
    const [W, setW] = React.useState(window.innerWidth);
    React.useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
    const { left, right } = paneWidths(W);
    const scope = React.useMemo(() => new PlaybackScope(), []);
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
                    <div id="feed" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '8px 0' }}>
                        {MESSAGES.map((m, i) => <Row key={i} m={m} scope={scope} />)}
                    </div>
                    <div style={{ padding: '0 16px 16px' }}>
                        <div style={{ height: 44, borderRadius: 12, background: 'var(--cl-raise)', color: 'var(--cl-faint)', display: 'flex', alignItems: 'center', padding: '0 14px', fontSize: 14 }}>Message #clips</div>
                    </div>
                </main>
                {showRight && <div style={{ width: 10, flex: 'none' }} />}
                {showRight && (
                    <aside style={{ ...card, width: right, flex: 'none', padding: 14, gap: 10 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'var(--cl-faint)' }}>ONLINE — 4</div>
                        {MESSAGES.slice(0, 4).map((m) => (
                            <div key={m.who} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <span style={{ width: 28, height: 28, borderRadius: '50%', background: m.color }} />{m.who}
                            </div>
                        ))}
                    </aside>
                )}
            </div>
        </div>
    );
};

createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
(window as unknown as { __ready: boolean }).__ready = true;
