/**
 * NotificationsTab — full notification settings panel.
 */

import React, { useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    Bell, BellOff, Volume2, VolumeX, Clock, AtSign, Phone, RotateCcw,
    Plus, X, Info, Gamepad2, ScreenShare, Play, SlidersHorizontal,
} from 'lucide-react';
import { useNotificationPrefs, DEFAULT_PREFS } from '../contexts/NotificationContext';
import { useAuth } from '../contexts/AuthContext';
import { useNudgeOffSwitch } from '../hooks/useNudgeOffSwitch';
import type { NotificationPrefs, SoundCategoryPrefs } from '../contexts/NotificationContext';
import type { SoundCategory } from '../utils/notificationSounds';
import { playSound, ringVolumeOf, RING_VOLUME_CATEGORY, DEFAULT_SOUND_PREFS } from '../utils/notificationSounds';
import { ClToggle, ClButton, ClInput, ClSelect, ClSlider } from './cl';
import type { ClSelectOption } from './cl';
import { SettingsDisclosure } from './settings/SettingsDisclosure';
import { IDLE_TIMEOUT_CHOICES_MINUTES, normalizeIdleTimeoutMinutes } from '../utils/idleThreshold';

const reveal = {
    initial:    { height: 0, opacity: 0 },
    animate:    { height: 'auto' as const, opacity: 1 },
    exit:       { height: 0, opacity: 0 },
    transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

const PREVIEW_OPTIONS: ClSelectOption<string>[] = [
    { value: 'full',        label: 'Full message' },
    { value: 'sender_only', label: 'Sender name only' },
    { value: 'hidden',      label: 'Hidden' },
];

// ── Idle timeout choices (minutes) — the one value behind auto-Away and
//    cross-device notification routing (utils/idleThreshold.ts) ─────────────

const IDLE_TIMEOUT_OPTIONS: ClSelectOption<string>[] = IDLE_TIMEOUT_CHOICES_MINUTES.map(m => ({
    value: String(m),
    label: m === 1 ? '1 minute' : `${m} minutes`,
}));

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
}> = ({ title, badge, children }) => (
    <div className="sd-card" style={{ padding: '0 6px' }}>
        {/* Plain card heading, same as every other pane — the pane header
            already carries this section's glyph, so no icon tile here. */}
        <div className="flex items-center gap-3" style={{ padding: '20px 16px 4px' }}>
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
            {/* Type matches the shared .sd-row vocabulary: 14/800 label, 12.5 muted line. */}
            <p className="text-[14px] font-extrabold leading-snug" style={{ color: indent ? 'var(--cl-muted)' : 'var(--cl-text)' }}>{label}</p>
            {desc && <p className="text-[12.5px] mt-0.5 leading-snug" style={{ color: 'var(--cl-muted)' }}>{desc}</p>}
        </div>
        {right && <div className="shrink-0">{right}</div>}
    </div>
);

const Divider = () => <div className="border-t mx-4" style={{ borderColor: 'rgba(42,53,88,.5)' }} />;

const SubLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="px-4 pt-3.5 pb-1.5 text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--cl-faint)' }}>{children}</p>
);

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ── Main component ────────────────────────────────────────────────────────────

export const NotificationsTab: React.FC = () => {
    const { prefs, updatePrefs, resetPrefs } = useNotificationPrefs();
    const { userId } = useAuth();
    const [tipsOn, setTipsOn] = useNudgeOffSwitch(userId);
    const [confirmReset, setConfirmReset] = useState(false);
    const [newKeyword, setNewKeyword]     = useState('');
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
                                            resetValue={Math.round(DEFAULT_PREFS.master_volume * 100)}
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
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
                            onChange={v => set('show_preview', v as any)}
                            options={PREVIEW_OPTIONS}
                            style={{ width: 160 }}
                        />
                    }
                />
                <Divider />
                <Row
                    label="Idle timeout"
                    desc="How long you can be away from this computer before it counts as idle. You show as Away, and new messages start going to your phone."
                    right={
                        <ClSelect<string>
                            value={String(normalizeIdleTimeoutMinutes(prefs.idle_timeout_minutes))}
                            onChange={v => set('idle_timeout_minutes', normalizeIdleTimeoutMinutes(Number(v)))}
                            options={IDLE_TIMEOUT_OPTIONS}
                            style={{ width: 160 }}
                        />
                    }
                />
                <div className="px-4">
                    <SettingsDisclosure
                        id="notifications.more"
                        title="More options"
                        summary="Profile pictures, quick reply, when to stay quiet, the taskbar badge and tips."
                        icon={<SlidersHorizontal size={15} />}
                        labels={['Quick reply', 'Badge count', 'Flash taskbar', 'Getting-started tips', 'Show profile pictures']}
                    >
                        <div className="-mx-4">
                            <Row
                                label="Show profile pictures"
                                desc="Use the sender's picture as the notification icon. Only when message preview is set to Full message."
                                right={
                                    <ClToggle
                                        checked={prefs.show_sender_avatar !== false}
                                        onChange={v => set('show_sender_avatar', v)}
                                        disabled={prefs.show_preview !== 'full'}
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
                            <Divider />
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
                        </div>
                    </SettingsDisclosure>
                </div>
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

                <div className="px-4">
                    <SettingsDisclosure
                        id="notifications.dnd-auto"
                        title="Schedule & auto-pause"
                        summary="Quiet hours, pausing during calls, screen share or games, and letting @mentions through."
                        icon={<Clock size={15} />}
                        badge={prefs.dnd_schedule.enabled ? 'Schedule on' : null}
                        labels={['DND schedule']}
                    >
                        <div className="-mx-4">
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
                                            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped cast across a dynamic boundary (REST/WS payload, DOM, or third-party type gap)
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
                        </div>
                    </SettingsDisclosure>
                </div>
            </Section>

            {/* ── 3. Mention Keywords ───────────────────────────────────────────── */}
            <Section icon={<AtSign size={13} />} title="Mention keywords">
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

            {/* ── 4. Incoming calls ────────────────────────────────────────────────
                Owner, 2026-11-08: the per-event sound pickers and custom sound
                uploads are gone. Every cue plays its stock sound; the one level
                people asked to tune is how loud an incoming call rings. The
                slider is on top of the master volume, like every cue. */}
            <Section icon={<Phone size={13} />} title="Incoming calls">
                <div className="px-4 py-3">
                    <p className="text-[13.5px] font-medium" style={{ color: 'var(--cl-text)' }}>Ringtone volume</p>
                    <p className="text-[11.5px] mt-0.5 mb-3 leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                        {prefs.sounds_enabled
                            ? 'How loud an incoming call rings. 0% rings silently (you still see the call).'
                            : 'Turn on Notification sounds above to hear incoming calls.'}
                    </p>
                    <div className="flex items-center gap-3 rounded-xl px-3.5 py-3" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)', opacity: prefs.sounds_enabled ? 1 : 0.5 }}>
                        <VolumeX size={13} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                        <div style={{ flex: 1 }}>
                            <ClSlider
                                min={0} max={100} step={5}
                                value={Math.round(ringVolumeOf(prefs) * 100)}
                                onChange={v => setSound(RING_VOLUME_CATEGORY, { volume: v / 100 })}
                                resetValue={Math.round(DEFAULT_SOUND_PREFS[RING_VOLUME_CATEGORY].volume * 100)}
                                formatLabel={v => `${v}%`}
                                disabled={!prefs.sounds_enabled}
                                ariaLabel="Incoming call ringtone volume"
                            />
                        </div>
                        <Volume2 size={13} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                        <span className="text-[12px] w-9 text-right font-mono shrink-0" style={{ color: 'var(--cl-muted)' }}>
                            {Math.round(ringVolumeOf(prefs) * 100)}%
                        </span>
                        <ClButton
                            size="sm"
                            variant="ghost"
                            disabled={!prefs.sounds_enabled || ringVolumeOf(prefs) === 0}
                            onClick={() => playSound(RING_VOLUME_CATEGORY, prefs)}
                        >
                            <Play size={12} /> Test
                        </ClButton>
                    </div>
                </div>
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
