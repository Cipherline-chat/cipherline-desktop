/**
 * NotificationsTab — full notification settings panel.
 */

import React, { useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    Bell, BellOff, Volume2, VolumeX, Clock, MessageSquare,
    AtSign, Phone, UserCheck, UserMinus, Monitor, RotateCcw,
    Plus, X, Info, Gamepad2, ScreenShare, Play, Upload,
    Mic, MicOff, Headphones, HeadphoneOff, Video, VideoOff, Fish, PenLine,
    SlidersHorizontal, ChevronRight, Eye, EyeOff,
} from 'lucide-react';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { useToast } from '../contexts/ToastContext';
import { useAuth } from '../contexts/AuthContext';
import { useNudgeOffSwitch } from '../hooks/useNudgeOffSwitch';
import type { NotificationPrefs, SoundCategoryPrefs } from '../contexts/NotificationContext';
import type { SoundCategory, CollapsedSoundGroup, SoundGroupPrefs } from '../utils/notificationSounds';
import { playSound, previewSound, soundGroupOf, categoriesInGroup } from '../utils/notificationSounds';
import { ClToggle, ClButton, ClInput, ClSelect, ClSlider } from './cl';
import type { ClSelectOption } from './cl';

const reveal = {
    initial:    { height: 0, opacity: 0 },
    animate:    { height: 'auto' as const, opacity: 1 },
    exit:       { height: 0, opacity: 0 },
    transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

const BUILT_IN_SOUNDS: ClSelectOption<string>[] = [
    { label: 'Default',      value: './sounds/notification.wav' },
    { label: 'Mention',      value: './sounds/mention.wav' },
    { label: 'Call',         value: './sounds/call_sound.wav' },
    { label: 'Join',         value: './sounds/join_call_sound.wav' },
    { label: 'Leave',        value: './sounds/leave_call.wav' },
    { label: 'Mute',         value: './sounds/mute.wav' },
    { label: 'Unmute',       value: './sounds/unmute.wav' },
    { label: 'Deafen',       value: './sounds/deafen.wav' },
    { label: 'Undeafen',     value: './sounds/undeafen.wav' },
    { label: 'Camera on',    value: './sounds/camera_on.wav' },
    { label: 'Camera off',   value: './sounds/camera_off.wav' },
    { label: 'Subtle',       value: './sounds/subtle.wav' },
    { label: 'None',         value: '' },
];

const SoundSelect: React.FC<{
    value:        string;
    onChange:     (v: string) => void;
    customSounds: { name: string; file: string }[];
    disabled?:    boolean;
}> = ({ value, onChange, customSounds, disabled }) => {
    const options: ClSelectOption<string>[] = [
        ...BUILT_IN_SOUNDS,
        ...customSounds.map(c => ({ label: c.name, value: c.file })),
    ];
    return (
        <ClSelect
            value={value}
            onChange={onChange}
            options={options}
            disabled={disabled}
            className="flex-1"
        />
    );
};

// ── Preview select ────────────────────────────────────────────────────────────

const PREVIEW_OPTIONS: ClSelectOption<string>[] = [
    { value: 'full',        label: 'Full message' },
    { value: 'sender_only', label: 'Sender name only' },
    { value: 'hidden',      label: 'Hidden' },
];

// ── Time picker — two kit selects (hour : minute), no native number spinners ──

const HOUR_OPTIONS: ClSelectOption<string>[] = Array.from({ length: 24 }, (_, h) => ({
    value: String(h), label: String(h).padStart(2, '0'),
}));
const MINUTE_STEP_OPTIONS: ClSelectOption<string>[] = Array.from({ length: 12 }, (_, i) => ({
    value: String(i * 5), label: String(i * 5).padStart(2, '0'),
}));

const TimePicker: React.FC<{
    value:    number;
    onChange: (v: number) => void;
    disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
    const hours   = Math.floor(value / 60);
    const minutes = value % 60;
    // Older configs may hold an off-step minute (e.g. :03) — surface it as a
    // real option so the select doesn't fall back to its placeholder.
    const minuteOptions = MINUTE_STEP_OPTIONS.some(o => o.value === String(minutes))
        ? MINUTE_STEP_OPTIONS
        : [...MINUTE_STEP_OPTIONS, { value: String(minutes), label: String(minutes).padStart(2, '0') }]
            .sort((a, b) => Number(a.value) - Number(b.value));
    return (
        <div className={`flex items-center gap-1 ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <ClSelect<string>
                value={String(hours)}
                onChange={v => onChange(Number(v) * 60 + minutes)}
                options={HOUR_OPTIONS}
                disabled={disabled}
                style={{ width: 72 }}
            />
            <span className="font-semibold select-none leading-none" style={{ color: 'var(--cl-faint)' }}>:</span>
            <ClSelect<string>
                value={String(minutes)}
                onChange={v => onChange(hours * 60 + Number(v))}
                options={minuteOptions}
                disabled={disabled}
                style={{ width: 72 }}
            />
        </div>
    );
};

// ── Section card (Descent sd-card shell; inner rows keep px-4 = 16px, the
//    6px side padding here lines their gutters up with the 22px card grid) ──

const Section: React.FC<{
    icon:     React.ReactNode;
    title:    string;
    badge?:   React.ReactNode;
    children: React.ReactNode;
}> = ({ icon, title, badge, children }) => (
    <div className="sd-card" style={{ padding: '0 6px' }}>
        <div className="flex items-center gap-3 pt-[18px] pb-1" style={{ padding: '18px 16px 4px' }}>
            <span className="sd-tile" style={{ width: 30, height: 30, borderRadius: 9 }}>{icon}</span>
            <h3 style={{ margin: 0, fontFamily: 'var(--cl-font-display)', fontWeight: 500, fontSize: 16.5, color: 'var(--cl-text)' }}>{title}</h3>
            {badge}
        </div>
        <div className="pb-2">{children}</div>
    </div>
);

const Row: React.FC<{
    label:     string;
    desc?:     string;
    right?:    React.ReactNode;
    indent?:   boolean;
    className?: string;
}> = ({ label, desc, right, indent, className }) => (
    <div className={`flex items-center justify-between gap-4 px-4 py-3.5 ${indent ? 'pl-9' : ''} ${className ?? ''}`}>
        <div className="min-w-0">
            <p className="text-[13.5px] font-medium leading-snug" style={{ color: indent ? 'var(--cl-muted)' : 'var(--cl-text)' }}>{label}</p>
            {desc && <p className="text-[11.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--cl-faint)' }}>{desc}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
    </div>
);

const Divider = () => <div className="border-t mx-4" style={{ borderColor: 'rgba(42,53,88,.5)' }} />;

const SubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="px-4 pt-3.5 pb-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--cl-faint)' }}>{children}</p>
);

// ── Sound categories ──────────────────────────────────────────────────────────

const CATEGORIES: Array<{ cat: SoundCategory; label: string; icon: React.ReactNode }> = [
    { cat: 'message',     label: 'Direct messages',      icon: <MessageSquare size={15} /> },
    { cat: 'mention',     label: 'Mentions & keywords',  icon: <AtSign size={15} /> },
    { cat: 'call',        label: 'Incoming calls',       icon: <Phone size={15} /> },
    { cat: 'join',        label: 'Someone joined call',  icon: <UserCheck size={15} /> },
    { cat: 'leave',       label: 'Someone left call',    icon: <UserMinus size={15} /> },
    { cat: 'mute',        label: 'You mute your mic',    icon: <MicOff size={15} /> },
    { cat: 'unmute',      label: 'You unmute your mic',  icon: <Mic size={15} /> },
    { cat: 'deafen',      label: 'You deafen',           icon: <HeadphoneOff size={15} /> },
    { cat: 'undeafen',    label: 'You undeafen',         icon: <Headphones size={15} /> },
    { cat: 'camera_on',   label: 'You turn camera on',   icon: <Video size={15} /> },
    { cat: 'camera_off',  label: 'You turn camera off',  icon: <VideoOff size={15} /> },
    // These four had no row because they never went through notificationSounds:
    // the first three were raw `new Audio()` calls, and celebrations were silent.
    { cat: 'ringing',         label: 'Outgoing call ringing', icon: <Phone size={15} /> },
    { cat: 'screenshare_on',  label: 'Someone starts sharing', icon: <ScreenShare size={15} /> },
    { cat: 'screenshare_off', label: 'Someone stops sharing',  icon: <Monitor size={15} /> },
    { cat: 'celebration',     label: 'Celebrations',           icon: <Play size={15} /> },
    { cat: 'mascot',          label: 'Poking Keys',            icon: <Fish size={15} /> },
    // A primary row (see SOUND_GROUP_OVERRIDES): a person is waiting on a
    // decision that expires in 60s, so it has to be silenceable on its own
    // rather than only along with the app's ambient chatter.
    { cat: 'annotation_request', label: 'Annotation requests', icon: <PenLine size={15} /> },
    // Streamer-only cues — they fire on YOUR tile when someone presses (or
    // leaves) Watch on a share you are publishing.
    { cat: 'stream_viewer_join',  label: 'Someone watches your share', icon: <Eye size={15} /> },
    { cat: 'stream_viewer_leave', label: 'Someone stops watching',     icon: <EyeOff size={15} /> },
];

// Seventeen categories × (toggle + file picker + volume slider) was a wall of
// controls for things nobody tunes one at a time. The five cues people actually
// have opinions about keep their own row; the rest collapse into one "App
// sounds" row with a single enable and a single volume.
//
// Both lists are DERIVED from soundGroupOf(), so the grouping lives in exactly
// one place (notificationSounds.ts) and a newly added category lands in "App
// sounds" without anyone editing this file. A category that wants its own row
// opts in there, not here.
const PRIMARY_CATEGORIES = CATEGORIES.filter(c => soundGroupOf(c.cat) === 'primary');
const APP_CATEGORIES     = CATEGORIES.filter(c => soundGroupOf(c.cat) === 'app');

/** Which member's file the "App sounds" Test button auditions. Falls back to
 *  whatever is first in the group if join is ever removed. */
const APP_GROUP_PREVIEW: SoundCategory = 'join';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Main component ────────────────────────────────────────────────────────────

export const NotificationsTab: React.FC = () => {
    const { prefs, updatePrefs, resetPrefs } = useNotificationPrefs();
    const toast = useToast();
    const { userId } = useAuth();
    const [tipsOn, setTipsOn] = useNudgeOffSwitch(userId);
    const [confirmReset, setConfirmReset] = useState(false);
    const [newKeyword, setNewKeyword]     = useState('');
    const [showAppSounds, setShowAppSounds] = useState(false);
    const kwInputRef = useRef<HTMLInputElement>(null);

    const set = useCallback(<K extends keyof NotificationPrefs>(
        key: K, value: NotificationPrefs[K],
    ) => updatePrefs({ [key]: value } as Partial<NotificationPrefs>), [updatePrefs]);

    const setSchedule = useCallback(
        (partial: Partial<NotificationPrefs['dnd_schedule']>) =>
            updatePrefs({ dnd_schedule: { ...prefs.dnd_schedule, ...partial } }),
        [prefs.dnd_schedule, updatePrefs],
    );

    const setAuto = useCallback(
        (partial: Partial<NotificationPrefs['dnd_auto']>) =>
            updatePrefs({ dnd_auto: { ...prefs.dnd_auto, ...partial } }),
        [prefs.dnd_auto, updatePrefs],
    );

    const setSound = useCallback(
        (cat: SoundCategory, partial: Partial<SoundCategoryPrefs>) =>
            updatePrefs({ sounds: { ...prefs.sounds, [cat]: { ...prefs.sounds[cat], ...partial } } }),
        [prefs.sounds, updatePrefs],
    );

    const setSoundGroup = useCallback(
        (group: CollapsedSoundGroup, partial: Partial<SoundGroupPrefs>) =>
            updatePrefs({ sound_groups: { ...prefs.sound_groups, [group]: { ...prefs.sound_groups[group], ...partial } } }),
        [prefs.sound_groups, updatePrefs],
    );

    /**
     * The group's enable is a gate on top of each member's own `enabled`, which
     * playback still AND-s in. Flipping the group therefore also rewrites its
     * members — otherwise a member muted individually before this row existed
     * would stay silent with no visible control saying why, and turning the
     * group back on would look broken.
     */
    const toggleSoundGroup = useCallback((group: CollapsedSoundGroup, on: boolean) => {
        const sounds = { ...prefs.sounds };
        for (const cat of categoriesInGroup(group)) sounds[cat] = { ...sounds[cat], enabled: on };
        updatePrefs({
            sounds,
            sound_groups: { ...prefs.sound_groups, [group]: { ...prefs.sound_groups[group], enabled: on } },
        });
    }, [prefs.sounds, prefs.sound_groups, updatePrefs]);

    const addKeyword = () => {
        const kw = newKeyword.trim();
        if (!kw || prefs.keywords.includes(kw)) { setNewKeyword(''); return; }
        set('keywords', [...prefs.keywords, kw]);
        setNewKeyword('');
        kwInputRef.current?.focus();
    };

    const toggleDay = (d: number) => {
        const days = prefs.dnd_schedule.days.includes(d)
            ? prefs.dnd_schedule.days.filter(x => x !== d)
            : [...prefs.dnd_schedule.days, d];
        setSchedule({ days });
    };

    const isWindows = typeof window !== 'undefined' && window.electronAPI?.platform === 'windows';

    return (
        <div className="space-y-4">
            {/* ── 1. General ──────────────────────────────────────────────────── */}
            <Section icon={<Bell size={13} />} title="General">
                <Row
                    label="Desktop notifications"
                    desc="Show OS toasts when new messages arrive"
                    right={<ClToggle checked={prefs.desktop_notifications_enabled} onChange={v => set('desktop_notifications_enabled', v)} />}
                />
                <Divider />
                <Row
                    label="Notification sounds"
                    desc="Play audio cues on messages and events"
                    right={<ClToggle checked={prefs.sounds_enabled} onChange={v => set('sounds_enabled', v)} />}
                />

                <AnimatePresence initial={false}>
                    {prefs.sounds_enabled && (
                        <motion.div {...reveal} className="overflow-hidden">
                            <div className="px-4 pb-3 pt-0.5">
                                <div className="flex items-center gap-3 rounded-xl px-3.5 py-3" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                                    <VolumeX size={13} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                    <div style={{ flex: 1 }}>
                                        <ClSlider
                                            min={0} max={100} step={5}
                                            value={Math.round(prefs.master_volume * 100)}
                                            onChange={v => set('master_volume', v / 100)}
                                            formatLabel={v => `${v}%`}
                                        />
                                    </div>
                                    <Volume2 size={13} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                    <span className="text-[12px] w-9 text-right font-mono shrink-0" style={{ color: 'var(--cl-muted)' }}>
                                        {Math.round(prefs.master_volume * 100)}%
                                    </span>
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <Divider />
                <Row
                    label="Message preview"
                    desc="How much content is shown in the toast"
                    right={
                        <ClSelect<string>
                            value={prefs.show_preview}
                            onChange={v => set('show_preview', v as any)}
                            options={PREVIEW_OPTIONS}
                            style={{ width: 160 }}
                        />
                    }
                />
                <Divider />
                <Row
                    label="Quick reply from notification"
                    desc="Reply inline without opening the app (macOS)"
                    right={
                        <ClToggle
                            checked={prefs.quick_reply_enabled}
                            onChange={v => set('quick_reply_enabled', v)}
                            disabled={prefs.show_preview === 'hidden'}
                        />
                    }
                />
                <Divider />
                <Row
                    label="Suppress when chat is open"
                    desc="No toast if you're already viewing that conversation"
                    right={<ClToggle checked={prefs.suppress_when_active_conv} onChange={v => set('suppress_when_active_conv', v)} />}
                />
                <Divider />
                <Row
                    label="Suppress when app is focused"
                    desc="No toast when Cipherline is in the foreground"
                    right={<ClToggle checked={prefs.suppress_when_window_focused} onChange={v => set('suppress_when_window_focused', v)} />}
                />
                <Divider />
                <Row
                    label="Getting-started tips"
                    desc="A gentle hint now and then during your first week, only while you're here. In-app only, never an email."
                    right={<ClToggle checked={tipsOn} onChange={setTipsOn} />}
                />
            </Section>

            {/* ── 2. Do Not Disturb ─────────────────────────────────────────────── */}
            <Section
                icon={<BellOff size={13} />}
                title="Do Not Disturb"
                badge={prefs.dnd_manual ? (
                    <span className="ml-1 text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: 'rgba(249,115,22,.2)', color: '#fdba74' }}>Active</span>
                ) : undefined}
            >
                <Row
                    label="Pause all notifications"
                    desc="Manually enable Do Not Disturb until you turn it off"
                    right={<ClToggle checked={prefs.dnd_manual} onChange={v => set('dnd_manual', v)} />}
                />

                <Divider />
                <SubLabel>Quiet hours schedule</SubLabel>
                <Row
                    label="Enable schedule"
                    indent
                    right={<ClToggle checked={prefs.dnd_schedule.enabled} onChange={v => setSchedule({ enabled: v })} />}
                />
                <AnimatePresence initial={false}>
                    {prefs.dnd_schedule.enabled && (
                        <motion.div {...reveal} className="overflow-hidden">
                            <div className="px-9 pb-4 space-y-3">
                                <div className="flex items-center gap-3">
                                    <span className="text-[12px] w-8" style={{ color: 'var(--cl-faint)' }}>From</span>
                                    <TimePicker value={prefs.dnd_schedule.start_minute} onChange={v => setSchedule({ start_minute: v })} />
                                    <span className="text-[12px]" style={{ color: 'var(--cl-faint)' }}>to</span>
                                    <TimePicker value={prefs.dnd_schedule.end_minute} onChange={v => setSchedule({ end_minute: v })} />
                                </div>
                                <div className="flex items-center gap-1.5">
                                    {DAY_LABELS.map((lbl, i) => (
                                        <ClButton
                                            key={i}
                                            type="button"
                                            tooltip={DAY_NAMES[i]}
                                            onClick={() => toggleDay(i)}
                                            active={prefs.dnd_schedule.days.includes(i)}
                                            variant="ghost"
                                            className="w-8 h-8 rounded-full text-[12px] font-semibold"
                                        >
                                            {lbl}
                                        </ClButton>
                                    ))}
                                </div>
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                <Divider />
                <SubLabel>Auto-pause when…</SubLabel>
                {([
                    { key: 'when_in_call',       icon: <Phone size={14} />,       label: 'In a voice or video call', locked: false },
                    { key: 'when_screensharing', icon: <ScreenShare size={14} />,  label: 'Sharing your screen', locked: false },
                    { key: 'when_in_game',       icon: <Gamepad2 size={14} />,     label: 'Playing a game', locked: false },
                    { key: 'when_status_dnd',    icon: <BellOff size={14} />,      label: 'Status is Do Not Disturb', locked: true },
                    { key: 'when_status_away',   icon: <Clock size={14} />,        label: 'Status is Idle / Away', locked: false },
                ] as const).map(({ key, icon, label, locked }, idx) => (
                    <React.Fragment key={key}>
                        {idx > 0 && <Divider />}
                        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
                            <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.04)', color: 'var(--cl-faint)' }}>
                                    {icon}
                                </div>
                                <span className="text-[13.5px] font-medium" style={{ color: 'var(--cl-text)' }}>{label}</span>
                                {locked && (
                                    <span title="Always active when status is DND" style={{ display: 'inline-flex', flexShrink: 0 }}>
                                        <Info size={12} style={{ color: 'var(--cl-faint)' }} />
                                    </span>
                                )}
                            </div>
                            <ClToggle
                                checked={prefs.dnd_auto[key as keyof typeof prefs.dnd_auto]}
                                onChange={v => setAuto({ [key]: v } as any)}
                                disabled={locked}
                            />
                        </div>
                    </React.Fragment>
                ))}

                <Divider />
                <Row
                    label="Let @mentions through"
                    desc="@pings and keyword matches still notify you during DND"
                    right={<ClToggle checked={prefs.dnd_let_mentions_through} onChange={v => set('dnd_let_mentions_through', v)} />}
                />
            </Section>

            {/* ── 3. Mention Keywords ───────────────────────────────────────────── */}
            <Section icon={<AtSign size={13} />} title="Mention Keywords">
                <div className="px-4 pt-2 pb-4 space-y-3">
                    <p className="text-[12px] leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                        Words that trigger a mention notification even without a direct @ping.
                        Matched whole-word, case-insensitively.
                    </p>

                    <div className="flex flex-wrap gap-2 min-h-[28px]">
                        <AnimatePresence mode="popLayout">
                            {prefs.keywords.map(kw => (
                                <motion.span
                                    key={kw}
                                    layout
                                    initial={{ opacity: 0, scale: 0.85 }}
                                    animate={{ opacity: 1, scale: 1 }}
                                    exit={{ opacity: 0, scale: 0.85 }}
                                    transition={{ duration: 0.14 }}
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px] font-medium"
                                    style={{ background: 'rgba(37,224,200,.15)', border: '1px solid rgba(37,224,200,.2)', color: 'var(--cl-lume)' }}
                                >
                                    {kw}
                                    <ClButton
                                        icon
                                        size="sm"
                                        variant="ghost"
                                        type="button"
                                        onClick={() => set('keywords', prefs.keywords.filter(k => k !== kw))}
                                    >
                                        <X size={11} />
                                    </ClButton>
                                </motion.span>
                            ))}
                        </AnimatePresence>
                        {prefs.keywords.length === 0 && (
                            <span className="text-[12px] italic" style={{ color: 'var(--cl-faint)' }}>No keywords added yet</span>
                        )}
                    </div>

                    <form onSubmit={e => { e.preventDefault(); addKeyword(); }} className="flex gap-2">
                        <div style={{ flex: 1 }}>
                            <ClInput
                                ref={kwInputRef}
                                value={newKeyword}
                                onChange={e => setNewKeyword(e.target.value)}
                                placeholder="Add a keyword…"
                                maxLength={60}
                                style={{ width: '100%' }}
                            />
                        </div>
                        <ClButton type="submit" disabled={!newKeyword.trim()}>
                            <Plus size={15} />
                        </ClButton>
                    </form>
                </div>
            </Section>

            {/* ── 4. Sounds ─────────────────────────────────────────────────────── */}
            <Section icon={<Volume2 size={13} />} title="Sounds">
                <div className="px-4 pt-2 pb-4 space-y-2">
                    {PRIMARY_CATEGORIES.map(({ cat, label, icon }) => {
                        const s = prefs.sounds[cat];
                        const catEnabled = s.enabled && prefs.sounds_enabled;
                        return (
                            <div key={cat} className="rounded-xl" style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.15)' }}>
                                <div className="flex items-center gap-3 px-3.5 py-3">
                                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--cl-muted)' }}>
                                        {icon}
                                    </div>
                                    <span className="flex-1 text-[13.5px] font-medium" style={{ color: 'var(--cl-text)' }}>{label}</span>
                                    <ClToggle
                                        checked={catEnabled}
                                        onChange={v => setSound(cat, { enabled: v })}
                                        disabled={!prefs.sounds_enabled}
                                    />
                                </div>
                                <AnimatePresence initial={false}>
                                    {catEnabled && (
                                        <motion.div {...reveal} className="overflow-hidden">
                                            <div className="px-3.5 pb-3 space-y-2.5 pt-2.5" style={{ borderTop: '1px solid var(--cl-border)' }}>
                                                <div className="flex items-center gap-2">
                                                    <SoundSelect
                                                        value={s.file}
                                                        onChange={v => setSound(cat, { file: v })}
                                                        customSounds={prefs.custom_sounds}
                                                    />
                                                    <ClButton
                                                        size="sm"
                                                        variant="ghost"
                                                        disabled={!s.file}
                                                        onClick={() => playSound(cat, prefs)}
                                                    >
                                                        <Play size={12} /> Test
                                                    </ClButton>
                                                </div>
                                                <div className="flex items-center gap-2.5">
                                                    <VolumeX size={12} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                                    <div style={{ flex: 1 }}>
                                                        <ClSlider
                                                            min={0} max={100} step={5}
                                                            value={Math.round(s.volume * 100)}
                                                            onChange={v => setSound(cat, { volume: v / 100 })}
                                                        />
                                                    </div>
                                                    <Volume2 size={12} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                                    <span className="text-[11px] w-8 text-right font-mono shrink-0" style={{ color: 'var(--cl-faint)' }}>
                                                        {Math.round(s.volume * 100)}%
                                                    </span>
                                                </div>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        );
                    })}

                    {/* ── App sounds: one row for every remaining cue ─────────────
                        The group's volume is a SCALAR over each member's own
                        volume (see notificationSounds' resolve()), which is why
                        100% is the default and reads as "unchanged" rather than
                        "everything at full blast" — it preserves the relative
                        ladder that keeps the mic-toggle blip quieter than the
                        join chime. */}
                    {(() => {
                        const grp = prefs.sound_groups.app;
                        const groupEnabled = grp.enabled && prefs.sounds_enabled;
                        const previewCat = APP_CATEGORIES.some(c => c.cat === APP_GROUP_PREVIEW)
                            ? APP_GROUP_PREVIEW
                            : APP_CATEGORIES[0]?.cat;
                        const previewFile = previewCat ? prefs.sounds[previewCat]?.file : '';
                        return (
                            <div className="rounded-xl" style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.15)' }}>
                                <div className="flex items-center gap-3 px-3.5 py-3">
                                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--cl-muted)' }}>
                                        <SlidersHorizontal size={15} />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[13.5px] font-medium leading-snug" style={{ color: 'var(--cl-text)' }}>App sounds</p>
                                        <p className="text-[11.5px] mt-0.5 leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                                            Join &amp; leave, mute, deafen, camera, screen share, celebrations and other in-app cues
                                        </p>
                                    </div>
                                    <ClToggle
                                        checked={groupEnabled}
                                        onChange={v => toggleSoundGroup('app', v)}
                                        disabled={!prefs.sounds_enabled}
                                    />
                                </div>

                                <AnimatePresence initial={false}>
                                    {groupEnabled && (
                                        <motion.div {...reveal} className="overflow-hidden">
                                            <div className="px-3.5 pb-3 space-y-2.5 pt-2.5" style={{ borderTop: '1px solid var(--cl-border)' }}>
                                                <div className="flex items-center gap-2.5">
                                                    <VolumeX size={12} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                                    <div style={{ flex: 1 }}>
                                                        <ClSlider
                                                            min={0} max={100} step={5}
                                                            value={Math.round(grp.volume * 100)}
                                                            onChange={v => setSoundGroup('app', { volume: v / 100 })}
                                                        />
                                                    </div>
                                                    <Volume2 size={12} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                                    <span className="text-[11px] w-8 text-right font-mono shrink-0" style={{ color: 'var(--cl-faint)' }}>
                                                        {Math.round(grp.volume * 100)}%
                                                    </span>
                                                    <ClButton
                                                        size="sm"
                                                        variant="ghost"
                                                        disabled={!previewFile}
                                                        onClick={() => previewSound(
                                                            previewFile ?? '',
                                                            prefs.master_volume * grp.volume * (previewCat ? prefs.sounds[previewCat].volume : 1),
                                                        )}
                                                    >
                                                        <Play size={12} /> Test
                                                    </ClButton>
                                                </div>

                                                {/* Grouping removed the only place a custom sound could be
                                                    assigned to join/mute/deafen/…, so the per-cue file pickers
                                                    live on behind a disclosure rather than being deleted. Volume
                                                    is deliberately NOT here — one slider drives the group. */}
                                                <ClButton
                                                    variant="ghost"
                                                    size="sm"
                                                    fullWidth
                                                    onClick={() => setShowAppSounds(v => !v)}
                                                >
                                                    <ChevronRight
                                                        size={12}
                                                        style={{ transform: showAppSounds ? 'rotate(90deg)' : 'none', transition: 'transform .18s ease' }}
                                                    />
                                                    {showAppSounds ? 'Hide individual sounds' : 'Choose individual sounds'}
                                                </ClButton>

                                                <AnimatePresence initial={false}>
                                                    {showAppSounds && (
                                                        <motion.div {...reveal} className="overflow-hidden">
                                                            <div className="space-y-2 pt-1">
                                                                {APP_CATEGORIES.map(({ cat, label, icon }) => {
                                                                    const s = prefs.sounds[cat];
                                                                    return (
                                                                        <div key={cat} className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: 'rgba(0,0,0,.2)' }}>
                                                                            <span className="shrink-0" style={{ color: 'var(--cl-faint)' }}>{icon}</span>
                                                                            <span className="text-[12px] w-[132px] shrink-0 truncate" style={{ color: 'var(--cl-muted)' }}>{label}</span>
                                                                            <SoundSelect
                                                                                value={s.file}
                                                                                onChange={v => setSound(cat, { file: v })}
                                                                                customSounds={prefs.custom_sounds}
                                                                                disabled={!s.enabled}
                                                                            />
                                                                            <ClButton
                                                                                icon
                                                                                size="sm"
                                                                                variant="ghost"
                                                                                tooltip="Test"
                                                                                disabled={!s.file || !s.enabled}
                                                                                onClick={() => playSound(cat, prefs)}
                                                                            >
                                                                                <Play size={11} />
                                                                            </ClButton>
                                                                            <ClToggle
                                                                                checked={s.enabled}
                                                                                onChange={v => setSound(cat, { enabled: v })}
                                                                            />
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </div>
                        );
                    })()}

                    {!!window.electronAPI?.uploadCustomSound && (
                        <div className="mt-1 pt-3 space-y-2" style={{ borderTop: '1px solid var(--cl-border)' }}>
                            <p className="text-[10px] font-bold uppercase tracking-widest pb-1" style={{ color: 'var(--cl-faint)' }}>Custom Sounds</p>
                            {prefs.custom_sounds.length === 0 && (
                                <p className="text-[12px] italic" style={{ color: 'var(--cl-faint)' }}>No custom sounds yet</p>
                            )}
                            <AnimatePresence mode="popLayout">
                                {prefs.custom_sounds.map(c => (
                                    <motion.div
                                        key={c.file}
                                        layout
                                        initial={{ opacity: 0, y: -4 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -4 }}
                                        transition={{ duration: 0.15 }}
                                        className="flex items-center gap-2 rounded-xl px-3 py-2.5"
                                        style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}
                                    >
                                        <span className="flex-1 text-[12.5px] truncate" style={{ color: 'var(--cl-muted)' }}>{c.name}</span>
                                        <ClButton
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => previewSound(c.file, prefs.master_volume)}
                                        >
                                            <Play size={11} /> Test
                                        </ClButton>
                                        <ClButton
                                            icon
                                            size="sm"
                                            variant="ghost"
                                            onClick={async () => {
                                                await window.electronAPI?.deleteCustomSound?.(c.file);
                                                set('custom_sounds', prefs.custom_sounds.filter(x => x.file !== c.file));
                                            }}
                                        >
                                            <X size={13} />
                                        </ClButton>
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                            <ClButton
                                variant="ghost"
                                fullWidth
                                onClick={async () => {
                                    const input = document.createElement('input');
                                    input.type = 'file';
                                    input.accept = '.wav,.mp3,.ogg,audio/*';
                                    input.onchange = async () => {
                                        const file = input.files?.[0];
                                        if (!file) return;
                                        if (file.size > 1024 * 1024) { toast.push({ kind: 'error', title: 'File Too Large', message: 'Sound must be under 1 MB.' }); return; }
                                        const bytes = new Uint8Array(await file.arrayBuffer());
                                        const res = await window.electronAPI?.uploadCustomSound?.(file.name, bytes);
                                        if (res) set('custom_sounds', [...prefs.custom_sounds.filter(x => x.file !== res.file), res]);
                                    };
                                    input.click();
                                }}
                            >
                                <Upload size={13} /> Upload sound…
                            </ClButton>
                            <p className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>WAV, MP3, or OGG · max 1 MB · roams with your encrypted backup</p>
                        </div>
                    )}
                </div>
            </Section>

            {/* ── 5. Taskbar & Dock ─────────────────────────────────────────────── */}
            <Section icon={<Monitor size={13} />} title="Taskbar & Dock">
                <Row
                    label="Show unread badge"
                    desc="Red dot or number on the taskbar / dock icon"
                    right={<ClToggle checked={prefs.show_badge_count} onChange={v => set('show_badge_count', v)} />}
                />
                <AnimatePresence initial={false}>
                    {prefs.show_badge_count && (
                        <motion.div {...reveal} className="overflow-hidden">
                            <div>
                                <Divider />
                                <Row
                                    label="Mentions only"
                                    desc="Only count messages that directly @ping you"
                                    indent
                                    right={<ClToggle checked={prefs.badge_only_mentions} onChange={v => set('badge_only_mentions', v)} />}
                                />
                                <Divider />
                                <Row
                                    label="Include muted conversations"
                                    desc="Count unread messages from muted chats too"
                                    indent
                                    right={<ClToggle checked={prefs.badge_includes_muted} onChange={v => set('badge_includes_muted', v)} />}
                                />
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
                {isWindows && (
                    <>
                        <Divider />
                        <Row
                            label="Flash taskbar on new message"
                            desc="Blinks the taskbar button until you open the app"
                            right={<ClToggle checked={prefs.flash_taskbar} onChange={v => set('flash_taskbar', v)} />}
                        />
                    </>
                )}
            </Section>

            {/* ── 6. Reset ──────────────────────────────────────────────────────── */}
            <div className="flex justify-end pt-1 pb-2">
                <AnimatePresence mode="wait">
                    {confirmReset ? (
                        <motion.div
                            key="confirm"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -4 }}
                            className="flex items-center gap-3 rounded-xl px-4 py-2.5"
                            style={{ background: 'var(--cl-deep)', border: '1px solid var(--cl-border)' }}
                        >
                            <span className="text-[13px]" style={{ color: 'var(--cl-muted)' }}>Reset all notification settings?</span>
                            <ClButton
                                size="sm"
                                variant="danger"
                                onClick={() => { resetPrefs(); setConfirmReset(false); }}
                            >
                                Reset
                            </ClButton>
                            <ClButton
                                size="sm"
                                variant="ghost"
                                onClick={() => setConfirmReset(false)}
                            >
                                Cancel
                            </ClButton>
                        </motion.div>
                    ) : (
                        <motion.div
                            key="idle"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                        >
                            <ClButton
                                variant="ghost"
                                size="sm"
                                onClick={() => setConfirmReset(true)}
                            >
                                <RotateCcw size={12} /> Reset to defaults
                            </ClButton>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};
