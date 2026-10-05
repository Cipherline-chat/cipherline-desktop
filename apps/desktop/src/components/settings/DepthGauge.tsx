import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    UserCircle, Monitor, Laptop, Volume2, Bell, Keyboard, Gamepad2,
    Shield, HardDrive, CreditCard, FlaskConical, AlertTriangle, Search,
} from 'lucide-react';
import { ClInput } from '../cl';
import type { PaneId } from './SettingsScreen';
import { Keys } from '../mascot/Keys';
import { SETTINGS_PLACEHOLDERS, SETTINGS_SEARCH_NOTES } from '../../utils/eggPools';
import { searchSettingsIndex } from './settingsSearchIndex';

/**
 * The depth gauge — the Descent's nav. A vertical instrument: hairline rail,
 * four zone groups with fathom readings, and a glowing lume bead that
 * spring-slides to "you are here" (flash in the Abyss, via .sd-z-abyss on
 * the root). Search filters the gauge; a few queries earn a factual note
 * (personality doctrine: words only in owned slots, always true about E2E).
 */

export interface ZoneDef {
    name: string;
    depth: number;      // meters, for the readout
    label: string;      // fathom reading shown in the gauge
    abyss?: boolean;
    items: { id: PaneId; label: string; icon: React.ReactNode }[];
}

export const ZONES: ZoneDef[] = [
    {
        name: 'Surface', depth: 0, label: '0 m',
        items: [
            { id: 'profile',    label: 'Profile',    icon: <UserCircle size={16} /> },
            { id: 'appearance', label: 'Appearance', icon: <Monitor size={16} /> },
        ],
    },
    {
        name: 'Twilight', depth: 200, label: '−200 m',
        items: [
            { id: 'devices',       label: 'Devices',       icon: <Laptop size={16} /> },
            { id: 'voice',         label: 'Voice & Video', icon: <Volume2 size={16} /> },
            { id: 'notifications', label: 'Notifications', icon: <Bell size={16} /> },
            { id: 'keybinds',      label: 'Keybinds',      icon: <Keyboard size={16} /> },
            { id: 'activity',      label: 'Game Activity', icon: <Gamepad2 size={16} /> },
        ],
    },
    {
        name: 'Midnight', depth: 1000, label: '−1,000 m',
        items: [
            { id: 'privacy', label: 'Privacy & Safety', icon: <Shield size={16} /> },
            { id: 'storage', label: 'Storage',          icon: <HardDrive size={16} /> },
            { id: 'billing', label: 'Subscription',     icon: <CreditCard size={16} /> },
        ],
    },
    {
        name: 'The Abyss', depth: 4000, label: '−4,000 m', abyss: true,
        items: [
            { id: 'advanced', label: 'Advanced',    icon: <FlaskConical size={16} /> },
            { id: 'danger',   label: 'Danger Zone', icon: <AlertTriangle size={16} /> },
        ],
    },
];

export function zoneOf(pane: PaneId): number {
    return ZONES.findIndex(z => z.items.some(i => i.id === pane));
}

// Pools live in utils/eggPools.ts so the doctrine tests can hold them to the
// ≥3-line minimum — these three shipped with two lines each.
const PLACEHOLDERS = SETTINGS_PLACEHOLDERS;
const SEARCH_NOTES = SETTINGS_SEARCH_NOTES;

interface DepthGaugeProps {
    active: PaneId;
    onSelect: (pane: PaneId) => void;
    appVersion: string;
}

export const DepthGauge: React.FC<DepthGaugeProps> = ({ active, onSelect, appVersion }) => {
    const [query, setQuery] = useState('');
    const [note, setNote] = useState('');
    const [placeholder, setPlaceholder] = useState<typeof PLACEHOLDERS[number]>(PLACEHOLDERS[0]);
    const focusCount = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const beadRef = useRef<HTMLSpanElement>(null);
    const itemRefs = useRef<Partial<Record<PaneId, HTMLButtonElement | null>>>({});

    const q = query.trim().toLowerCase();
    // Search EVERYTHING, not just the tab names: a pane stays visible when its
    // own label matches OR any setting inside it does (settingsSearchIndex —
    // labels + typed-synonyms per pane). Deep matches carry the matched
    // setting labels so the nav item can show WHICH setting it found.
    const deepHits = useMemo(() => searchSettingsIndex(q), [q]);
    const filtered = useMemo(() => ZONES.map(z => ({
        ...z,
        items: z.items
            .filter(i => !q || i.label.toLowerCase().includes(q) || !!deepHits[i.id])
            .map(i => ({
                ...i,
                // Hint only when the tab label itself didn't match — a direct
                // tab match needs no explanation.
                hint: q && !i.label.toLowerCase().includes(q)
                    ? (deepHits[i.id] ?? []).slice(0, 2).join(' · ')
                    : '',
            })),
    })), [q, deepHits]);
    const hits = filtered.reduce((n, z) => n + z.items.length, 0);

    const moveBead = useCallback(() => {
        const btn = itemRefs.current[active];
        const bead = beadRef.current;
        if (!btn || !bead) return;
        bead.style.transform = `translateY(${btn.offsetTop + btn.offsetHeight / 2 - 5}px)`;
    }, [active]);

    // Reposition on selection, on gauge relayout (filtering), and after the
    // entrance stagger settles (offsetTop is stable even mid-transition since
    // the stagger animates transform, not layout — this is belt & braces).
    useEffect(() => { moveBead(); }, [moveBead, q]);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(moveBead);
        ro.observe(el);
        return () => ro.disconnect();
    }, [moveBead]);

    const handleInput = (v: string) => {
        setQuery(v);
        const key = v.trim().toLowerCase();
        const pool = SEARCH_NOTES[key];
        setNote(pool ? pool[Math.floor(Math.random() * pool.length)] : '');
    };

    return (
        <nav className="sd-gauge" aria-label="Settings sections">
            <div className="sd-search cl-fld">
                <Search size={15} />
                <ClInput
                    value={query}
                    onChange={e => handleInput(e.target.value)}
                    onFocus={() => setPlaceholder(PLACEHOLDERS[(focusCount.current++) % PLACEHOLDERS.length])}
                    placeholder={placeholder}
                    aria-label="Find a setting"
                />
                <p className={`cl-fmsg${note ? ' note' : ''}`}>{note}</p>
            </div>

            <div className="sd-gscroll" ref={scrollRef}>
                <span className="sd-bead" ref={beadRef} style={{ opacity: q ? 0 : 1 }} />
                {filtered.map((z, zi) => z.items.length > 0 && (
                    <div key={z.name} className={`sd-zone${z.abyss ? ' sd-zone--abyss' : ''}`}>
                        <div className="sd-zlab"><b>{z.name}</b><span>{z.label}</span></div>
                        {z.items.map((item, ii) => (
                            <button
                                key={item.id}
                                ref={el => { itemRefs.current[item.id] = el; }}
                                className={`sd-nitem${active === item.id ? ' sd-on' : ''}`}
                                style={{ transitionDelay: `${0.2 + (zi * 3 + ii) * 0.035}s` }}
                                onClick={() => onSelect(item.id)}
                            >
                                {item.icon}
                                <span style={{ minWidth: 0 }}>
                                    {item.label}
                                    {item.hint && (
                                        <span style={{ display: 'block', fontSize: 10.5, color: 'var(--cl-faint)', fontWeight: 500, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {item.hint}
                                        </span>
                                    )}
                                </span>
                            </button>
                        ))}
                    </div>
                ))}
                <p className={`sd-gempty${hits === 0 ? ' sd-show' : ''}`}>Nothing at this depth.</p>
            </div>

            <div className="sd-gfoot">
                {/* The shared articulated Keys — pokes (5 → sleepy, 8 → asleep,
                    hover wakes) and the cuttlefish-cue wiggle live in the
                    component now. No wave: that hello is the home deck's. */}
                <Keys size={40} waveOnMount={false} />
                <small>E2E encrypted<br />at every depth · v{appVersion}</small>
            </div>
        </nav>
    );
};
