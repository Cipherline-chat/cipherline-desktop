/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import React, { useSyncExternalStore } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import '../src/utils/clPhysics';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import { loadWebFonts } from '../src/utils/webFonts';
import { ParticipantRowShell, ParticipantTileShell } from '../src/components/call/ParticipantCard';
import { JoiningCallView, RingingTile } from '../src/components/call/JoiningCallView';
import { PresenceRoster, PresenceMotion, PresenceEnter } from '../src/components/call/presenceMotion';
import {
    presenceExitContext, CALL_CARD_ENTER, CALL_CARD_EXIT, CALL_EASE_ENTER, CALL_EASE_EXIT, CALL_EASE_GLIDE, CALL_GLIDE_S,
} from '../src/components/call/presenceVariants';
import { callPresenceTracker, presenceNow } from '../src/utils/callPresenceLifecycle';

/**
 * Call join / leave animations — the REAL presence layer (utils/callPresenceLifecycle +
 * components/call/presenceMotion) and the REAL row / tile shells (ParticipantRowShell /
 * ParticipantTileShell, what ParticipantCard renders through; JoiningCallView), wired the way
 * ServerContextPanel (huddle card + rows) and SidebarConference (in-call rows, DM / group grid,
 * fullscreen cells) wire them. SidebarConference itself needs a live LiveKit room, so its tree is
 * mirrored here with the same AnimatePresence modes, variants, keys and surfaces.
 *
 *   window.__set(ids)        set the roster of BOTH the server card and the in-call views
 *   window.__ring(bool)      DM ringing tile (shown while nobody else is in)
 *   window.__layout(name)    'side' | 'fs'   — switch the in-call view to the fullscreen grid and back
 *   window.__reparent()      move the in-call grid's DOM node to another parent (portal-root move)
 *   window.__self(bool)      show / hide the instant-join view (your own join)
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const TOKEN = 'harness-token';
const PEOPLE: Record<string, { name: string; avatar: string }> = {
    me: { name: 'Dawson', avatar: 'img-me' },
    mira: { name: 'Mira', avatar: 'img-mira' },
    jun: { name: 'Jun', avatar: 'img-jun' },
    sana: { name: 'Sana', avatar: 'img-sana' },
    okoye: { name: 'Okoye', avatar: 'img-okoye' },
    kenji: { name: 'Kenji', avatar: 'img-kenji' },
};
const person = (id: string) => PEOPLE[id] ?? { name: id, avatar: 'img-zara' };

// A tiny store standing in for LiveKit's roster / the server's presence.
let state = {
    ids: (q.get('ids') ?? 'me,mira').split(',').filter(Boolean),
    ring: q.get('ring') === '1',
    layout: (q.get('layout') ?? 'side') as 'side' | 'fs',
    self: q.get('self') === '1',
    grid: q.get('grid') ?? 'dm',   // 'dm' tile grid | 'rows' voice-channel rows
};
const subs = new Set<() => void>();
const set = (patch: Partial<typeof state>) => { state = { ...state, ...patch }; subs.forEach(f => f()); };
const useStore = () => useSyncExternalStore(cb => { subs.add(cb); return () => subs.delete(cb); }, () => state);
(window as any).__set = (ids: string[]) => set({ ids });
(window as any).__ring = (ring: boolean) => set({ ring });
(window as any).__layout = (layout: 'side' | 'fs') => set({ layout });
(window as any).__self = (self: boolean) => set({ self });
(window as any).__reparent = () => {
    const node = document.getElementById('incall-grid')!;
    const a = document.getElementById('root-a')!, b = document.getElementById('root-b')!;
    (node.parentElement === a ? b : a).appendChild(node);
};

const tileVariants = {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.2, ease: CALL_EASE_ENTER } },
    exit: { opacity: 0, transition: { duration: 0.14, ease: CALL_EASE_EXIT } },
};

const Row = ({ id }: { id: string }) => (
    <ParticipantRowShell userId={id} displayName={person(id).name + (id === 'me' ? ' (you)' : '')} avatarId={person(id).avatar} token={TOKEN} speaking={false} silenced={false} />
);

/** ServerContextPanel: the huddle-call card (AnimatePresence = first join / last leave) + PresenceRoster rows. */
const ServerCard = () => {
    const s = useStore();
    return (
        <section className="h-panel" data-panel="server">
            <h3>Server sidebar · Calls channel</h3>
            <AnimatePresence initial={false} mode="popLayout">
                {s.ids.length > 0 && (
                    <motion.div key="call" initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0, transition: CALL_CARD_ENTER }}
                        exit={{ opacity: 0, y: -6, transition: CALL_CARD_EXIT }}>
                        <div className="rounded-t-lg rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]" data-card>
                            <div className="px-3 py-2 text-[12px] text-cl-lume font-semibold">Hangout · {s.ids.length} in call</div>
                            <div className="flex flex-col w-full">
                                <PresenceRoster ids={s.ids} rowClassName="w-full" renderRow={id => <div data-row={id}><Row id={id} /></div>} />
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
            <div className="h-below">Voice Channels…</div>
        </section>
    );
};

/** SidebarConference mirror: DM / group tile grid, voice rows, fullscreen grid — one tracker per call. */
const InCall = () => {
    const s = useStore();
    const tracker = callPresenceTracker('harness-call', { selfJoinIds: [] });
    tracker.observe(s.ids, presenceNow());
    const exitCtx = React.useMemo(() => presenceExitContext(tracker), [tracker]);
    const others = s.ids.filter(i => i !== 'me');
    if (s.layout === 'fs') {
        return (
            <div className="fs" data-panel="fs">
                <div className="w-full h-full grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(3, s.ids.length)}, minmax(0,1fr))` }}>
                    {s.ids.map(id => (
                        <PresenceEnter key={`audio-${id}`} pid={id} surface="fs" tracker={tracker}
                            className="rounded-xl overflow-hidden flex items-center justify-center bg-cl-abyss border border-cl-border/30">
                            <span data-tile={id}><ParticipantTileShell userId={id} displayName={person(id).name} avatarId={person(id).avatar} token={TOKEN} sizeMode="normal" compact={false} speaking={false} dimmed={false} /></span>
                        </PresenceEnter>
                    ))}
                </div>
            </div>
        );
    }
    if (s.grid === 'rows') {
        return (
            <div id="incall-grid" data-panel="rows">
                <div className="rounded-b-xl overflow-hidden bg-white/[0.04] border-x border-b border-white/[0.07]">
                    <div className="flex flex-col w-full">
                        <AnimatePresence initial={false} custom={exitCtx}>
                            {s.ids.map(id => (
                                <PresenceMotion key={id} pid={id} surface="audio" kind="row" tracker={tracker} className="w-full">
                                    <div data-row={id}><Row id={id} /></div>
                                </PresenceMotion>
                            ))}
                        </AnimatePresence>
                    </div>
                </div>
                <div className="h-below">Search…</div>
            </div>
        );
    }
    return (
        <div id="incall-grid" data-panel="dm" className="flex-1 flex flex-row flex-wrap justify-center items-center content-center gap-x-8 gap-y-6" style={{ minHeight: 260 }}>
            <AnimatePresence mode="popLayout" initial={false} custom={exitCtx}>
                {s.ids.map(id => (
                    <PresenceMotion key={id} pid={id} surface="audio" tracker={tracker} layout
                        variants={tileVariants}
                        transition={{ layout: { duration: CALL_GLIDE_S, ease: CALL_EASE_GLIDE } }}>
                        <span data-tile={id}><ParticipantTileShell userId={id} displayName={person(id).name} avatarId={person(id).avatar} token={TOKEN} sizeMode="normal" compact={false} speaking={false} dimmed={false} /></span>
                    </PresenceMotion>
                ))}
                {s.ring && others.length === 0 && (
                    <motion.div key="ringing-tile" layout transition={{ layout: { duration: CALL_GLIDE_S, ease: CALL_EASE_GLIDE } }}
                        variants={tileVariants} initial="initial" animate="animate" exit="exit">
                        <span data-tile="ringing"><RingingTile title="Mira" avatarId="img-mira" userId="mira" isGroup={false} token={TOKEN} /></span>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

const Self = () => {
    const s = useStore();
    if (!s.self) return null;
    return (
        <section className="h-panel" data-panel="self">
            <h3>Your own join (instant-join view)</h3>
            <JoiningCallView layout={s.grid === 'rows' ? 'rows' : 'tiles'} token={TOKEN}
                self={{ userId: 'me', name: 'Dawson', avatarId: 'img-me', muted: false, deafened: false }}
                peers={[]} ringing={s.grid === 'rows' ? null : { title: 'Mira', avatarId: 'img-mira', userId: 'mira', isGroup: false }} />
        </section>
    );
};

const Scene = () => (
    <div className="scene">
        <ServerCard />
        <section className="h-panel" data-panel="incall">
            <h3>In call · {state.grid === 'rows' ? 'voice rows' : 'DM / group grid'}</h3>
            <div id="root-a" className="root-slot" />
            <div id="root-b" className="root-slot alt" />
        </section>
        <Self />
    </div>
);

const InCallPortal = () => {
    // Render the in-call view into #root-a (a stand-in for #call-sidebar-root) via a portal,
    // so __reparent can move its node the way Dashboard moves the call roots.
    const [host] = React.useState(() => document.createElement('div'));
    React.useLayoutEffect(() => { document.getElementById('root-a')!.appendChild(host); }, [host]);
    return createPortal(<InCall />, host);
};


const css = document.createElement('style');
css.textContent = `
body{margin:0;background:#0B0F1E;font-family:Nunito,sans-serif;color:#A7B3D4}
.scene{display:flex;gap:16px;padding:16px;align-items:flex-start}
.h-panel{width:300px;background:#131A30;border:1px solid #2A3558;border-radius:14px;padding:10px}
.h-panel h3{margin:0 0 8px;font:700 11px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.08em;color:#6B7699}
.h-below{margin-top:8px;padding:8px;border-radius:10px;background:#1C2542;font-size:12px}
.root-slot{min-height:10px}
.root-slot.alt{border-top:1px dashed #2A3558;margin-top:8px}
.fs{position:fixed;inset:0;background:#05070F;padding:24px;z-index:50}
`;
document.head.appendChild(css);

const App = () => (<><Scene /><InCallPortal /></>);
createRoot(document.getElementById('root')!).render(<App />);
