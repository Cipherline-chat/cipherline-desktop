import React, { useRef, useState } from 'react';
import { Play, Check } from 'lucide-react';
import { ClToggle, ClButton, ClSelect } from '../../cl';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import { ColourSwatchButton } from '../ui/ColourPicker';
import { SettingsDisclosure } from '../SettingsDisclosure';
import '../../../styles/settings-ui.css';
import { useAuth } from '../../../contexts/AuthContext';
import { useNotificationPrefs } from '../../../contexts/NotificationContext';
import { useCallPersonalization, saveOwnCallPersonalization } from '../../../utils/callPersonalizationStore';
import {
    DEFAULT_RING_COLOR, RING_PRESETS, isRingHex, isReadableRing, speakingShadow,
} from '../../../utils/callPersonalizationStyle';
import { ENTRANCE_SOUNDS } from '../../../utils/entranceSounds';
import { previewEntranceSound } from '../../../utils/entrancePlayback';
import { useEntrancePrefs, setEntranceSoundsEnabled, setEntranceMuted } from '../../../utils/entrancePrefs';
import { customContentId, customEntranceSoundValue, isCustomEntranceSoundId } from '../../../utils/customEntranceSound/constants';
import { ownEntranceSound } from '../../../utils/customEntranceSound/ownStore';
import { CustomEntranceEditor, CustomEntranceStatus } from './CustomEntranceSound';
import { useOwnEntranceSound } from '../../../utils/customEntranceSound/ui';

/**
 * Settings > Personalize > Calls. Three things, all free, all public cosmetics:
 *   - the color of your speaking ring (everyone in a call sees it), shown on
 *     your own avatar; a custom one comes from Cipherline's color picker,
 *   - the sound that plays for others when you join: a built-in one, or your
 *     own (CustomEntranceSound.tsx; the audio never goes to the server),
 *   - your own listener switch for other people's entrance sounds.
 * Saved to the server (so every device and every other person sees them);
 * the listener switch is a device preference (utils/entrancePrefs.ts).
 */

/** Roving-tabindex radio group behaviour: arrows / Home / End move AND select. */
function useRovingRadios(count: number, selected: number, pick: (i: number) => void) {
    const refs = useRef<Array<HTMLElement | null>>([]);
    const [focusIdx, setFocusIdx] = useState<number | null>(null);
    const active = focusIdx ?? (selected >= 0 ? selected : 0);
    const go = (i: number) => {
        const next = (i + count) % count;
        setFocusIdx(next);
        refs.current[next]?.focus();
        pick(next);
    };
    return {
        setRef: (i: number) => (el: HTMLElement | null) => { refs.current[i] = el; },
        tabIndex: (i: number) => (i === active ? 0 : -1),
        onFocus: (i: number) => () => setFocusIdx(i),
        onKeyDown: (i: number) => (e: React.KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowRight': case 'ArrowDown': e.preventDefault(); go(i + 1); break;
                case 'ArrowLeft': case 'ArrowUp': e.preventDefault(); go(i - 1); break;
                case 'Home': e.preventDefault(); go(0); break;
                case 'End': e.preventDefault(); go(count - 1); break;
                default: break;
            }
        },
    };
}

export const CallPersonalizeCard: React.FC = () => {
    const { userId, user, token } = useAuth();
    const mine = useCallPersonalization(userId);
    const listener = useEntrancePrefs();
    const notif = useNotificationPrefs();
    const [error, setError] = useState('');
    const [announce, setAnnounce] = useState('');
    const [customMsg, setCustomMsg] = useState('');

    const save = async (patch: { ring_color?: string | null; entrance_sound?: string | null }, said: string) => {
        if (!userId) return;
        setError('');
        try {
            await saveOwnCallPersonalization(userId, patch);
            setAnnounce(said);
        } catch {
            setError('Could not save that. Check your connection and try again.');
        }
    };

    // ── ring colour ─────────────────────────────────────────────────────────
    const isPreset = mine.ring_color !== null && RING_PRESETS.some(o => o.hex === mine.ring_color);
    // A custom colour shows up as its own (selected) swatch, so the row always reflects the choice.
    const ringOptions = [
        { id: 'default', label: 'Default', hex: DEFAULT_RING_COLOR },
        ...RING_PRESETS,
        ...(mine.ring_color !== null && !isPreset ? [{ id: 'custom', label: `Custom ${mine.ring_color}`, hex: mine.ring_color }] : []),
    ];
    const ringSelected = mine.ring_color === null ? 0 : ringOptions.findIndex(o => o.hex === mine.ring_color);
    const pickRing = (i: number) => {
        const o = ringOptions[i];
        setCustomMsg('');
        void save({ ring_color: i === 0 ? null : o.hex }, `Speaking ring: ${o.label}`);
    };
    const ringRoving = useRovingRadios(ringOptions.length, ringSelected, pickRing);
    /** A color from the picker: saved only when it reads against the dark call background. */
    const applyCustom = (hex: string) => {
        const norm = hex.trim().toLowerCase();
        if (!isRingHex(norm)) { setCustomMsg('Use a color like #25e0c8.'); return; }
        if (!isReadableRing(norm)) { setCustomMsg('That one is too dark to see against the dark background. Try a brighter shade.'); return; }
        setCustomMsg('');
        void save({ ring_color: norm }, `Speaking ring: ${norm}`);
    };

    // ── entrance sound ──────────────────────────────────────────────────────
    const own = useOwnEntranceSound();
    const [editingCustom, setEditingCustom] = useState(false);
    const [removing, setRemoving] = useState(false);
    const serverCustom = isCustomEntranceSoundId(mine.entrance_sound);
    const customBlurb = own ? `Your own sound, ${(own.durationMs / 1000).toFixed(1)} s` : 'Upload your own, up to 2.5 s';
    const soundOptions = [
        { id: null as string | null, label: 'None', blurb: 'Joining is silent' },
        ...ENTRANCE_SOUNDS,
        { id: 'custom', label: own || serverCustom ? 'Custom' : 'Custom…', blurb: customBlurb },
    ];
    const soundSelected = editingCustom || serverCustom
        ? soundOptions.length - 1
        : Math.max(0, soundOptions.findIndex(o => o.id === mine.entrance_sound));
    const soundNow = soundOptions[soundSelected];
    const isCustomNow = soundNow.id === 'custom';
    const pickSound = (v: string) => {
        if (v !== 'custom') {
            setEditingCustom(false);
            void save({ entrance_sound: v === 'none' ? null : v }, `Entrance sound: ${soundOptions.find(o => (o.id ?? 'none') === v)?.label ?? v}`);
            return;
        }
        // Custom: turn on the one this device holds, or open the editor to make one.
        if (own) {
            setEditingCustom(false);
            if (customContentId(mine.entrance_sound) !== own.id) {
                void save({ entrance_sound: customEntranceSoundValue(own.id) }, 'Entrance sound: your custom sound');
            }
        } else {
            setEditingCustom(true);
        }
    };
    const removeCustom = async () => {
        setRemoving(true);
        setError('');
        try {
            await ownEntranceSound().remove();
            if (serverCustom) await save({ entrance_sound: null }, 'Custom entrance sound removed');
            else setAnnounce('Custom entrance sound removed');
        } finally {
            setRemoving(false);
            setEditingCustom(false);
        }
    };
    const previewNow = () => {
        if (!soundNow.id || isCustomNow) return;
        previewEntranceSound(soundNow.id, notif.prefs);
    };
    const ringNow = ringOptions[Math.max(0, ringSelected)];
    const summary = `Ring: ${ringNow.label} · Sound: ${soundNow.label}`;

    return (
        <SettingsDisclosure
            id="personalize.calls" variant="card" title="Calls" summary={summary}
            labels={['Calls', 'Speaking ring', 'Entrance sound', 'Custom entrance sound']}
        >
            <p className="su-hint" style={{ margin: '0 0 4px' }}>
                Free for everyone. Others in the call see your ring color and hear your sound.
            </p>

            {/* Speaking ring: one swatch row, the preview ring beside it */}
            <div className="su-row">
                <div className="su-row-text">
                    <span className="su-row-label" id="ring-label">Speaking ring</span>
                    <span className="su-row-hint">{ringNow.label}</span>
                </div>
                <div className="su-ring">
                    {/* Your own avatar, ringed the way the others will see you speaking. */}
                    <div
                        className="su-ring-you"
                        style={{ boxShadow: speakingShadow(mine.ring_color, { glow: 10, alpha: 0.4 }) }}
                        aria-hidden="true"
                        data-testid="ring-preview"
                    >
                        <EncryptedAvatar
                            attachmentId={user?.avatar_url ?? null} userId={userId ?? undefined} token={token}
                            className="w-full h-full" fallbackSize={18} disableClickProfile
                        />
                    </div>
                    <div role="radiogroup" aria-labelledby="ring-label" className="flex flex-wrap items-center gap-1.5">
                        {ringOptions.map((o, i) => {
                            const on = i === ringSelected;
                            return (
                                <button
                                    key={o.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    aria-label={o.label}
                                    title={o.label}
                                    ref={ringRoving.setRef(i)}
                                    tabIndex={ringRoving.tabIndex(i)}
                                    onFocus={ringRoving.onFocus(i)}
                                    onKeyDown={ringRoving.onKeyDown(i)}
                                    onClick={() => pickRing(i)}
                                    className="su-ring-dot"
                                    style={{ background: o.hex }}
                                >
                                    {on && <Check size={12} strokeWidth={3} className="text-black/70" aria-hidden="true" />}
                                </button>
                            );
                        })}
                        <ColourSwatchButton
                            value={mine.ring_color ?? DEFAULT_RING_COLOR} label="Custom ring color" size={24}
                            presets={RING_PRESETS.map(o => o.hex)} className="cp-trigger--dashed"
                            triggerLabel="Pick a custom ring color" onCommit={applyCustom}
                        >+</ColourSwatchButton>
                    </div>
                </div>
            </div>
            {customMsg && <p className="text-xs text-cl-flash m-0 pb-3" role="alert">{customMsg}</p>}

            {/* Entrance sound: a select and a preview button */}
            <div className="su-row">
                <div className="su-row-text">
                    <span className="su-row-label" id="entrance-label">Entrance sound</span>
                    <span className="su-row-hint">{soundNow.blurb}. Plays for the others when you join.</span>
                </div>
                <div className="su-row-ctl">
                    <div style={{ width: 172 }}>
                        <ClSelect
                            ariaLabel="Entrance sound"
                            value={soundNow.id ?? 'none'}
                            options={soundOptions.map(o => ({ value: o.id ?? 'none', label: o.label }))}
                            onChange={pickSound}
                            style={{ width: '100%' }}
                        />
                    </div>
                    {!isCustomNow && (
                        <ClButton
                            size="sm"
                            variant="ghost"
                            disabled={!soundNow.id}
                            aria-label={`Preview ${soundNow.label}`}
                            onClick={previewNow}
                        >
                            <Play size={13} className="mr-1" aria-hidden="true" />Preview
                        </ClButton>
                    )}
                </div>
            </div>
            {isCustomNow && userId && (editingCustom ? (
                <CustomEntranceEditor
                    userId={userId}
                    prefs={notif.prefs}
                    onDone={said => { setEditingCustom(false); setError(''); setAnnounce(said); }}
                    onCancel={() => setEditingCustom(false)}
                    onError={setError}
                />
            ) : (
                <CustomEntranceStatus
                    own={own}
                    serverValue={mine.entrance_sound}
                    prefs={notif.prefs}
                    onReplace={() => setEditingCustom(true)}
                    onRemove={() => { void removeCustom(); }}
                    removing={removing}
                />
            ))}

            {/* Listener controls */}
            <div className="su-row">
                <div className="su-row-text">
                    <span className="su-row-label" id="play-entrance-label">Play entrance sounds</span>
                    <span className="su-row-hint">Hear other people&rsquo;s sounds when they join. Silence one person from their menu.</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={listener.enabled} onChange={setEntranceSoundsEnabled} aria-label="Play entrance sounds" />
                </div>
            </div>
            {listener.muted.length > 0 && (
                <div className="flex items-center gap-3 text-[12px] text-cl-faint pb-1">
                    <span>{listener.muted.length} {listener.muted.length === 1 ? 'person is' : 'people are'} muted for entrance sounds.</span>
                    <ClButton size="sm" variant="ghost" onClick={() => [...listener.muted].forEach(id => setEntranceMuted(id, false))}>Unmute all</ClButton>
                </div>
            )}

            {error && <div className="text-xs text-cl-flash mt-3" role="alert">{error}</div>}
            <div className="sr-only" role="status" aria-live="polite">{announce}</div>
        </SettingsDisclosure>
    );
};

export default CallPersonalizeCard;
