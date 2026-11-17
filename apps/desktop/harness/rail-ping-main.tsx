/* eslint-disable -- harness, not shipped */
import { createRoot } from 'react-dom/client';
import React from 'react';
import { MessageSquare, MessagesSquare, Plus } from 'lucide-react';
import { loadWebFonts } from '../src/utils/webFonts';
import '../src/index.css';
import { RailTrack } from '../src/components/rail/RailTrack';
import { RailTile } from '../src/components/rail/RailTile';
import { RailBadge } from '../src/components/RailBadge';
import { RAIL_DM_KEY, RAIL_GROUP_KEY, pingedRailKeys } from '../src/components/rail/railOffscreenPings';
import type { RailItem } from '../src/components/rail/serverFolders';
import type { BadgeState } from '../src/utils/unreadBadges';

/**
 * The REAL RailTrack (scroll) + RailTile + RailBadge + RailPingArrows in a
 * 72px rail column of fixed height, with 18 servers so the box scrolls.
 *   - the DM tile carries a red badge (a DM is always a ping)
 *   - server 4 carries a quiet grey dot (@mentions-only): must NOT raise an arrow
 *   - servers 9 and 15 carry red badges (@mention / unread on "all")
 *   ?h=<px>  rail box height (default 420)
 * The driver (rail-ping-shots.mjs) scrolls it from outside.
 */
const q = new URLSearchParams(location.search);
const H = Number(q.get('h') ?? 420);
const COLORS = ['#3B82F6', '#A855F7', '#F59E0B', '#10B981', '#EC4899', '#6366F1', '#14B8A6', '#F97316', '#84CC16'];
const SERVERS = Array.from({ length: 18 }, (_, i) => ({ id: `s${i + 1}`, name: `Server ${i + 1}` }));
const BADGES: Record<string, BadgeState | null> = { s4: { count: 3, tone: 'quiet' }, s9: { count: 4, tone: 'alert' }, s15: { count: 2, tone: 'alert' } };
const dm: BadgeState = { count: 1, tone: 'alert' };
const items: RailItem[] = SERVERS.map(s => ({ kind: 'server', id: s.id }));

function App() {
    const pingKeys = pingedRailKeys({ dm, group: null, items, serverBadge: id => BADGES[id] ?? null, activeServerId: null });
    (window as any).__pingKeys = pingKeys;
    return (
        <nav className="app-rail" style={{ width: 72, height: H, background: 'var(--cl-abyss)', borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', minHeight: 0, boxSizing: 'border-box' }}>
            <RailTrack scroll activeIndex={-1} pingKeys={pingKeys}>
                <RailTile icon={<MessageSquare size={19} />} title="Direct messages" badge={dm} railId={RAIL_DM_KEY} />
                <RailTile icon={<MessagesSquare size={19} />} title="Group chats" railId={RAIL_GROUP_KEY} />
                {SERVERS.map((s, i) => (
                    <div key={s.id} className="relative" data-rail-id={`srv:${s.id}`}>
                        <div className="relative group"><div className="relative">
                            <button className="no-drag" style={{ position: 'relative', zIndex: 1, width: 44, height: 44, border: 'none', background: 'none', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <span style={{ width: 40, height: 40, borderRadius: 10, background: COLORS[i % COLORS.length], color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--cl-font-display)', fontWeight: 600, fontSize: 13 }}>{`S${i + 1}`}</span>
                            </button>
                            <RailBadge badge={BADGES[s.id] ?? null} className="z-10 pointer-events-none" />
                        </div></div>
                    </div>
                ))}
                <RailTile icon={<Plus size={18} />} title="Create or Join Server" accent />
            </RailTrack>
        </nav>
    );
}

loadWebFonts();
createRoot(document.getElementById('root')!).render(<App />);
(window as any).__booted = true;
