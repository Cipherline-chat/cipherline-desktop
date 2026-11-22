/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import { MessageSquare, MessagesSquare, Plus } from 'lucide-react';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import { RailTrack } from '../src/components/rail/RailTrack';
import { RailTile } from '../src/components/rail/RailTile';
import { RAIL_DM_KEY, RAIL_GROUP_KEY } from '../src/components/rail/railOffscreenPings';

/**
 * The REAL RailTrack (scroll) + RailTile in a 72px rail column, with the one
 * thing that made the owner's first server switch go wrong: the FIRST open of a
 * server is a long commit (the real Dashboard mounts the server's whole view).
 * Here a cold server's pane busy-waits `?stall=<ms>` (default 60) in a layout
 * effect — inside the same commit as the click, exactly where the real mount's
 * work lands — so the rAF that follows began during that commit. A second open
 * of the same server is warm (no stall), like the real app.
 *   ?h=<px>  rail box height (default 640)
 * The driver (rail-indicator-shots.mjs) clicks the tiles and records frames.
 */
const q = new URLSearchParams(location.search);
const H = Number(q.get('h') ?? 640);
const STALL = Number(q.get('stall') ?? 60);
const COLORS = ['#3B82F6', '#A855F7', '#F59E0B', '#10B981', '#EC4899', '#6366F1', '#14B8A6', '#F97316', '#84CC16'];
const SERVERS = Array.from({ length: 18 }, (_, i) => ({ id: `s${i + 1}`, name: `Server ${i + 1}` }));
const opened = new Set<number>();

const Pane: React.FC<{ active: number }> = ({ active }) => {
    React.useLayoutEffect(() => {
        if (active < 2 || opened.has(active)) return;
        opened.add(active);
        const end = performance.now() + STALL;
        while (performance.now() < end) { /* the cold server's first mount */ }
    }, [active]);
    return <div data-testid="pane" style={{ color: 'var(--cl-text)', padding: 16, fontFamily: 'var(--cl-font-body)' }}>{active < 2 ? (active ? 'Groups' : 'DMs') : SERVERS[active - 2].name}</div>;
};

function App() {
    const [active, setActive] = React.useState(0);
    (window as any).__active = active;
    return (
        <div style={{ display: 'flex', height: H }}>
            <nav className="app-rail" style={{ width: 72, height: H, background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0, boxSizing: 'border-box', paddingTop: 8 }}>
                <RailTrack scroll activeIndex={active}>
                    <RailTile icon={<MessageSquare size={19} />} title="Direct messages" active={active === 0} railId={RAIL_DM_KEY} onClick={() => setActive(0)} />
                    <RailTile icon={<MessagesSquare size={19} />} title="Group chats" active={active === 1} railId={RAIL_GROUP_KEY} onClick={() => setActive(1)} />
                    {SERVERS.map((s, i) => (
                        <div key={s.id} className="relative" data-rail-id={`srv:${s.id}`}>
                            <div className="relative group"><div className="relative">
                                <button className="no-drag" onClick={() => setActive(2 + i)} style={{ position: 'relative', zIndex: 1, width: 44, height: 44, border: 'none', background: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                                    <span style={{ width: 40, height: 40, borderRadius: 10, background: COLORS[i % COLORS.length], color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 13 }}>{`S${i + 1}`}</span>
                                </button>
                            </div></div>
                        </div>
                    ))}
                    <RailTile icon={<Plus size={18} />} title="Create or Join Server" accent />
                </RailTrack>
            </nav>
            <Pane active={active} />
        </div>
    );
}

loadWebFonts();
createRoot(document.getElementById('root')!).render(<App />);
(window as any).__booted = true;
