/* eslint-disable -- harness, not shipped */
// "You're leaving Cipherline" in the REAL dev Electron (main + preload + CSP +
// the encrypted secureLocalStore), driven by harness/leaving-dialog-electron.mjs.
// API pinned to a loopback stub (refuses any other).
//
//   ?role=chat      a channel whose rows go through the real FormattedText
//                   (masked links = the real MaskedLink) and a ChatPane-style
//                   linkify (bare links, shortened, opened via openExternalLink),
//                   with the real LeavingCipherlineHost mounted as in App.tsx.
//   ?role=settings  the real Settings → Privacy pane with the account's
//                   trusted websites seeded through the real trustDomain().
//   &theme=dark|light
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
import { renderFormatted } from '../src/components/formatting/FormattedText';
import { shortenLinkText, shortLinkAnchorProps } from '../src/utils/formatting/linkDisplay';
import { openExternalLink } from '../src/utils/openExternalLink';
import LeavingCipherlineHost from '../src/components/LeavingCipherlineDialog';
import PrivacySettings from '../src/components/PrivacySettings';
import { usePrivacySettings } from '../src/hooks/usePrivacySettings';
import { ToastProvider } from '../src/contexts/ToastContext';
import { AuthProvider } from '../src/contexts/AuthContext';
import { API_BASE } from '../src/constants';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { listTrustedDomains, trustDomain } from '../src/utils/externalLinks/trustedDomains';
import { getLeaveSnapshot } from '../src/utils/externalLinks/leaveGate';
import { getLinkWarningPrefs, setLinkWarningPrefs } from '../src/utils/externalLinks/linkWarningPrefs';

if (!/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(API_BASE)) throw new Error(`harness: API_BASE must be the loopback stub, got ${API_BASE}`);
loadWebFonts();
const q = new URLSearchParams(location.search);
engine.applyTheme(themes.resolveTheme(q.get('theme') ?? 'dark'));
const ROLE = q.get('role') ?? 'chat';
const UID = '33333333-3333-4333-8333-333333333333';

await secureLocalStore.hydrate();
if (secureLocalStore.getItem('cipherline_user_id') !== UID) secureLocalStore.setItem('cipherline_user_id', UID);
await secureLocalStore.whenAccountReady();
// ~60 sites for the long-list shots. None of them covers a chat row's host
// (blog.example.com, paypa1-secure.example, аpple.com, münchen.de), so seeding
// never silences a dialog being shot.
const SEED = [
    'github.com', 'gitlab.com', 'stackoverflow.com', 'wikipedia.org', 'mozilla.org', 'developer.apple.com', 'npmjs.com',
    'rust-lang.org', 'python.org', 'nodejs.org', 'reactjs.org', 'vitejs.dev', 'electronjs.org', 'typescriptlang.org',
    'youtube.com', 'twitch.tv', 'reddit.com', 'steamcommunity.com', 'store.steampowered.com', 'medal.tv', 'spotify.com',
    'soundcloud.com', 'bandcamp.com', 'nytimes.com', 'bbc.co.uk', 'theguardian.com', 'arstechnica.com', 'theverge.com',
    'example.co.uk', 'shop.example.com.au', 'docs.google.com', 'drive.google.com', 'figma.com', 'notion.so', 'linear.app',
    'vercel.com', 'netlify.com', 'cloudflare.com', 'digitalocean.com', 'hetzner.com', 'proton.me', 'signal.org',
    'eff.org', 'archive.org', 'openstreetmap.org', 'duckduckgo.com', 'kagi.com', 'imgur.com', 'giphy.com', 'tenor.com',
    'alice.github.io', 'blog.rust-lang.org', 'xn--bcher-kva.example', 'xn--fiqs8s.cn', 'xn--80ak6aa92e.xn--p1ai',
    '192.168.1.20', '10.0.0.7', 'localhost', 'grafana.home.lan', 'nas.home.lan',
];
if (ROLE === 'settings' && q.get('seed') !== '0') for (const d of SEED) trustDomain(d);
const w = window as any;
w.__openExternalLink = openExternalLink;        // for the crafted-call check (no gesture)
w.__trusted = () => listTrustedDomains();
w.__pending = () => { const r = getLeaveSnapshot(); return r ? { id: r.id, href: r.model.href, kind: r.model.kind, mismatch: r.model.mismatch } : null; };
w.__trust = (d: string) => trustDomain(d);
w.__setPrefs = (p: { warn?: boolean; warnSuspicious?: boolean }) => setLinkWarningPrefs(p);
w.__prefs = () => getLinkWarningPrefs();

const MSGS: Array<{ who: string; color: string; text: string; shot: string }> = [
    { who: 'Mira', color: '#FF8BA7', shot: 'normal', text: 'the write-up I mentioned https://blog.example.com/2026/11/how-we-rebuilt-the-whole-thing-from-scratch?ref=chat&utm_source=cipherline&utm_medium=message' },
    { who: 'Sam', color: '#6FE3A1', shot: 'masked', text: 'your account is on hold, fix it here: [https://paypal.com/account](https://paypa1-secure.example/login?session=8f2a91)' },
    { who: 'Jo', color: '#F4B860', shot: 'idn', text: 'support page https://аpple.com/support/id' },
    // Message text never makes a mailto: link (the parser allows https masked links
    // only), so the mailto row is a harness chip that opens one through the same
    // openExternalLink a profile or embed link would.
    { who: 'Mira', color: '#FF8BA7', shot: 'mailto', text: 'questions? mail us:' },
    { who: 'Sam', color: '#6FE3A1', shot: 'idn-ok', text: 'tickets https://www.münchen.de/veranstaltungen' },
    { who: 'Jo', color: '#F4B860', shot: 'trusted', text: 'release notes https://cipherline.chat/changelog' },
];

const MAILTO = 'mailto:hello@example.org?subject=Hi%20there&body=I%20saw%20your%20post';
const LINK_RE = /https?:\/\/[^\s<>()]+/g;
function linkify(text: string, key: string, ctx: { inLink: boolean }): React.ReactNode {
    if (ctx.inLink) return text;
    const out: React.ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(LINK_RE)) {
        const url = m[0];
        if (m.index! > last) out.push(text.slice(last, m.index));
        const display = shortenLinkText(url);
        const open = (e: React.SyntheticEvent) => { e.stopPropagation(); const r = openExternalLink(url); if (!r.ok) console.warn('[harness] refused', r.reason); };
        out.push(
            <span key={`${key}-${m.index}`} {...shortLinkAnchorProps(url, display)} role="link" tabIndex={0} data-link=""
                onClick={open} onKeyDown={(e) => { if (e.key === 'Enter') open(e); }}
                className="text-cl-lume-text hover:underline underline-offset-2 break-all cursor-pointer">{display.text}</span>,
        );
        last = m.index! + url.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return <React.Fragment key={key}>{out}</React.Fragment>;
}

function Chat() {
    return (
        <Frame>
            <div id="feed" style={{ flex: 1, overflowY: 'auto', padding: '12px 0' }}>
                {MSGS.map((m, i) => (
                    <div key={i} data-row={m.shot} style={{ display: 'flex', gap: 12, padding: '8px 18px' }}>
                        <span style={{ width: 38, height: 38, borderRadius: '50%', background: m.color, flex: 'none' }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 800, fontSize: 14, color: m.color }}>{m.who} <span style={{ color: 'var(--cl-faint)', fontWeight: 600, fontSize: 11.5 }}>Today at 9:{10 + i} PM</span></div>
                            <div style={{ fontSize: 14.5, lineHeight: 1.45, color: 'var(--cl-text)', overflowWrap: 'anywhere' }}>
                                {renderFormatted(m.text, { renderLeaf: linkify })}
                                {m.shot === 'mailto' && (
                                    <> <span role="link" tabIndex={0} data-link="" className="text-cl-lume-text hover:underline cursor-pointer"
                                        onClick={(e) => { e.stopPropagation(); openExternalLink(MAILTO); }}>hello@example.org</span></>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
            <div style={{ padding: '0 16px 16px' }}>
                <div style={{ height: 44, borderRadius: 22, background: 'var(--cl-surface)', color: 'var(--cl-faint)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message #general</div>
            </div>
        </Frame>
    );
}

function Settings() {
    const privacy = usePrivacySettings();
    const screenLock: any = { settings: { enabled: false, pinLength: 4, timeoutMinutes: 0, lockOnOsLock: false }, setPin: async () => true, changePin: async () => true, disable: async () => true, setTimeoutMinutes: () => {}, setLockOnOsLock: () => {}, lockNow: () => {} };
    const keybinds: any = { binds: {} };
    return (
        <div id="settings-scroll" style={{ height: '100vh', overflowY: 'auto', background: 'var(--cl-abyss)', color: 'var(--cl-text)', padding: '24px 40px', fontFamily: 'Nunito, system-ui, sans-serif' }}>
            <div className="sd-pane" style={{ maxWidth: 740, margin: '0 auto' }}>
                <PrivacySettings privacy={privacy} screenLock={screenLock} keybinds={keybinds} />
            </div>
        </div>
    );
}

const card: React.CSSProperties = { background: 'var(--cl-deep)', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 };
function Frame({ children }: { children: React.ReactNode }) {
    const [W, setW] = React.useState(window.innerWidth);
    React.useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);
    const left = Math.max(200, Math.min(Math.max(500, Math.round(W * 0.35)), 0.18 * W));
    return (
        <div id="dash" style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: 'var(--cl-abyss)', color: 'var(--cl-text)', fontFamily: 'Nunito, system-ui, sans-serif' }}>
            <nav style={{ width: 72, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 12 }}>
                {[0, 1, 2, 3].map(i => <span key={i} style={{ width: 44, height: 44, borderRadius: 14, background: i === 1 ? 'var(--cl-lume)' : 'var(--cl-raise)' }} />)}
            </nav>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', padding: '6px 10px 10px 2px' }}>
                <aside style={{ ...card, width: left, flex: 'none', padding: 12, gap: 6 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, padding: '4px 6px 10px' }}>Night Shift</div>
                    {['general', 'clips', 'memes', 'lfg'].map((c) => (
                        <div key={c} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', borderRadius: 8, background: c === 'general' ? 'var(--cl-raise)' : 'transparent', color: c === 'general' ? 'var(--cl-text)' : 'var(--cl-dim)' }}>
                            <Hash size={15} /> {c}
                        </div>
                    ))}
                </aside>
                <div style={{ width: 10, flex: 'none' }} />
                <main id="chat" className="chat-pane-root" style={{ ...card, flex: 1, minWidth: 0, background: 'var(--cl-abyss)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--cl-border)' }}>
                        <Hash size={17} style={{ color: 'var(--cl-dim)' }} />
                        <span style={{ fontWeight: 800 }}>general</span>
                        <span style={{ flex: 1 }} />
                        <Pin size={16} style={{ color: 'var(--cl-dim)' }} /><Users size={16} style={{ color: 'var(--cl-dim)' }} /><Search size={16} style={{ color: 'var(--cl-dim)' }} />
                    </div>
                    {children}
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(
    <ToastProvider>
        <LeavingCipherlineHost />
        {ROLE === 'settings' ? <AuthProvider><Settings /></AuthProvider> : <Chat />}
    </ToastProvider>,
);
w.__ready = true;
