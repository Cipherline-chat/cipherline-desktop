/**
 * ChannelIconPicker — curated grid of lucide-react icons for channel
 * icons. Lucide is the Material-style icon pack already bundled with the
 * app; its stroke + roundedness match Cipherline's UI.
 *
 * The list is deliberately curated (not all of lucide's 1k+ icons) so the
 * picker stays focused on iconography that makes sense for a channel —
 * communication, content category, organisation, status, etc.
 *
 * Icon-name strings are stored on `Channel.icon_name`. The renderer side
 * (lookup in ChannelIconRenderer) maps name → JSX. Names not in the
 * allowlist render as the Hash fallback so renaming or removing icons
 * from this list never breaks existing channels.
 *
 * Exports:
 *   ChannelIconRenderer  — render a stored icon name (or Hash fallback)
 *   ChannelIconPicker    — inline always-visible grid (kept for backward compat)
 *   ChannelIconDropdown  — button trigger + floating dropdown (preferred in new UIs)
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ClInput, ClButton } from '../cl';
import { createPortal } from 'react-dom';
import { useEscape } from '../../hooks/useEscape';
import {
    // Communication
    Hash, MessageSquare, MessagesSquare, Megaphone, Mail, AtSign,
    MessageCircle, Phone, Send, Reply,
    // Voice / video
    Volume2, Mic, Video, Headphones, Radio, PhoneCall, Podcast, Voicemail,
    // Content
    Image as ImageIcon, Film, Music, Code, FileText, Newspaper, BookOpen,
    Camera, Book, Library, FileVideo, FileAudio,
    // Activity
    Gamepad2, Trophy, Sparkles, Zap, Heart, Star, Flame, Coffee,
    Rocket, PartyPopper, Gift, Dumbbell,
    // Tooling
    Wrench, Cog, Hammer, Cpu, Terminal, Database, Server, GitBranch, Bug, Package,
    // Organisation
    Pin, Lock, Globe, Bell, Bookmark, Tag, FolderOpen, Archive, Flag, ClipboardList,
    // People
    Users, UserPlus, Smile, ThumbsUp, Crown, GraduationCap, Handshake, BadgeHelp,
    // Creative
    Pen, Brush, Palette, Scissors, Aperture, Wand2, PaintBucket,
    // Business
    BarChart2, PieChart, TrendingUp, DollarSign, ShoppingCart, ShoppingBag, Target, Award,
    // Nature
    Leaf, Sun, Moon, Cloud, Snowflake, Wind, TreePine, Flower2,
    // Misc
    Lightbulb, MapPin, Briefcase, Calendar, Swords,
    // Chevron for dropdown trigger
    ChevronDown,
} from 'lucide-react';

const ALL_ICONS: Record<string, React.ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>> = {
    // Communication
    Hash, MessageSquare, MessagesSquare, Megaphone, Mail, AtSign,
    MessageCircle, Phone, Send, Reply,
    // Voice / video
    Volume2, Mic, Video, Headphones, Radio, PhoneCall, Podcast, Voicemail,
    // Content
    ImageIcon, Film, Music, Code, FileText, Newspaper, BookOpen,
    Camera, Book, Library, FileVideo, FileAudio,
    // Activity
    Gamepad2, Trophy, Sparkles, Zap, Heart, Star, Flame, Coffee,
    Rocket, PartyPopper, Gift, Dumbbell,
    // Tooling
    Wrench, Cog, Hammer, Cpu, Terminal, Database, Server, GitBranch, Bug, Package,
    // Organisation
    Pin, Lock, Globe, Bell, Bookmark, Tag, FolderOpen, Archive, Flag, ClipboardList,
    // People
    Users, UserPlus, Smile, ThumbsUp, Crown, GraduationCap, Handshake, BadgeHelp,
    // Creative
    Pen, Brush, Palette, Scissors, Aperture, Wand2, PaintBucket,
    // Business
    BarChart2, PieChart, TrendingUp, DollarSign, ShoppingCart, ShoppingBag, Target, Award,
    // Nature
    Leaf, Sun, Moon, Cloud, Snowflake, Wind, TreePine, Flower2,
    // Misc
    Lightbulb, MapPin, Briefcase, Calendar, Swords,
};

// `ImageIcon` is the import alias for `Image`; the picker stores the original
// lucide name so cross-app renderers don't have to know about the alias.
const STORED_NAME_FOR: Record<string, string> = {
    ImageIcon: 'Image',
};
const RESOLVE_NAME: Record<string, string> = {
    Image: 'ImageIcon', // when we read 'Image' from the DB, render via ImageIcon
};

type IconKey = keyof typeof ALL_ICONS;

const GROUPED: { label: string; keys: IconKey[] }[] = [
    { label: 'Communication', keys: ['Hash', 'MessageSquare', 'MessagesSquare', 'Megaphone', 'Mail', 'AtSign', 'MessageCircle', 'Phone', 'Send', 'Reply'] },
    { label: 'Voice / Video',  keys: ['Volume2', 'Mic', 'Video', 'Headphones', 'Radio', 'PhoneCall', 'Podcast', 'Voicemail'] },
    { label: 'Content',        keys: ['ImageIcon', 'Film', 'Music', 'Code', 'FileText', 'Newspaper', 'BookOpen', 'Camera', 'Book', 'Library', 'FileVideo', 'FileAudio'] },
    { label: 'Activity',       keys: ['Gamepad2', 'Trophy', 'Sparkles', 'Zap', 'Heart', 'Star', 'Flame', 'Coffee', 'Rocket', 'PartyPopper', 'Gift', 'Dumbbell'] },
    { label: 'Tooling',        keys: ['Wrench', 'Cog', 'Hammer', 'Cpu', 'Terminal', 'Database', 'Server', 'GitBranch', 'Bug', 'Package'] },
    { label: 'Organisation',   keys: ['Pin', 'Lock', 'Globe', 'Bell', 'Bookmark', 'Tag', 'FolderOpen', 'Archive', 'Flag', 'ClipboardList'] },
    { label: 'People',         keys: ['Users', 'UserPlus', 'Smile', 'ThumbsUp', 'Crown', 'GraduationCap', 'Handshake', 'BadgeHelp'] },
    { label: 'Creative',       keys: ['Pen', 'Brush', 'Palette', 'Scissors', 'Aperture', 'Wand2', 'PaintBucket'] },
    { label: 'Business',       keys: ['BarChart2', 'PieChart', 'TrendingUp', 'DollarSign', 'ShoppingCart', 'ShoppingBag', 'Target', 'Award'] },
    { label: 'Nature',         keys: ['Leaf', 'Sun', 'Moon', 'Cloud', 'Snowflake', 'Wind', 'TreePine', 'Flower2'] },
    { label: 'Misc',           keys: ['Lightbulb', 'MapPin', 'Briefcase', 'Calendar', 'Swords'] },
];

/** Resolve a stored icon-name → its render component (or undefined if not in the allowlist). */
export function lookupChannelIcon(name: string | null | undefined): React.ComponentType<any> | undefined {
    if (!name) return undefined;
    const aliased = RESOLVE_NAME[name] ?? name;
    return ALL_ICONS[aliased as IconKey];
}

/** Render a channel's chosen icon, falling back to Hash. Size + className behave like lucide-react. */
export const ChannelIconRenderer: React.FC<{ name?: string | null; size?: number; className?: string }> = ({ name, size = 16, className }) => {
    const Icon = lookupChannelIcon(name) ?? Hash;
    return <Icon size={size} className={className} />;
};

// ── Shared picker content ─────────────────────────────────────────────────────

interface PickerContentProps {
    value: string | null;
    onChange: (next: string | null) => void;
}

const PickerContent: React.FC<PickerContentProps> = ({ value, onChange }) => {
    const [search, setSearch] = useState('');
    const filteredGroups = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return GROUPED;
        return GROUPED
            .map(g => ({ label: g.label, keys: g.keys.filter(k => k.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) }))
            .filter(g => g.keys.length > 0);
    }, [search]);

    return (
        <>
            <div className="flex items-center gap-2 mb-2">
                <ClInput
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search icons…"
                    className="flex-1"
                />
                <ClButton
                    variant={!value ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onChange(null)}
                    tooltip="Use default icon"
                    active={!value}
                >
                    Default
                </ClButton>
            </div>
            <div className="max-h-52 overflow-y-auto custom-scrollbar pr-0.5">
                {filteredGroups.length === 0 && (
                    <p className="text-[11px] text-cl-faint italic px-1 py-3 text-center">No icons match that search.</p>
                )}
                {filteredGroups.map((g, gi) => (
                    <div key={g.label}>
                        <div className={`flex items-center gap-2 ${gi === 0 ? 'mb-1' : 'mt-2 mb-1'}`}>
                            <hr className="flex-1 border-cl-border/30" />
                            <span className="text-[9px] font-mono font-semibold uppercase tracking-widest text-cl-faint shrink-0">{g.label}</span>
                            <hr className="flex-1 border-cl-border/30" />
                        </div>
                        {/* flex-wrap, not a fixed-column grid: the icon tiles are a real
                            circular ClButton (40px at size="sm"), and a `grid-cols-N` with
                            evenly-divided 1fr columns doesn't know that — at this panel's
                            width, 10 equal columns come out narrower than the tiles
                            actually are, so the row overflowed its container and the last
                            tile or two got clipped at the edge. Wrapping tiles of their own
                            natural size sidesteps that column-math entirely. */}
                        <div className="flex flex-wrap gap-1">
                            {g.keys.map(k => {
                                const Icon = ALL_ICONS[k];
                                const storedName = STORED_NAME_FOR[k] ?? k;
                                const selected = value === storedName;
                                return (
                                    <ClButton
                                        key={k}
                                        icon
                                        size="sm"
                                        variant={selected ? 'primary' : 'ghost'}
                                        active={selected}
                                        onClick={() => onChange(storedName)}
                                        tooltip={storedName}
                                        className={`!transition-all !duration-100 hover:!scale-110 ${selected ? '!scale-110' : ''}`}
                                    >
                                        <Icon size={14} />
                                    </ClButton>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
};

// ── Inline grid picker (backward compat) ──────────────────────────────────────

interface PickerProps {
    /** Currently selected icon name, or null/empty to mean "use default Hash". */
    value: string | null;
    onChange: (next: string | null) => void;
}

/**
 * Inline grid picker. Drop into any form. Renders all curated icons grouped
 * by category, with the current selection highlighted. Click → onChange.
 * "None" tile resets to null (Hash fallback).
 */
export const ChannelIconPicker: React.FC<PickerProps> = ({ value, onChange }) => (
    <div className="bg-cl-deep border border-cl-border/40 rounded-xl p-3 space-y-2.5">
        <PickerContent value={value} onChange={onChange} />
    </div>
);

// ── Dropdown button picker (preferred for new UI) ─────────────────────────────

interface DropdownPickerProps {
    /** Currently selected icon name, or null/empty to mean "use default Hash". */
    value: string | null;
    onChange: (next: string | null) => void;
    /** Optional extra class names for the trigger button. */
    triggerClassName?: string;
    /** Icon rendered when value is null/empty instead of the Hash default.
     *  Pass a React element, e.g. `<Radio size={16} />`. */
    fallbackIcon?: React.ReactNode;
}

/**
 * A compact button that shows the current icon; clicking it opens a floating
 * dropdown containing the full icon picker. Closes on outside-click or when
 * an icon is selected.
 *
 * The dropdown is rendered via a React portal at document.body so it is
 * never clipped by parent overflow:hidden / overflow:auto containers.
 *
 * Preferred over the inline `ChannelIconPicker` in newer UIs — keeps forms
 * compact until the user actively wants to change the icon.
 */
export const ChannelIconDropdown: React.FC<DropdownPickerProps> = ({ value, onChange, triggerClassName, fallbackIcon }) => {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const triggerRef = useRef<HTMLSpanElement>(null);
    const panelRef   = useRef<HTMLDivElement>(null);

    const openDropdown = () => {
        if (!triggerRef.current) { setOpen(true); return; }
        const rect = triggerRef.current.getBoundingClientRect();
        const PANEL_W = 340;
        const PANEL_H = 340; // approx max height
        // Horizontal: keep within viewport
        let left = rect.left;
        if (left + PANEL_W > window.innerWidth - 8) left = window.innerWidth - PANEL_W - 8;
        if (left < 8) left = 8;
        // Vertical: prefer below, fall back to above if cramped
        const top = rect.bottom + 8 + PANEL_H > window.innerHeight
            ? Math.max(8, rect.top - PANEL_H - 8)
            : rect.bottom + 8;
        setPos({ top, left });
        setOpen(true);
    };

    // Close on click outside both the trigger and the panel
    useEffect(() => {
        if (!open) return;
        const fn = (e: MouseEvent) => {
            const t = e.target as Node;
            if (!triggerRef.current?.contains(t) && !panelRef.current?.contains(t)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', fn);
        return () => document.removeEventListener('mousedown', fn);
    }, [open]);

    // Close on Escape, through the shared stack.
    useEscape(() => setOpen(false), open);

    const handleSelect = (next: string | null) => {
        onChange(next);
        setOpen(false);
    };

    const dropdown = open && pos ? createPortal(
        <div
            ref={panelRef}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: 340, zIndex: 9999 }}
            className="bg-cl-deep border border-white/[0.12] rounded-xl shadow-2xl p-3 fade-pop-enter"
        >
            <PickerContent value={value} onChange={handleSelect} />
        </div>,
        document.body,
    ) : null;

    return (
        <>
            <span ref={triggerRef} className="inline-flex shrink-0">
                <ClButton
                    icon={!triggerClassName}
                    type="button"
                    variant={open ? 'primary' : 'ghost'}
                    active={open}
                    onClick={() => open ? setOpen(false) : openDropdown()}
                    tooltip="Change channel icon"
                    className={triggerClassName ? `!flex !items-center !gap-1 ${triggerClassName}` : undefined}
                >
                    {(fallbackIcon && !value) ? fallbackIcon : <ChannelIconRenderer name={value} size={17} />}
                    {triggerClassName && (
                        <ChevronDown size={12} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
                    )}
                </ClButton>
            </span>
            {dropdown}
        </>
    );
};
