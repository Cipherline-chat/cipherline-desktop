import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    UserCircle, Plug, Monitor, Palette, Laptop, Volume2, Bell, Keyboard, Gamepad2,
    Shield, HardDrive, CreditCard, FlaskConical, AlertTriangle, Search,
    type LucideIcon,
} from 'lucide-react';
import { ClInput } from '../cl';
import type { PaneId } from './SettingsScreen';
import { Keys } from '../mascot/Keys';
import { SETTINGS_PLACEHOLDERS, HALLOWEEN_ZONE_NAMES, BIRTHDAY_POOL, fillLine, pickRotating } from '../../utils/eggPools';
import { useEggCalendar } from '../../hooks/useEasterEggs';
import { emitMascotCue } from '../../hooks/useMascotCue';
import { settingsSearchPool } from '../../utils/settingsSearchNote';
import { recordEggFound } from '../../utils/eggProgress';
import { searchSettingsIndex } from './settingsSearchIndex';

/**
 * The depth gauge — the Descent's nav. A vertical instrument: hairline rail,
 * four zone groups with fathom readings, and a glowing lume bead that
 * spring-slides to "you are here" (flash in the Abyss, via .sd-z-abyss on
 * the root). Search filters the gauge; a few queries earn a factual note
 * (personality doctrine: words only in owned slots, always true about E2E).
 *
 * Keyboard: ↓ from the search box (or Enter to jump straight to the first
 * hit) moves into the list; ↑/↓/Home/End walk the sections. Picking a section
 * that only matched through one of its settings hands that setting's label to
 * onSelect, so SettingsScreen can scroll to it (revealSetting.ts).
 */

export interface ZoneDef {
    name: string;
    depth: number;      // meters, for the readout
    label: string;      // fathom reading shown in the gauge
    abyss?: boolean;
    items: { id: PaneId; label: string; Icon: LucideIcon }[];
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export const ZONES: ZoneDef[] = [
    {
        name: 'Surface', depth: 0, label: '0 m',
        items: [
            { id: 'profile',    label: 'Profile',    Icon: UserCircle },
            { id: 'connections', label: 'Connections', Icon: Plug },
            { id: 'appearance', label: 'Appearance', Icon: Monitor },
            { id: 'personalize', label: 'Personalize', Icon: Palette },
        ],
    },
    {
        name: 'Twilight', depth: 200, label: '−200 m',
        items: [
            { id: 'devices',       label: 'Devices',       Icon: Laptop },
            { id: 'voice',         label: 'Voice & Video', Icon: Volume2 },
            { id: 'notifications', label: 'Notifications', Icon: Bell },
            { id: 'keybinds',      label: 'Keybinds',      Icon: Keyboard },
            { id: 'activity',      label: 'Game Activity', Icon: Gamepad2 },
        ],
    },
    {
        name: 'Midnight', depth: 1000, label: '−1,000 m',
        items: [
            { id: 'privacy', label: 'Privacy & Safety', Icon: Shield },
            { id: 'storage', label: 'Storage',          Icon: HardDrive },
            { id: 'billing', label: 'Subscription',     Icon: CreditCard },
        ],
    },
    {
        name: 'The Abyss', depth: 4000, label: '−4,000 m', abyss: true,
        items: [
            { id: 'advanced', label: 'Advanced',    Icon: FlaskConical },
            { id: 'danger',   label: 'Danger Zone', Icon: AlertTriangle },
        ],
    },
];

// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function zoneOf(pane: PaneId): number {
    return ZONES.findIndex(z => z.items.some(i => i.id === pane));
}

/** A zone's display name. On Halloween the deep gets a costume of its own.
 *  Everything keyed on the zone — the bead, the Abyss styling — keeps using `name`/`abyss`; only the label changes. */
// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function zoneLabel(name: string, halloween: boolean): string {
    return halloween ? (HALLOWEEN_ZONE_NAMES[name] ?? name) : name;
}

// Pools live in utils/eggPools.ts so the doctrine tests can hold them to the
// ≥3-line minimum — these three shipped with two lines each.
const PLACEHOLDERS = SETTINGS_PLACEHOLDERS;

interface DepthGaugeProps {
    active: PaneId;
    /** `setting`: the matched setting's label when the section was found through it. */
    onSelect: (pane: PaneId, setting?: string) => void;
    appVersion: string;
}

export const DepthGauge: React.FC<DepthGaugeProps> = ({ active, onSelect, appVersion }) => {
    const calendar = useEggCalendar();
    const [query, setQuery] = useState('');
    const [note, setNote] = useState('');
    const [placeholder, setPlaceholder] = useState<typeof PLACEHOLDERS[number]>(PLACEHOLDERS[0]);
    const focusCount = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
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
                    ? (deepHits[i.id] ?? []).slice(0, 2).join(', ')
                    : '',
                setting: q && !i.label.toLowerCase().includes(q) ? deepHits[i.id]?.[0] : undefined,
            })),
    })), [q, deepHits]);
    const hits = filtered.reduce((n, z) => n + z.items.length, 0);
    const firstHit = filtered.flatMap(z => z.items)[0];

    const navButtons = () => Array.from(scrollRef.current?.querySelectorAll<HTMLButtonElement>('.sd-nitem') ?? []);
    const onListKey = (e: React.KeyboardEvent) => {
        const list = navButtons();
        if (!list.length) return;
        const at = list.indexOf(document.activeElement as HTMLButtonElement);
        let next = -1;
        if (e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(list.length - 1, at + 1);
        else if (e.key === 'ArrowUp') next = at <= 0 ? -1 : at - 1;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = list.length - 1;
        else return;
        e.preventDefault();
        if (next < 0) searchRef.current?.focus();
        else list[next].focus();
    };
    const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            navButtons()[0]?.focus();
        } else if (e.key === 'Enter' && q && firstHit) {
            e.preventDefault();
            onSelect(firstHit.id, firstHit.setting);
        }
    };

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
        // Factual notes first, then the playful ones (octopus / squid /
        // kraken / abyss) in the same owned field-message slot
        // (utils/settingsSearchNote.ts).
        const hit = settingsSearchPool(v);
        setNote(hit ? hit.pool[Math.floor(Math.random() * hit.pool.length)] : '');
        // The wrong cephalopod makes every mounted Keys wiggle in protest (once per session).
        if (hit?.misnamed) emitMascotCue();
        if (hit?.egg) recordEggFound(hit.egg);
    };

    return (
        <nav className="sd-gauge" aria-label="Settings sections">
            <div className="sd-search cl-fld">
                <Search size={15} />
                <ClInput
                    ref={searchRef}
                    value={query}
                    onKeyDown={onSearchKey}
                    onChange={e => handleInput(e.target.value)}
                    onFocus={() => setPlaceholder(PLACEHOLDERS[(focusCount.current++) % PLACEHOLDERS.length])}
                    placeholder={placeholder}
                    aria-label="Find a setting"
                />
                <p className={`cl-fmsg${note ? ' note' : ''}`}>{note}</p>
            </div>

            <div className="sd-gscroll" ref={scrollRef} onKeyDown={onListKey}>
                <span className="sd-bead" ref={beadRef} style={{ opacity: q ? 0 : 1 }} />
                {filtered.map((z, zi) => z.items.length > 0 && (
                    <div key={z.name} className={`sd-zone${z.abyss ? ' sd-zone--abyss' : ''}`}>
                        {/* Zone name only — the depth itself is read out once, in the pane header. */}
                        <div className="sd-zlab"><b>{zoneLabel(z.name, calendar.halloween)}</b></div>
                        {z.items.map((item, ii) => (
                            <button
                                key={item.id}
                                ref={el => { itemRefs.current[item.id] = el; }}
                                className={`sd-nitem${active === item.id ? ' sd-on' : ''}`}
                                style={{ '--sd-enter-delay': `${0.2 + (zi * 3 + ii) * 0.035}s` } as React.CSSProperties}
                                aria-current={active === item.id ? 'page' : undefined}
                                onClick={() => onSelect(item.id, item.setting)}
                            >
                                <item.Icon size={16} aria-hidden="true" />
                                <span className="sd-nlabel">
                                    {item.label}
                                    {item.hint && <span className="sd-nhint">{item.hint}</span>}
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
                <small>
                    E2E encrypted<br />at every depth · v{appVersion}
                    {calendar.birthday > 0 && (
                        <><br /><span className="sd-bday">{fillLine(pickRotating(BIRTHDAY_POOL, calendar.birthday), { n: calendar.birthday })}</span></>
                    )}
                </small>
            </div>
        </nav>
    );
};
