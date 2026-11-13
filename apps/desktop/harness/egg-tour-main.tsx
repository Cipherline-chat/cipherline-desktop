/* eslint-disable -- visual harness, not shipped */
import './easter-eggs-clock';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/dialog-frame.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { secureLocalStore } from '../src/utils/secureLocalStore';
import { ToastProvider } from '../src/contexts/ToastContext';
import { MomentHost } from '../src/components/moments/MomentHost';
import { KeysParty } from '../src/components/KeysParty';
import { FirstFriendCelebration } from '../src/components/FirstFriendCelebration';
import { TitleBarWordmark } from '../src/components/TitleBarWordmark';
import { EggProgressHost } from '../src/components/EggProgressHost';
import { AchievementsHost } from '../src/components/AchievementsHost';
import { AchievementsSheet } from '../src/components/profile/AchievementsPanel';
import { requestMoment, MOMENTS, type MomentId, type MomentContext } from '../src/utils/moments';
import { EGG_LEDGER_KEY } from '../src/utils/easterEggs';
import { eggTierFor, recordEggFound, type EggId } from '../src/utils/eggProgress';
import { getTracker, subscribeBind } from '../src/utils/achievements/tracker';
import { ACHIEVEMENT_UNLOCK_EVENT } from '../src/utils/achievements/keys';

/**
 * A new user's first days, in one page: the REAL MomentHost, KeysParty, EggProgressHost (Egg hunter
 * tier toast), AchievementsHost (tracker + unlock toast) and the achievements sheet, over a static
 * stand-in of the app. Only the network (axios adapter) and useAuth (egg-tour-auth-stub.ts, an
 * account created an hour ago) are fake.
 *
 *   ?scene=play    window.__play(id)        a full-screen moment, as its trigger asks for it
 *                  window.__konami()        the Konami Keys party (what EggLayer mounts)
 *                  window.__confetti()      the first-friend celebration (the real FirstFriendCelebration
 *                                           Dashboard mounts) + the egg it records
 *                  window.__find(id)        recordEggFound(id), as every egg's call site does
 *                  window.__message()       the tracker's noteMessage (ChatPane: the server accepted one)
 *                  window.__setProfile({})  the account changes its profile (avatar, banner, ...; refreshProfile)
 *                  window.__call(ms)        connected-call time credited to the tracker
 *                  (the title bar's "Cipherline" wordmark is the real one: 10 quick clicks = the lap egg)
 *   ?scene=sheet   the achievements "View all" sheet (real AchievementsSheet) for this account,
 *                  after the same starter actions; window.__unlocked lists what the tracker unlocked
 *   ?date=<ISO>    freezes the clock (harness/easter-eggs-clock.ts)
 *
 * window.__posts records every request body the network saw.
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'play';

const unlockedServer = new Map<string, string>();
(window as any).__posts = [] as unknown[];
axios.defaults.adapter = async (config: any) => {
    const url = String(config.url);
    const method = String(config.method).toUpperCase();
    const ok = (data: unknown) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
    (window as any).__posts.push(`${method} ${url} ${config.data ?? ''}`);
    if (/\/profile\/eggs$/.test(url)) {
        const body = JSON.parse(String(config.data));
        const count = new Set(body.ids).size;
        const t = eggTierFor(count);
        return ok({ tier: t?.tier ?? 0, tier_name: t?.name ?? null, count });
    }
    if (/\/achievements\/me$/.test(url) && method === 'PUT') {
        const body = JSON.parse(String(config.data));
        for (const id of body.ids) if (!unlockedServer.has(id)) unlockedServer.set(id, '2026-11');
        return ok({ unlocked: [...unlockedServer].map(([id, month]) => ({ id, month })) });
    }
    if (/\/users\/[^/]+\/achievements$/.test(url)) return ok({ unlocked: [...unlockedServer].map(([id, month]) => ({ id, month })) });
    // Own-device slot sync and anything else: nothing stored yet (sync is best-effort and swallows this).
    const err: any = new Error('harness: 404 ' + url);
    err.response = { status: 404, data: {} };
    throw err;
};

(window as any).__reset = () => secureLocalStore.setItem(EGG_LEDGER_KEY, '{}');
(window as any).__play = (id: MomentId, ctx?: MomentContext) => requestMoment(id, ctx);
(window as any).__find = (id: EggId) => recordEggFound(id);
(window as any).__message = () => getTracker()?.noteMessage(null);
(window as any).__verify = (peer: string) => getTracker()?.noteVerified(peer);
(window as any).__call = (ms: number) => {
    const t = getTracker();
    if (!t) return;
    t.signalCall({ id: 'harness-call', connected: true, people: 2, isHost: true });
    // tick() caps each step at 90 s; walk the clock forward in 30 s steps like the host's interval.
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    for (let done = 0; done < ms; done += 30_000) { offset += 30_000; t.tick(); }
    t.signalCall(null);
};
(window as any).__unlocks = [] as string[];
window.addEventListener(ACHIEVEMENT_UNLOCK_EVENT, (e) => (window as any).__unlocks.push((e as CustomEvent).detail.id));
subscribeBind(() => { (window as any).__trackerReady = !!getTracker(); });

/**
 * A BUSY, realistic stand-in for the app under Dashboard's real title bar markup + wordmark: a server
 * rail, a channel list with a live voice channel, a full chat with names, text, a reply, an image and
 * reactions, a member list and the composer. The eggs are photographed over this, so whether the dim
 * does its job (the egg reads as a moment, not art floating over chat) is visible in every frame.
 */
const AV = ['#25E0C8', '#FF6B5E', '#FFC94D', '#5E8EE0', '#4ADE80', '#C38FFF', '#FF8FB1'];
const Av: React.FC<{ name: string; size?: number; i: number }> = ({ name, size = 36, i }) => (
    <div style={{ width: size, height: size, borderRadius: '50%', flex: 'none', background: AV[i % AV.length], color: '#0B0F1E', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: size * 0.42 }}>{name[0]}</div>
);
const MSGS: Array<{ who: string; i: number; t: string; text: string; img?: boolean; react?: string[]; reply?: string }> = [
    { who: 'Sam', i: 1, t: '7:02 PM', text: 'ok who is actually coming saturday, I need a headcount for the booking' },
    { who: 'Priya', i: 2, t: '7:03 PM', text: 'me! bringing the speaker again unless someone objects', react: ['🙋 3', '🔊 1'] },
    { who: 'Jonah', i: 3, t: '7:05 PM', text: 'I can do after 4, the morning is my sister’s thing' },
    { who: 'Sam', i: 1, t: '7:06 PM', text: 'perfect. here’s the place, parking is round the back', img: true },
    { who: 'Mara', i: 5, t: '7:09 PM', text: 'that looks great. do they do food or do we bring stuff?', reply: 'Sam: here’s the place, parking is round the back' },
    { who: 'Priya', i: 2, t: '7:11 PM', text: 'they do pizza, I checked last time. the garlic knots are elite', react: ['🍕 4', '💯 2'] },
    { who: 'Jonah', i: 3, t: '7:14 PM', text: 'garlic knots confirmed. also can someone send the playlist link again' },
];
const Backdrop: React.FC = () => (
    <>
    <div className="drag-region h-[34px] w-full shrink-0 flex items-center px-3 bg-cl-abyss" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1 }}>
        <TitleBarWordmark />
    </div>
    <div style={{ position: 'fixed', inset: '34px 0 0 0', display: 'flex', background: 'var(--cl-abyss)', fontFamily: 'Nunito, sans-serif', color: 'var(--cl-text)' }}>
        <div style={{ width: 72, background: '#080B17', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 12, gap: 10 }}>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: 'var(--cl-lume)' }} />
            <div style={{ width: 28, height: 2, background: 'var(--cl-border)' }} />
            {['W', 'G', 'D', 'B', 'M'].map((c, i) => (
                <div key={c} style={{ position: 'relative', width: 44, height: 44, borderRadius: i === 0 ? 14 : 22, background: AV[(i + 2) % AV.length], color: '#0B0F1E', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {c}{i === 1 && <span style={{ position: 'absolute', right: -3, bottom: -3, minWidth: 18, height: 18, borderRadius: 9, background: 'var(--cl-flash)', color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '3px solid #080B17' }}>4</span>}
                </div>
            ))}
        </div>
        <div style={{ width: 240, background: 'var(--cl-deep)', padding: '14px 10px', color: 'var(--cl-muted)', fontSize: 14 }}>
            <div style={{ fontFamily: 'Fredoka', fontWeight: 600, color: 'var(--cl-text)', fontSize: 16, padding: '0 6px 12px', borderBottom: '1px solid var(--cl-border)', marginBottom: 10 }}>Weekend crew</div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', padding: '6px 6px' }}>TEXT CHANNELS</div>
            {['general', 'plans', 'memes', 'music', 'photos'].map((c, i) => (
                <div key={c} style={{ padding: '6px 8px', borderRadius: 8, background: i === 1 ? 'var(--cl-raise)' : undefined, color: i === 1 || i === 2 ? 'var(--cl-text)' : undefined, fontWeight: i === 2 ? 800 : 600 }}># {c}</div>
            ))}
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', padding: '12px 6px 6px' }}>VOICE</div>
            <div style={{ padding: '6px 8px', color: 'var(--cl-text)' }}>🔊 Hangout</div>
            {['Priya', 'Jonah', 'Mara'].map((n, i) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px 4px 28px' }}><Av name={n} i={i + 2} size={22} />{n}</div>
            ))}
            <div style={{ padding: '6px 8px' }}>🔊 Gaming</div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ height: 52, borderBottom: '1px solid var(--cl-border)', display: 'flex', alignItems: 'center', gap: 12, padding: '0 20px', fontFamily: 'Fredoka', fontWeight: 600 }}>
                # plans <span style={{ fontFamily: 'Nunito', fontWeight: 600, fontSize: 13, color: 'var(--cl-muted)' }}>Saturday, the booking, who brings what</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: '0 20px 12px', gap: 14 }}>
                {MSGS.map((m, k) => (
                    <div key={k} style={{ display: 'flex', gap: 12 }}>
                        <Av name={m.who} i={m.i} />
                        <div style={{ minWidth: 0 }}>
                            {m.reply && <div style={{ fontSize: 12, color: 'var(--cl-muted)', marginBottom: 2 }}>↪ {m.reply}</div>}
                            <div style={{ fontSize: 14 }}><b style={{ color: AV[m.i % AV.length] }}>{m.who}</b> <span style={{ fontSize: 11, color: 'var(--cl-faint)', marginLeft: 6 }}>{m.t}</span></div>
                            <div style={{ fontSize: 14.5, color: '#DCE3F5', marginTop: 2 }}>{m.text}</div>
                            {m.img && <div style={{ marginTop: 6, width: 260, height: 120, borderRadius: 12, background: 'linear-gradient(135deg,#2B4C7E,#1D7A72 60%,#E3B04B)' }} />}
                            {m.react && <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>{m.react.map(r => <span key={r} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 10, background: 'var(--cl-surface)', border: '1px solid var(--cl-border)' }}>{r}</span>)}</div>}
                        </div>
                    </div>
                ))}
            </div>
            <div style={{ margin: '0 20px 18px', height: 46, borderRadius: 14, background: 'var(--cl-surface)', color: 'var(--cl-faint)', display: 'flex', alignItems: 'center', padding: '0 16px', fontSize: 14 }}>Message #plans…</div>
        </div>
        <div style={{ width: 210, background: 'var(--cl-deep)', padding: '16px 12px', fontSize: 14, color: 'var(--cl-muted)' }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', marginBottom: 8 }}>ONLINE — 5</div>
            {['Sam', 'Priya', 'Jonah', 'Mara', 'You'].map((n, i) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', color: 'var(--cl-text)' }}><Av name={n} i={i + 1} size={30} />{n}</div>
            ))}
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', margin: '14px 0 8px' }}>OFFLINE — 3</div>
            {['Theo', 'Rin', 'Alex'].map((n, i) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', opacity: .5 }}><Av name={n} i={i + 4} size={30} />{n}</div>
            ))}
        </div>
    </div>
    </>
);

const reducedNow = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const Play: React.FC = () => {
    const [party, setParty] = useState(0);
    const [confetti, setConfetti] = useState(0);
    const endConfetti = React.useCallback(() => setConfetti(0), []);
    const endParty = React.useCallback(() => setParty(0), []);
    useEffect(() => {
        (window as any).__konami = () => { setParty(n => n + 1); recordEggFound('konami'); };
        (window as any).__confetti = () => { setConfetti(n => n + 1); recordEggFound('first-friend'); };
    }, []);
    return (
        <>
            <Backdrop />
            {party > 0 && <KeysParty key={party} reduced={reducedNow()} onDone={endParty} />}
            {confetti > 0 && <FirstFriendCelebration key={confetti} onDone={endConfetti} />}
            <MomentHost random={() => 0} />
        </>
    );
};

/** The "View all" sheet as the profile card shows it, fed from this account's tracker. */
const Sheet: React.FC = () => {
    const [ready, setReady] = useState(false);
    useEffect(() => subscribeBind(() => setReady(!!getTracker())), []);
    const [, bump] = useState(0);
    useEffect(() => getTracker()?.subscribe(() => bump(n => n + 1)), [ready]);
    const t = getTracker();
    const unlocked = t ? t.unlockedIds().map(id => ({ id, month: t.getState().unlocked[id] })) : [];
    (window as any).__unlocked = unlocked.map(u => u.id);
    return (
        <div style={{ minHeight: '100vh', background: 'var(--cl-abyss)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 40, fontFamily: 'Nunito, sans-serif' }}>
            <div className="pcd" data-testid="sheet-card" style={{ width: 340, background: 'var(--cl-deep, #131A30)', border: '1px solid var(--cl-border)', borderRadius: 18, padding: '14px 16px 18px', color: 'var(--cl-text)' }}>
                {ready && <AchievementsSheet key={unlocked.length} data={{ unlocked }} loading={false} error={false} isSelf onBack={() => undefined} />}
            </div>
        </div>
    );
};

const App: React.FC = () => (
    <ToastProvider>
        {scene === 'sheet' ? <Sheet /> : <Play />}
        <EggProgressHost />
        <AchievementsHost />
    </ToastProvider>
);

(async () => {
    await secureLocalStore.hydrate();
    createRoot(document.getElementById('root')!).render(<App />);
    (window as any).__ids = Object.keys(MOMENTS);
})();
