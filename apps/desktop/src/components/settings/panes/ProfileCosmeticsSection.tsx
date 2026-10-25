import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Check, Lock, Palette, Sparkles, Wand2 } from 'lucide-react';
import { API_BASE } from '../../../constants';
import { useToast } from '../../../contexts/ToastContext';
import { AvatarDecoration, ProfileEffect } from '../../ProfileCosmetics';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import { SettingsDisclosure } from '../SettingsDisclosure';
import { useTileArrows } from '../ui/useTileArrows';
import { ColourPickerPanel } from '../ui/ColourPicker';
import { HueSlider } from '../ui/HueSlider';
import type { ProfilePreviewData } from './ProfilePreviewCard';
import { useFoundEggs } from '../../../hooks/useFoundEggs';
import { useUserAchievements } from '../../../hooks/useUserAchievements';
import { useEncryptedAvatar } from '../../../hooks/useEncryptedAvatar';
import { useImagePalette } from '../../../hooks/useImagePalette';
import { usePersonalEmojiLibrary } from '../../../hooks/usePersonalEmojis';
import { STATUS_EMOJI_MIMES } from '../../../utils/personalEmoji/statusEmoji';
import StatusPersonalEmoji from '../../StatusPersonalEmoji';
import {
    AVATAR_DECORATIONS, PROFILE_EFFECTS, COLOUR_LEVELS, HUE_PRESETS,
    findDecoration, findEffect, hueTint, isUnlocked, joinDecorationId, optionSpecsFor, readItemOptions, seasonalPickable, shortUnlockHint,
    splitDecorationId, supportsColour, unlockHint,
    type CosmeticItem, type CosmeticOptions, type DecorationColour, type ItemOptions, type OptionKey, type OptionSpec,
} from '../../../utils/profileCosmetics';
import {
    THEME_PRESETS, matchTint, themeEquals, themeSwatch, type ProfileTheme,
} from '../../../utils/profileTheme';
import { suggestedColours, themesFromPalette, type ThemeProposal } from '../../../utils/palette';
import { patchErrorMessage } from '../../../utils/patchErrorMessage';
import '../../../styles/profile-settings.css';

/**
 * Settings > Profile > Style: theme, avatar decoration and profile effect.
 *
 * One studio, everything inline (owner, 2026-10-24: "I didn't even realize the
 * customization existed because I had to scroll down"):
 *
 *   [ Theme | Decoration | Effect ]   which one you are styling, with its current value
 *   inspector                         the chosen item: name, what it is, lock state, and
 *                                     its OPTIONS right there (color, intensity, density,
 *                                     speed) - beside the live preview, never below the fold
 *   grid                              every item, wearing YOUR avatar
 *
 *  - Pointing at a tile (hover / keyboard focus) tries it on in the live
 *    preview; the inspector stays on what you picked, so its controls never
 *    jump while you move the mouse. Clicking an unlocked item applies and
 *    saves it; clicking a locked one previews it and the inspector says how to
 *    earn it (the server rejects a locked id anyway, 403).
 *  - Options are rendered from the catalog's schema (optionSpecsFor): hue,
 *    ranges, choices, colourways and an image source each have one control, so new items and
 *    new knobs appear here with no UI change. A knob previews at once and saves
 *    a moment later.
 *  - Theme: presets, your own pair (Cipherline's colour picker, with
 *    suggestions from your banner), and "Match my banner": a pair proposed
 *    from your banner's colours, previewed before you apply it.
 *
 * Every save PATCHes only the key that changed (an older API keeps working).
 * Nothing in this section is a paid perk.
 */

export interface CosmeticsSaved {
    profile_theme?: ProfileTheme | null;
    avatar_decoration?: string | null;
    profile_effect?: string | null;
    cosmetic_options?: CosmeticOptions | null;
    /** Seasons this account claimed (/auth/me), for the limited-time items. */
    cosmetic_claims?: string[];
}

export interface ProfileCosmeticsSectionProps {
    token: string | null;
    saved: CosmeticsSaved;
    /** Identity, so the pickers can show YOUR avatar wearing each item, and Match my banner can read your banner. */
    base: Pick<ProfilePreviewData, 'userId' | 'token' | 'avatarAttachmentId'> & Partial<Pick<ProfilePreviewData, 'bannerAttachmentId' | 'bannerSrc'>>;
    /** Server-computed profile level (0 until /auth/me has it). */
    level?: number;
    /** Drafts for the pane's live preview card. */
    onPreview?: (patch: Partial<ProfilePreviewData>) => void;
    /** After a successful save (the caller refreshes /auth/me). */
    onSaved: (body: Record<string, unknown>) => void | Promise<void>;
    /** The Style tab is showing. Leaving it ends any try-on / theme proposal (they are never saved). */
    active?: boolean;
}

const OPTION_SAVE_MS = 700;
/** Where the hue slider sits (and resets to) before you pick one: the lume teal. */
const HUE_DEFAULT = 172;
const THEME_SAVE_MS = 900;

type Studio = 'theme' | 'decoration' | 'effect';

// ── thumbnails: your own avatar, wearing the thing ───────────────────────────

const OwnFace: React.FC<{ base: ProfileCosmeticsSectionProps['base'] }> = ({ base }) => (
    <EncryptedAvatar attachmentId={base.avatarAttachmentId} userId={base.userId} token={base.token} className="w-full h-full" fallbackSize={16} disableClickProfile bypassFriendGate />
);

const DecoThumb: React.FC<{ decoration: string | null; tint: string | null; base: ProfileCosmeticsSectionProps['base']; size?: number; options?: ItemOptions | null }> = ({ decoration, tint, base, size = 36, options }) => (
    <AvatarDecoration decoration={decoration} tint={tint} options={options} className="shrink-0">
        <span className="su-avatar-face" style={{ width: size, height: size }}><OwnFace base={base} /></span>
    </AvatarDecoration>
);

const EffectThumb: React.FC<{ effect: string | null; tint: string | null; base: ProfileCosmeticsSectionProps['base']; small?: boolean; options?: ItemOptions | null; play?: boolean }> = ({ effect, tint, base, small, options, play }) => (
    <span className={`su-fx-thumb${small ? ' su-fx-thumb--sm' : ''}`}>
        <span className="su-fx-thumb-face"><OwnFace base={base} /></span>
        <ProfileEffect effect={effect} tint={tint} options={options} loop={!!play} />
    </span>
);

// ── a tile in the grid ───────────────────────────────────────────────────────

const Tile: React.FC<{
    name: string;
    on: boolean;
    locked: boolean;
    short: string;
    full: string;
    disabled: boolean;
    onPick: () => void;
    onPoint: (pointing: boolean) => void;
    children: (hot: boolean) => React.ReactNode;
}> = ({ name, on, locked, short, full, disabled, onPick, onPoint, children }) => {
    const [hot, setHot] = useState(false);
    return (
        <button
            type="button" data-tile role="radio" aria-checked={on}
            aria-disabled={disabled || undefined}
            aria-label={locked ? `${name}, locked. ${full}. Select to preview it.` : name}
            data-locked={locked ? 'true' : undefined}
            className="pst-tile"
            onMouseEnter={() => { setHot(true); onPoint(true); }} onMouseLeave={() => { setHot(false); onPoint(false); }}
            onFocus={() => { setHot(true); onPoint(true); }} onBlur={() => setHot(false)}
            onClick={() => { if (!disabled) onPick(); }}
        >
            <span className="pst-tile-prev">{children(hot || on)}</span>
            <span className="pst-tile-name">{name}</span>
            {locked ? <span className="pst-tile-lock"><Lock size={10} aria-hidden="true" />{short}</span>
                : on ? <span className="pst-tile-on" aria-hidden="true"><Check size={11} strokeWidth={3} /></span> : null}
        </button>
    );
};

// ── the inspector: what you picked, and its knobs ────────────────────────────

const Inspector: React.FC<{
    thumb: React.ReactNode;
    title: string;
    blurb?: string;
    state: 'on' | 'locked' | 'none';
    lockHint?: string;
    onLeaveTryOn?: () => void;
    leaveLabel?: string;
    children?: React.ReactNode;
}> = ({ thumb, title, blurb, state, lockHint, onLeaveTryOn, leaveLabel, children }) => (
    <div className="pst-insp" data-state={state} data-testid="style-inspector">
        <div className="pst-insp-head">
            <span className="pst-insp-thumb">{thumb}</span>
            <div className="pst-insp-txt" aria-live="polite">
                <div className="pst-insp-title">
                    <b>{title}</b>
                    {state === 'on' && <span className="pst-insp-chip pst-insp-chip--on"><Check size={11} strokeWidth={3} aria-hidden="true" /> On your card</span>}
                    {state === 'locked' && <span className="pst-insp-chip pst-insp-chip--lock"><Lock size={11} aria-hidden="true" /> Locked</span>}
                </div>
                {state === 'locked' ? (
                    <p className="pst-insp-lock">{lockHint}. It is on the preview so you can see it; it will not be saved.</p>
                ) : blurb ? <p>{blurb}</p> : null}
                {state === 'locked' && onLeaveTryOn && (
                    <button type="button" className="pst-link" onClick={onLeaveTryOn}>{leaveLabel}</button>
                )}
            </div>
        </div>
        {children}
    </div>
);

/**
 * keepsake-rain's picture: your avatar, or one of YOUR My Emojis (PNG / WebP /
 * GIF - the types a friend's client accepts, utils/personalEmoji/statusEmoji.ts).
 * Never an upload: the server stores only the id, and friends get the image
 * device-to-device.
 */
const ImageSourceControl: React.FC<{ label: string; value: string | undefined; disabled?: boolean; onPick: (m: string | undefined) => void; base: ProfileCosmeticsSectionProps['base'] }> = ({ label, value, disabled, onPick, base }) => {
    const { entries } = usePersonalEmojiLibrary();
    const usable = entries.filter((e) => STATUS_EMOJI_MIMES.includes(e.mime)).slice(0, 24);
    const current = value ?? 'avatar';
    return (
        <div className="pst-opt pst-opt--img">
            <span className="pst-opt-label">{label}</span>
            <div className="pst-imgsrc-col">
                <div className="pst-imgsrc" role="radiogroup" aria-label={label}>
                    <button type="button" role="radio" aria-checked={current === 'avatar'} disabled={disabled} className="pst-imgsrc-btn"
                        onClick={() => onPick(undefined)} title="Your avatar" aria-label="Your avatar">
                        <span className="pst-imgsrc-face"><OwnFace base={base} /></span>
                    </button>
                    {usable.map((e) => (
                        <button key={e.id} type="button" role="radio" aria-checked={current === e.id} disabled={disabled} className="pst-imgsrc-btn"
                            onClick={() => onPick(e.id)} title={e.name} aria-label={e.name}>
                            <StatusPersonalEmoji id={e.id} />
                        </button>
                    ))}
                </div>
                <p className="pst-note">{usable.length ? 'Friends see your emoji once their app has it; everyone else sees soft droplets.' : 'Add a PNG, WebP or GIF to My Emojis to rain it instead of your avatar.'}</p>
            </div>
        </div>
    );
};

/**
 * The knobs an applied item takes, rendered generically from the catalog's
 * option schema (utils/profileCosmetics optionSpecsFor): hue, range, choice,
 * colourway and image source. A value equal to the spec's default is stored as
 * nothing, so the default stays the default if it ever changes.
 */
const OptionControls: React.FC<{
    specs: readonly OptionSpec[];
    value: ItemOptions;
    onChange: (next: ItemOptions) => void;
    disabled?: boolean;
    label: string;
    /** The colour "Match my theme" resolves to (for its swatch). */
    matchColour: string;
    base: ProfileCosmeticsSectionProps['base'];
}> = ({ specs, value, onChange, disabled, label, matchColour, base }) => {
    if (!specs.length) return null;
    const set = (k: OptionKey, v: number | string | undefined) => {
        const next: Record<string, number | string> = { ...value };
        if (v === undefined) delete next[k]; else next[k] = v;
        onChange(next as ItemOptions);
    };
    const num = (k: OptionKey): number | undefined => (typeof value[k as keyof ItemOptions] === 'number' ? value[k as keyof ItemOptions] as number : undefined);
    return (
        <div className="pst-opts" role="group" aria-label={`${label} options`} data-testid="cosmetic-options">
            {specs.map((spec) => spec.type === 'image-source' ? (
                <ImageSourceControl key={spec.key} label={spec.label} value={value.m} disabled={disabled} base={base} onPick={(m) => set('m', m)} />
            ) : spec.type === 'color' ? (
                <div key={spec.key} className="pst-opt">
                    <span className="pst-opt-label">{spec.label}</span>
                    <div className="pst-hue-dots" role="radiogroup" aria-label={spec.label}>
                        {spec.choices.map((c) => (
                            <button key={c.value} type="button" role="radio" className="pst-dot" aria-checked={(num(spec.key) ?? spec.default) === c.value}
                                aria-pressed={(num(spec.key) ?? spec.default) === c.value} disabled={disabled}
                                style={{ background: c.hex }} aria-label={c.label} title={c.label}
                                onClick={() => set(spec.key, c.value === spec.default ? undefined : c.value)} />
                        ))}
                    </div>
                </div>
            ) : spec.type === 'choice' || spec.type === 'range' ? (
                <div key={spec.key} className="pst-opt">
                    <span className="pst-opt-label">{spec.label}</span>
                    <div className="ps-seg3" role="radiogroup" aria-label={spec.label}>
                        {(spec.type === 'choice' ? spec.choices.map((c) => ({ v: c.value, w: c.label })) : spec.words.map((w, i) => ({ v: spec.min + i, w }))).map(({ v, w }) => {
                            const on = (num(spec.key) ?? spec.default) === v;
                            return (
                                <button key={w} type="button" role="radio" aria-checked={on} disabled={disabled}
                                    onClick={() => set(spec.key, v === spec.default ? undefined : v)}>{w}</button>
                            );
                        })}
                    </div>
                </div>
            ) : (
                <div key={spec.key} className="pst-opt pst-opt--hue">
                    <span className="pst-opt-label">{spec.label}</span>
                    <div className="pst-hue">
                        <div className="pst-hue-dots">
                            <button type="button" className="pst-match" aria-pressed={value.h === undefined} disabled={disabled}
                                onClick={() => set('h', undefined)} title="Use your theme's color">
                                <span className="pst-match-sw" style={{ background: matchColour }} aria-hidden="true" />Match theme
                            </button>
                            {HUE_PRESETS.map((h) => (
                                <button key={h} type="button" className="pst-dot" aria-pressed={value.h === h} disabled={disabled}
                                    style={{ background: hueTint(h) ?? undefined }} aria-label={`Color, ${h} degrees`} title={`${h}°`} onClick={() => set('h', h)} />
                            ))}
                        </div>
                        <div className="pst-hue-track">
                            <HueSlider
                                track="tint" max={359} disabled={disabled} unset={value.h === undefined}
                                value={value.h ?? HUE_DEFAULT} label={`${label} color`}
                                valueText={value.h === undefined ? 'Matches your theme' : `${value.h} degrees`}
                                onChange={(v) => set('h', Math.round(v))}
                                onReset={() => set('h', undefined)}
                            />
                            <span className="pst-hue-val" aria-hidden="true">{value.h === undefined ? 'Theme' : `${value.h}°`}</span>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

const sameOptions = (a: ItemOptions, b: ItemOptions) => JSON.stringify(a) === JSON.stringify(b);

// ── section ──────────────────────────────────────────────────────────────────

export const ProfileCosmeticsSection: React.FC<ProfileCosmeticsSectionProps> = ({
    token, saved, base, onSaved, onPreview, level = 0, active = true,
}) => {
    const toast = useToast();
    const found = useFoundEggs();
    const ach = useUserAchievements(base.userId, true);
    const achievementIds = useMemo(() => new Set((ach.data?.unlocked ?? []).map((u) => u.id)), [ach.data]);
    const [busy, setBusy] = useState(false);
    const [studio, setStudio] = useState<Studio>('decoration');

    const [theme, setTheme] = useState<ProfileTheme | null>(saved.profile_theme ?? null);
    const [decoration, setDecoration] = useState<string | null>(saved.avatar_decoration ?? null);
    const [effect, setEffect] = useState<string | null>(saved.profile_effect ?? null);
    const [decoOpts, setDecoOpts] = useState<ItemOptions>(() => readItemOptions(saved.cosmetic_options?.d, 'decoration', saved.avatar_decoration));
    const [fxOpts, setFxOpts] = useState<ItemOptions>(() => readItemOptions(saved.cosmetic_options?.e, 'effect', saved.profile_effect));
    // A custom theme pair being edited (live preview), and which of the two the picker edits.
    const [customDraft, setCustomDraft] = useState<ProfileTheme>(saved.profile_theme ?? { primary: '#25e0c8', accent: '#5e8ee0' });
    const [editing, setEditing] = useState<'primary' | 'accent'>('primary');
    // Try-ons: what you point at (hover / focus) and what you selected while it is locked.
    const [pointDeco, setPointDeco] = useState<string | null | undefined>(undefined);
    const [tryDeco, setTryDeco] = useState<string | null>(null);
    const [pointFx, setPointFx] = useState<string | null | undefined>(undefined);
    const [tryFx, setTryFx] = useState<string | null>(null);
    // "Match my banner": proposals, and the one being previewed (never saved until Apply).
    const [proposals, setProposals] = useState<ThemeProposal[] | null>(null);
    const [proposalAt, setProposalAt] = useState(0);
    const [matchWanted, setMatchWanted] = useState(false);
    const [matchError, setMatchError] = useState(false);
    // Your own pair: the picker opens on demand (a preset or a match is what most people want).
    const [customOpen, setCustomOpen] = useState(() => !!saved.profile_theme && !THEME_PRESETS.some((p) => themeEquals(saved.profile_theme ?? null, p.theme)));
    const customRef = useRef<HTMLDivElement>(null);
    useEffect(() => { if (customOpen) customRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); }, [customOpen]);

    // Follow the server copy when /auth/me refreshes (another device, or our own save).
    const savedKey = JSON.stringify([saved.profile_theme, saved.avatar_decoration, saved.profile_effect, saved.cosmetic_options]);
    const [seenKey, setSeenKey] = useState(savedKey);
    if (savedKey !== seenKey) {
        setSeenKey(savedKey);
        setTheme(saved.profile_theme ?? null);
        setDecoration(saved.avatar_decoration ?? null);
        setEffect(saved.profile_effect ?? null);
        setDecoOpts(readItemOptions(saved.cosmetic_options?.d, 'decoration', saved.avatar_decoration));
        setFxOpts(readItemOptions(saved.cosmetic_options?.e, 'effect', saved.profile_effect));
    }

    // Your banner (or avatar when there is none), decrypted locally, for "Match my banner" and the picker's suggestions.
    const bannerUrl = useEncryptedAvatar(base.bannerSrc ? null : base.bannerAttachmentId ?? null, base.token, null, { kind: 'banner' });
    const avatarUrl = useEncryptedAvatar(base.avatarAttachmentId, base.token);
    const sourceUrl = base.bannerSrc || bannerUrl || avatarUrl || null;
    const sourceName = base.bannerSrc || bannerUrl ? 'banner' : 'avatar';
    const wantPalette = studio === 'theme' && !!sourceUrl;
    const palette = useImagePalette(sourceUrl, wantPalette);
    const suggested = useMemo(() => (palette ? suggestedColours(palette, 6) : []), [palette]);
    // The click that asked for a match, resolved (while rendering) as soon as the palette is read.
    if (matchWanted && palette !== undefined) {
        setMatchWanted(false);
        const list = palette ? themesFromPalette(palette, 4) : [];
        if (list.length === 0) setMatchError(true);
        else { setProposals(list); setProposalAt(0); }
    }

    // A seasonal item you have not claimed is still yours to pick while its event runs: equipping it claims it (server-checked).
    const claimed = useMemo(() => new Set(saved.cosmetic_claims ?? []), [saved.cosmetic_claims]);
    const unlocked = (it: CosmeticItem) => isUnlocked(it.rule, found, level, achievementIds, claimed) || seasonalPickable(it.rule, claimed);
    const shownDeco = pointDeco !== undefined ? pointDeco : tryDeco ?? decoration;
    const shownFx = pointFx !== undefined ? pointFx : tryFx ?? effect;
    const proposal = proposals ? proposals[proposalAt] ?? null : null;
    const shownTheme = proposal ?? theme;

    // The pane's sticky preview shows the drafts and any try-on.
    useEffect(() => {
        onPreview?.({
            theme: shownTheme, decoration: shownDeco, effect: shownFx,
            decorationOptions: shownDeco === decoration ? decoOpts : null,
            effectOptions: shownFx === effect ? fxOpts : null,
        });
    }, [onPreview, shownTheme, shownDeco, shownFx, decoration, effect, decoOpts, fxOpts]);

    /** PATCH only `body`; on failure run `revert` and show the server's reason. */
    const save = async (body: Record<string, unknown>, revert: () => void, fallback = 'Could not save that. Please try again.'): Promise<boolean> => {
        if (!token) return false;
        setBusy(true);
        try {
            await axios.patch(`${API_BASE}/auth/profile`, body, { headers: { Authorization: `Bearer ${token}` } });
            await onSaved(body);
            return true;
        } catch (err) {
            console.error('Failed to save profile customization', err);
            revert();
            toast.push({ kind: 'error', title: 'Not saved', message: patchErrorMessage(err, fallback) });
            return false;
        } finally {
            setBusy(false);
        }
    };

    // ── theme ──
    const applyTheme = (next: ProfileTheme | null) => {
        setProposals(null);
        if (themeEquals(next, saved.profile_theme ?? null)) { setTheme(next); return; }
        const before = saved.profile_theme ?? null;
        setTheme(next);
        void save({ profile_theme: next }, () => setTheme(before));
    };
    const themeTimer = useRef<number | null>(null);
    const editCustom = (hex: string) => {
        const next = { ...customDraft, [editing]: hex };
        setProposals(null);
        setCustomDraft(next);
        setTheme(next);
        if (themeTimer.current) window.clearTimeout(themeTimer.current);
        themeTimer.current = window.setTimeout(() => { themeTimer.current = null; applyTheme(next); }, THEME_SAVE_MS);
    };
    const flushTheme = () => {
        if (!themeTimer.current) return;
        window.clearTimeout(themeTimer.current);
        themeTimer.current = null;
        applyTheme(customDraft);
    };
    // Settings closing (or another studio) with a colour still pending: save it.
    const flushRef = useRef(flushTheme);
    useEffect(() => { flushRef.current = flushTheme; });
    useEffect(() => () => flushRef.current(), []);
    // A try-on (and a theme proposal) lasts while you are looking at it: another studio, or leaving the Style tab, ends it.
    const endTryOns = () => { setProposals(null); setTryDeco(null); setTryFx(null); setPointDeco(undefined); setPointFx(undefined); };
    const chooseStudio = (s: Studio) => {
        if (s === studio) return;
        flushRef.current();
        endTryOns();
        setStudio(s);
    };
    const [seenActive, setSeenActive] = useState(active);
    if (seenActive !== active) {
        setSeenActive(active);
        if (!active) endTryOns();
    }
    useEffect(() => { if (!active) flushRef.current(); }, [active]);

    const matchBanner = () => {
        if (!sourceUrl) return;
        setMatchError(false);
        if (palette !== undefined && palette !== null) {
            const list = themesFromPalette(palette, 4);
            if (list.length) { setProposals(list); setProposalAt(0); return; }
        }
        setMatchWanted(true);
    };

    // ── decoration / effect ──
    const pickDecoration = (id: string | null) => {
        const it = id ? findDecoration(id) : null;
        if (it && !unlocked(it)) { setTryDeco(id); return; } // preview only
        setTryDeco(null);
        if (id === decoration) return;
        const before = decoration; setDecoration(id);
        setDecoOpts(readItemOptions(saved.cosmetic_options?.d, 'decoration', id));
        void save({ avatar_decoration: id }, () => setDecoration(before));
    };
    const pickEffect = (id: string | null) => {
        const it = id ? findEffect(id) : null;
        if (it && !unlocked(it)) { setTryFx(id); return; }
        setTryFx(null);
        if (id === effect) return;
        const before = effect; setEffect(id);
        setFxOpts(readItemOptions(saved.cosmetic_options?.e, 'effect', id));
        void save({ profile_effect: id }, () => setEffect(before));
    };

    // Knobs: preview at once, save a moment after the last change.
    const optTimer = useRef<Record<'d' | 'e', number | null>>({ d: null, e: null });
    const changeOptions = (slot: 'd' | 'e', next: ItemOptions) => {
        const before = slot === 'd' ? decoOpts : fxOpts;
        if (sameOptions(before, next)) return;
        (slot === 'd' ? setDecoOpts : setFxOpts)(next);
        const t = optTimer.current[slot];
        if (t) window.clearTimeout(t);
        optTimer.current[slot] = window.setTimeout(() => {
            optTimer.current[slot] = null;
            void save({ cosmetic_options: { [slot]: Object.keys(next).length ? next : null } }, () => (slot === 'd' ? setDecoOpts : setFxOpts)(before));
        }, OPTION_SAVE_MS);
    };

    // ── labels ──
    const tint = matchTint(shownTheme);
    const presetOn = theme ? THEME_PRESETS.find((p) => themeEquals(theme, p.theme)) : null;
    const themeName = !theme ? 'Default' : presetOn?.label ?? 'Custom';
    const decoSplit = splitDecorationId(decoration);
    const decoItem = findDecoration(decoration);
    const decoBase = decoSplit.base ? findDecoration(decoSplit.base) : null;
    const decoName = !decoration ? 'None' : decoColourName(decoBase?.label ?? decoItem?.label ?? 'Custom', decoSplit.colour);
    const effectName = findEffect(effect)?.label ?? 'None';
    const styleSummary = [themeName !== 'Default' && `${themeName} theme`, decoration && decoName, effect && effectName]
        .filter(Boolean).join(', ') || 'Default look';

    const baseDecorations = AVATAR_DECORATIONS.filter((d) => !/-(ember|violet)$/.test(d.id));
    const decoGrid = useRef<HTMLDivElement>(null);
    const fxGrid = useRef<HTMLDivElement>(null);
    const decoKeys = useTileArrows(decoGrid);
    const fxKeys = useTileArrows(fxGrid);

    const colourFor = (c: DecorationColour) => {
        if (!decoSplit.base || !supportsColour(decoSplit.base)) return;
        pickDecoration(joinDecorationId(decoSplit.base, c));
    };

    // The inspector's item: a locked one you selected (try-on), else what is on your card.
    const decoInsp = tryDeco ? findDecoration(tryDeco) : decoBase ?? decoItem;
    const fxInsp = tryFx ? findEffect(tryFx) : findEffect(effect);

    const studioTabs: Array<{ id: Studio; label: string; value: string; prev: React.ReactNode }> = [
        { id: 'theme', label: 'Theme', value: themeName, prev: <span className="pst-sw" style={{ background: theme ? themeSwatch(theme) : 'var(--cl-raise)' }} /> },
        { id: 'decoration', label: 'Decoration', value: decoName, prev: <DecoThumb decoration={decoration} tint={decoSplit.colour === 'match' ? tint : null} base={base} size={26} options={decoOpts} /> },
        { id: 'effect', label: 'Effect', value: effectName, prev: <EffectThumb effect={effect} tint={tint} base={base} small options={fxOpts} /> },
    ];
    const studioRef = useRef<HTMLDivElement>(null);
    const onStudioKey = (e: React.KeyboardEvent) => {
        const ids = studioTabs.map((t) => t.id);
        const i = ids.indexOf(studio);
        let j = i;
        if (e.key === 'ArrowRight') j = (i + 1) % ids.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + ids.length) % ids.length;
        else return;
        e.preventDefault();
        chooseStudio(ids[j]);
        studioRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
    };

    return (
        <SettingsDisclosure
            id="profile.appearance" variant="card" title="Style" summary={styleSummary}
            labels={['Look & feel', 'Appearance', 'Theme', 'Theme color', 'Avatar decoration', 'Profile effect', 'Match my banner']}
        >
            <div className="pst" data-testid="cosmetics-section" aria-busy={busy}>
                <div ref={studioRef} className="pst-switch" role="tablist" aria-label="What to style" onKeyDown={onStudioKey}>
                    {studioTabs.map((t) => (
                        <button key={t.id} type="button" role="tab" aria-selected={studio === t.id} tabIndex={studio === t.id ? 0 : -1}
                            className="pst-switch-btn" data-testid={`style-tab-${t.id}`} onClick={() => chooseStudio(t.id)}>
                            <span className="pst-switch-prev" aria-hidden="true">{t.prev}</span>
                            <span className="pst-switch-txt"><span>{t.label}</span><b>{t.value}</b></span>
                        </button>
                    ))}
                </div>

                {studio === 'theme' && (
                    <div className="pst-panel" role="tabpanel" aria-label="Theme">
                        <Inspector
                            thumb={<span className="pst-sw pst-sw--lg" style={{ background: shownTheme ? themeSwatch(shownTheme) : 'var(--cl-raise)' }} />}
                            title={proposal ? `From your ${sourceName}` : `${themeName} theme`}
                            blurb={proposal ? 'Previewing on your card. Apply it to keep it.' : 'The colors of your card. Text on it stays readable whatever you pick.'}
                            state={proposal ? 'none' : theme ? 'on' : 'none'}
                        >
                            {proposal ? (
                                <div className="pst-proposal" data-testid="match-proposal">
                                    <div className="pst-pairs" role="radiogroup" aria-label={`Themes from your ${sourceName}`}>
                                        {proposals!.map((p, i) => (
                                            <button key={`${p.primary}${p.accent}`} type="button" role="radio" aria-checked={i === proposalAt}
                                                className="pst-pair" onClick={() => setProposalAt(i)} aria-label={`Option ${i + 1}: ${p.primary} and ${p.accent}`}>
                                                <span style={{ background: p.primary }} /><span style={{ background: p.accent }} />
                                            </button>
                                        ))}
                                    </div>
                                    <div className="pst-proposal-actions">
                                        <button type="button" className="pst-btn pst-btn--primary" disabled={busy} data-testid="match-apply"
                                            onClick={() => { setCustomDraft(proposal); applyTheme(proposal); }}>
                                            <Check size={14} aria-hidden="true" /> Apply
                                        </button>
                                        <button type="button" className="pst-btn" onClick={() => setProposals(null)}>Cancel</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="pst-insp-actions">
                                    <button type="button" className="pst-btn pst-btn--match" onClick={matchBanner} disabled={!sourceUrl || busy || matchWanted} data-testid="match-banner"
                                        title={sourceUrl ? `A theme made from your ${sourceName}'s colors` : 'Add a banner or an avatar first'}>
                                        {matchWanted ? <Sparkles size={14} className="pst-pulse" aria-hidden="true" /> : <Wand2 size={14} aria-hidden="true" />}
                                        {matchWanted ? `Reading your ${sourceName}…` : `Match my ${sourceName}`}
                                    </button>
                                    <button type="button" className="pst-btn" aria-expanded={customOpen} onClick={() => setCustomOpen((o) => !o)} data-testid="custom-colors">
                                        <Palette size={14} aria-hidden="true" /> {customOpen ? 'Hide custom colors' : 'Custom colors'}
                                    </button>
                                </div>
                            )}
                            {matchError && !proposal && (
                                <p className="pst-error" role="alert">Could not read the colors of your {sourceName}. Try again, or pick colors yourself.</p>
                            )}
                        </Inspector>

                        <div className="pst-theme-row">
                            <span className="pst-opt-label">Presets</span>
                            <div className="pst-presets" role="group" aria-label="Theme presets">
                                <button type="button" className="pst-preset pst-preset--none" disabled={busy} aria-pressed={theme === null && !proposal} onClick={() => applyTheme(null)}>
                                    Default
                                </button>
                                {THEME_PRESETS.map((p) => (
                                    <button
                                        key={p.id} type="button" className="pst-preset" disabled={busy} aria-pressed={!proposal && themeEquals(theme, p.theme)}
                                        aria-label={`${p.label} theme`} title={p.label}
                                        onClick={() => { setCustomDraft(p.theme); applyTheme(p.theme); }}
                                    >
                                        <span style={{ background: themeSwatch(p.theme) }} />
                                    </button>
                                ))}
                            </div>
                        </div>
                        {customOpen && <div className="pst-theme" ref={customRef} data-testid="custom-colors-panel">
                            <div className="pst-theme-presets">
                                <span className="pst-opt-label">Your own colors</span>
                                <div className="ps-pair" role="radiogroup" aria-label="Which color to edit">
                                    {(['primary', 'accent'] as const).map((k) => (
                                        <button key={k} type="button" role="radio" aria-checked={editing === k} className="ps-pair-btn" onClick={() => setEditing(k)}>
                                            <span className="ps-pair-sw" style={{ background: customDraft[k] }} />
                                            <span>{k === 'primary' ? 'Primary' : 'Accent'}</span>
                                            <span className="ps-pair-hex">{customDraft[k]}</span>
                                        </button>
                                    ))}
                                </div>
                                <p className="pst-note">Saves as you go.</p>
                            </div>
                            <div className="pst-picker">
                                <ColourPickerPanel
                                    value={customDraft[editing]} label={editing === 'primary' ? 'Primary color' : 'Accent color'}
                                    onChange={editCustom}
                                    suggested={suggested} suggestedLabel={`From your ${sourceName}`}
                                />
                            </div>
                        </div>}
                    </div>
                )}

                {studio === 'decoration' && (
                    <div className="pst-panel" role="tabpanel" aria-label="Decoration">
                        <Inspector
                            thumb={<DecoThumb decoration={tryDeco ?? decoration} tint={decoSplit.colour === 'match' ? tint : null} base={base} size={44} options={tryDeco ? null : decoOpts} />}
                            title={decoInsp ? (tryDeco ? decoInsp.label : decoName) : 'No decoration'}
                            blurb={decoInsp?.blurb ?? (decoInsp ? undefined : 'Pick one below. Pointing at one tries it on in the preview.')}
                            state={tryDeco && decoInsp ? 'locked' : decoration ? 'on' : 'none'}
                            lockHint={tryDeco && decoInsp ? unlockHint(decoInsp.rule, found, level) : undefined}
                            onLeaveTryOn={() => setTryDeco(null)} leaveLabel={`Back to ${decoName}`}
                        >
                            {!tryDeco && supportsColour(decoSplit.base) && (
                                <div className="pst-opts">
                                    <div className="pst-opt">
                                        <span className="pst-opt-label">Color</span>
                                        <div className="ps-seg3" role="radiogroup" aria-label="Decoration color">
                                            {(['match', 'ember', 'violet'] as const).map((c) => {
                                                const need = c === 'match' ? 0 : COLOUR_LEVELS[c];
                                                const locked = level < need;
                                                return (
                                                    <button
                                                        key={c} type="button" role="radio" aria-checked={decoSplit.colour === c}
                                                        disabled={busy || locked} title={locked ? `Reach profile level ${need} (you are level ${level})` : undefined}
                                                        onClick={() => colourFor(c)}
                                                    >
                                                        {c === 'match' ? 'Match theme' : c === 'ember' ? 'Ember' : 'Violet'}{locked ? ` · Lv ${need}` : ''}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                </div>
                            )}
                            {!tryDeco && decoration && (
                                <OptionControls specs={optionSpecsFor('decoration', decoration)} value={decoOpts} label={decoName} disabled={busy} base={base}
                                    matchColour={tint ?? '#25e0c8'} onChange={(n) => changeOptions('d', n)} />
                            )}
                        </Inspector>
                        <div ref={decoGrid} role="radiogroup" aria-label="Avatar decoration" className="pst-grid" onKeyDown={decoKeys}
                            onMouseLeave={() => setPointDeco(undefined)}>
                            <Tile name="None" on={!decoration && !tryDeco} locked={false} short="" full="" disabled={busy} onPick={() => pickDecoration(null)} onPoint={(p) => setPointDeco(p ? null : undefined)}>
                                {() => <DecoThumb decoration={null} tint={null} base={base} />}
                            </Tile>
                            {baseDecorations.map((it) => {
                                const open = unlocked(it);
                                return (
                                    <Tile key={it.id} name={it.label} on={tryDeco ? tryDeco === it.id : decoSplit.base === it.id} locked={!open} disabled={busy}
                                        short={shortUnlockHint(it.rule, found, level)} full={unlockHint(it.rule, found, level)}
                                        onPoint={(p) => setPointDeco(p ? it.id : undefined)}
                                        onPick={() => pickDecoration(open ? joinDecorationId(it.id, supportsColour(it.id) && isColourUnlocked(decoSplit.colour, level) ? decoSplit.colour : 'match') : it.id)}>
                                        {() => <DecoThumb decoration={it.id} tint={tint} base={base} options={decoSplit.base === it.id ? decoOpts : null} />}
                                    </Tile>
                                );
                            })}
                        </div>
                    </div>
                )}

                {studio === 'effect' && (
                    <div className="pst-panel" role="tabpanel" aria-label="Effect">
                        <Inspector
                            thumb={<EffectThumb effect={tryFx ?? effect} tint={tint} base={base} options={tryFx ? null : fxOpts} play />}
                            title={fxInsp ? fxInsp.label : 'No effect'}
                            blurb={fxInsp?.blurb ?? (fxInsp ? undefined : 'Pick one below. Pointing at one tries it on in the preview.')}
                            state={tryFx && fxInsp ? 'locked' : effect ? 'on' : 'none'}
                            lockHint={tryFx && fxInsp ? unlockHint(fxInsp.rule, found, level) : undefined}
                            onLeaveTryOn={() => setTryFx(null)} leaveLabel={`Back to ${effectName}`}
                        >
                            {!tryFx && effect && (
                                <OptionControls specs={optionSpecsFor('effect', effect)} value={fxOpts} label={effectName} disabled={busy} base={base}
                                    matchColour={tint ?? '#25e0c8'} onChange={(n) => changeOptions('e', n)} />
                            )}
                        </Inspector>
                        <div ref={fxGrid} role="radiogroup" aria-label="Profile effect" className="pst-grid" onKeyDown={fxKeys}
                            onMouseLeave={() => setPointFx(undefined)}>
                            <Tile name="None" on={!effect && !tryFx} locked={false} short="" full="" disabled={busy} onPick={() => pickEffect(null)} onPoint={(p) => setPointFx(p ? null : undefined)}>
                                {() => <EffectThumb effect={null} tint={null} base={base} />}
                            </Tile>
                            {PROFILE_EFFECTS.map((it) => (
                                <Tile key={it.id} name={it.label} on={tryFx ? tryFx === it.id : effect === it.id} locked={!unlocked(it)} disabled={busy}
                                    short={shortUnlockHint(it.rule, found, level)} full={unlockHint(it.rule, found, level)}
                                    onPoint={(p) => setPointFx(p ? it.id : undefined)} onPick={() => pickEffect(it.id)}>
                                    {(hot) => <EffectThumb effect={it.id} tint={tint} base={base} options={effect === it.id ? fxOpts : null} play={hot} />}
                                </Tile>
                            ))}
                        </div>
                        <p className="pst-note">Effects play while Cipherline is in front and pause when it is not. Off with reduced motion.</p>
                    </div>
                )}
            </div>
        </SettingsDisclosure>
    );
};

const decoColourName = (label: string, c: DecorationColour): string => (c === 'match' ? label : `${label}, ${c}`);
const isColourUnlocked = (c: DecorationColour, level: number): boolean => c === 'match' || level >= COLOUR_LEVELS[c];
