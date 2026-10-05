/**
 * ChannelSettingsDialog — create or edit a text / Calls channel.
 *
 * Built for speed: the Overview tab is one compact, keyboard-first screen —
 * type, name, category and WHO CAN ACCESS (one-click presets derived from the
 * server's real roles), Enter to create, "Create another" to keep going with
 * the same settings. The Permissions tab is the full per-role / per-member
 * editor (ChannelPermissionEditor): explicit Deny / Inherit / Allow controls,
 * copy / paste, bulk actions with undo, and a live "what this resolves to and
 * why" line mirroring the server's resolver.
 *
 * Both tabs edit ONE draft. Creating sends the channel, then its overrides
 * (@everyone first, so a private channel is hidden as early as possible), then
 * fires `onCreated` — so the caller mints the channel's Sender Key for exactly
 * the members who can see it post-override.
 *
 * Wire payload for "no category": `parent_category_id` is OMITTED on create
 * (the API reads absent/'' as uncategorised) and sent as '' on edit (the
 * UpdateChannelDto convention for "move out of its category").
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
    Hash, Volume2, X, Save, Plus, Trash2, Users, Layers, SlidersHorizontal, CornerDownLeft,
} from 'lucide-react';
import { API_BASE } from '../../constants';
import type { ChannelInfo, CategoryInfo } from '../../hooks/useServers';
import { ChannelIconDropdown } from './ChannelIconPicker';
import {
    CHANNEL_NAME_IMPATIENCE, IMPATIENCE_AFTER_FOCUSES, channelNameEgg, pickRotating,
} from '../../utils/eggPools';
import { ClButton, ClModal, ClInput, ClTextarea, ClSelect, ClSegment, ClCheckbox, ClConfirm } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { channelPermissionMask, type ChannelKind } from './roles/permissions';
import { ChannelPermissionEditor, type CopySource } from './channelPerms/ChannelPermissionEditor';
import { AccessPresetPicker } from './channelPerms/AccessPresetPicker';
import { usePermissionData } from './channelPerms/usePermissionData';
import { useOverrideEditor } from './channelPerms/useOverrideEditor';
import { computeGuard } from './channelPerms/editorGuard';
import { roleFromWire, type PermTier } from './channelPerms/effectivePermissions';
import { countTargets, draftFromRows, draftsEqual, type DraftMap } from './channelPerms/overrideDraft';
import { describeFailures, saveOverrideDiff } from './channelPerms/saveOverrides';
import { CallNamingSection } from './CallNamingSection';
import {
    callNamingOf, callNamingEqual, callNamingFormError, callNamingPayload, isDefaultCallNaming,
    type CallNamingSettings,
} from '../../utils/callNaming';
import '../../styles/server-dock.css';

type Tab = 'overview' | 'permissions';

// ── Limit picker ───────────────────────────────────────────────────────────
// Preset chips + a compact custom field. Deliberately NOT a slider: limits
// are "pick one of a few sensible values, occasionally something specific".

interface LimitFieldProps {
    icon: React.ReactNode;
    label: string;
    sublabel: string;
    value: number;          // 0 = unlimited
    max: number;
    presets: number[];      // ascending, without the 0/unlimited option
    onChange: (v: number) => void;
}

const LimitField: React.FC<LimitFieldProps> = ({ icon, label, sublabel, value, max, presets, onChange }) => {
    const isCustom = value > 0 && !presets.includes(value);
    const [draft, setDraft] = useState(isCustom ? String(value) : '');
    // The custom field mirrors the value only while a custom value is in
    // effect; picking a chip clears it. Adjusted during render when `value`
    // changes (React's "state from props" pattern), not in an effect.
    const [seen, setSeen] = useState(value);
    if (seen !== value) {
        setSeen(value);
        setDraft(isCustom ? String(value) : '');
    }
    const commitDraft = (raw: string) => {
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 1 && n <= max) onChange(n);
    };
    const chipBase = 'text-[12px] font-semibold px-2.5 h-[26px] rounded-lg border border-solid motion-safe:transition-colors cursor-pointer tabular-nums';
    const chipOn   = 'bg-cl-lume/15 border-cl-lume/50 text-cl-lume';
    const chipOff  = 'bg-transparent border-cl-border/50 text-cl-faint hover:border-cl-lume/30 hover:text-cl-muted';
    return (
        <div className="flex items-center gap-3 px-3 py-2.5 flex-wrap">
            <div className="flex items-center gap-2 min-w-[170px]">
                <div className="w-6 h-6 rounded-md bg-cl-lume/10 text-cl-lume/80 flex items-center justify-center shrink-0">{icon}</div>
                <div className="min-w-0">
                    <div className="text-[12.5px] font-semibold text-cl-text leading-tight">{label}</div>
                    <div className="text-[10.5px] text-cl-faint leading-snug">{sublabel}</div>
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
                <button type="button" onClick={() => onChange(0)} className={`${chipBase} ${value === 0 ? chipOn : chipOff}`} title="No limit" aria-pressed={value === 0}>
                    ∞
                </button>
                {presets.map(p => (
                    <button key={p} type="button" onClick={() => onChange(p)} className={`${chipBase} ${value === p ? chipOn : chipOff}`} aria-pressed={value === p}>
                        {p}
                    </button>
                ))}
                <input
                    type="number"
                    min={1}
                    max={max}
                    value={draft}
                    onChange={e => { setDraft(e.target.value); commitDraft(e.target.value); }}
                    onBlur={() => { if (draft === '' && isCustom) onChange(0); }}
                    placeholder="Custom"
                    // py-0: the forms plugin pads bare inputs 8px, which overflows a 26px chip.
                    aria-label={`${label}: custom value`}
                    title={`Any value from 1 to ${max}`}
                    className={`${chipBase} py-0 focus:ring-0 w-[64px] text-center placeholder:text-cl-faint/60 focus:outline-none ${
                        isCustom ? chipOn : 'bg-transparent border-cl-border/50 text-cl-muted focus:border-cl-lume/40'
                    } [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                />
            </div>
        </div>
    );
};

const toPlainText = (s: string) => s.replace(/[^a-zA-Z0-9 '\-_.]/g, '');
const sectionLabel = 'text-[10.5px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5';
const errText = (e: unknown, fallback: string) =>
    ((e as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) ?? fallback;

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
    serverId: string;
    token: string | null;
    channel?: ChannelInfo | null;
    defaultCategoryId?: string | null;
    defaultKind?: 'text' | 'huddle';
    categories: CategoryInfo[];
    canManage?: boolean;
    onClose: () => void;
    onSaved: (channel: ChannelInfo) => void;
    onDelete?: (channel: ChannelInfo) => void;
    /** Fired ONLY on creation, after the override PATCHes have landed — so the
     *  caller mints & distributes the channel's Sender Key to exactly the set
     *  of members who can VIEW it post-override. */
    onCreated?: (channel: ChannelInfo) => void;
    /** Fired when a channel was created but the dialog STAYS OPEN ("Create
     *  another", or some overrides failed and need a retry). Passing it is
     *  what enables the "Create another" toggle. */
    onCreatedKeepOpen?: (channel: ChannelInfo) => void;
    /** The server owner (owner short-circuit in previews; guard). */
    ownerUserId?: string | null;
    currentUserId?: string | null;
    /** Caller's server-level bits, if known (else fetched). */
    myPermissions?: bigint;
    /** Other channels, for "Copy from…". */
    channels?: ChannelInfo[];
}

export const ChannelSettingsDialog: React.FC<Props> = ({
    serverId, token, channel, defaultCategoryId, defaultKind,
    categories, canManage = false, onClose, onSaved, onDelete, onCreated, onCreatedKeepOpen,
    ownerUserId = null, currentUserId = null, myPermissions, channels,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);

    // `editing` starts as the prop, but becomes the freshly created channel if
    // some of its overrides failed — the dialog then turns into its editor so
    // the user can retry just those.
    const [editing, setEditing] = useState<ChannelInfo | null>(channel ?? null);
    const isEdit = !!editing;

    const initialKind: ChannelKind = channel?.kind === 'huddle' ? 'huddle' : defaultKind ?? 'text';
    const [tab, setTab] = useState<Tab>('overview');
    const [name, setName] = useState(channel?.name ?? '');
    const [kind, setKind] = useState<ChannelKind>(initialKind);
    const [iconName, setIconName] = useState<string | null>(
        channel?.icon_name ?? (!channel && initialKind === 'huddle' ? 'Volume2' : null),
    );
    const [topic, setTopic] = useState(channel?.topic ?? '');
    const [pickedParentId, setParentId] = useState<string>(channel?.parent_category_id ?? defaultCategoryId ?? '');
    const [memberLimit, setMemberLimit] = useState(channel?.member_limit ?? 0);
    const [maxCalls, setMaxCalls] = useState(channel?.max_calls ?? 0);
    const [callNaming, setCallNaming] = useState<CallNamingSettings>(() => callNamingOf(channel));
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [createAnother, setCreateAnother] = useState(false);
    const [createdFlash, setCreatedFlash] = useState<string | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);

    const mask = useMemo(() => channelPermissionMask(kind), [kind]);
    const orderedCategories = useMemo(
        () => [...categories].filter(c => !c.kind || c.kind === kind).sort((a, b) => a.position - b.position),
        [categories, kind],
    );
    // A category of the other kind (after switching type) simply doesn't apply.
    const parentCategory = orderedCategories.find(c => c.category_id === pickedParentId) ?? null;
    const parentId = parentCategory?.category_id ?? '';

    const data = usePermissionData({
        serverId, token,
        inheritFromCategoryId: parentCategory?.category_id ?? null,
        own: editing ? { scope: 'channel', id: editing.channel_id } : null,
        myPermissions,
    });

    const permRoles = useMemo(() => data.roles.map(roleFromWire), [data.roles]);
    const everyoneRoleId = data.roles.find(r => r.is_everyone)?.role_id ?? null;

    // What the server holds right now — re-derived whenever it is re-read.
    const baseline: DraftMap = useMemo(() => (data.ownRows ? draftFromRows(data.ownRows) : {}), [data.ownRows]);
    const inheritedTiers: PermTier[] = useMemo(() => parentCategory
        ? [{ kind: 'category', label: `category ‘${parentCategory.name}’`, overrides: data.inherited }]
        : [], [parentCategory, data.inherited]);
    // The guard resolves the caller's permissions IN this channel (inherited
    // tier + saved baseline), which is what the server checks each write
    // against — not their server-wide bits.
    const guard = useMemo(() => computeGuard({
        roles: permRoles, members: data.members, ownerUserId, currentUserId,
        myPermissions: data.myPerms ?? 0n, baseline, scope: 'channel', inheritedTiers,
    }), [permRoles, data.members, ownerUserId, currentUserId, data.myPerms, baseline, inheritedTiers]);
    const { state: editor, dispatch, reset } = useOverrideEditor(guard);

    // Load the saved overrides into the draft once they first arrive for this
    // channel (edit mode). Adjusted during render, keyed by channel id — a
    // create that turns into an edit marks itself loaded so its draft (with
    // the not-yet-saved overrides) is kept.
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    if (editing && data.ownRows && loadedFor !== editing.channel_id) {
        setLoadedFor(editing.channel_id);
        reset(draftFromRows(data.ownRows));
    }

    // Type switch (create mode only): keep only the bits the new type shows.
    const changeKind = (next: ChannelKind) => {
        if (next === kind) return;
        const nextMask = channelPermissionMask(next);
        const kept: Record<string, { allow: bigint; deny: bigint }> = {};
        for (const [k, b] of Object.entries(editor.draft)) kept[k] = { allow: b.allow & nextMask, deny: b.deny & nextMask };
        setKind(next);
        reset(kept);
        if (next === 'huddle') setIconName(prev => prev ?? 'Volume2');
        else setIconName(prev => (prev === 'Volume2' ? null : prev));
    };

    const inheritedNote = parentCategory
        ? data.inheritedState === 'error'
            ? `Couldn’t load ‘${parentCategory.name}’ permissions — inherited results below may be off.`
            : data.inheritedState === 'loading' ? `Loading ‘${parentCategory.name}’ permissions…` : null
        : null;

    const permsReady = data.rolesState === 'ready' && data.myPerms !== null && (!editing || data.ownRows !== null);
    const overrideCount = countTargets(editor.draft, mask);

    // ── Dirty tracking ─────────────────────────────────────────────────────
    // Call names are tracked on their own so an edit that does not touch them
    // never sends `call_naming` (an API from before the setting rejects the
    // unknown field — only a save that actually changes it should hit that).
    const callNamingDirty = kind === 'huddle' && (isEdit
        ? !callNamingEqual(callNaming, callNamingOf(editing))
        : !isDefaultCallNaming(callNamingPayload(callNaming)));
    const callNamingError = kind === 'huddle' ? callNamingFormError(callNaming) : null;
    const overviewDirty = isEdit
        ? (name.trim() !== (editing!.name ?? '')
            || (iconName ?? null) !== (editing!.icon_name ?? null)
            || (kind !== 'huddle' && topic !== (editing!.topic ?? ''))
            || parentId !== (editing!.parent_category_id ?? '')
            || (kind === 'huddle' && (memberLimit !== (editing!.member_limit ?? 0) || maxCalls !== (editing!.max_calls ?? 0)))
            || callNamingDirty)
        : name.trim().length > 0;
    const permsDirty = !draftsEqual(baseline, editor.draft);
    const dirty = overviewDirty || permsDirty;

    const requestClose = () => {
        if (dirty && !saving) setConfirmDiscard(true);
        else handleClose();
    };

    // ── Channel-name eggs (catalog) ──────────────────────────────────────
    const nameInputRef = useRef<HTMLInputElement>(null);
    // After ClModal's own open-focus (it focuses the first focusable — the
    // tab switcher — in a rAF scheduled by its effect, which runs before ours).
    useEffect(() => {
        const r = requestAnimationFrame(() => nameInputRef.current?.focus());
        return () => cancelAnimationFrame(r);
    }, []);
    const defaultPlaceholder = kind === 'huddle' ? 'voice-lounge' : 'general';
    const [nameEgg, setNameEgg] = useState<string | null>(null);
    const [impatientPlaceholder, setNamePlaceholder] = useState<string | null>(null);
    const namePlaceholder = impatientPlaceholder ?? defaultPlaceholder;
    const nameEggSeq = useRef(0);
    const nameFocuses = useRef(0);
    const handleNameChange = (v: string) => {
        setName(v);
        const egg = channelNameEgg(v, nameEggSeq.current);
        if (egg) nameEggSeq.current++;
        setNameEgg(egg);
    };
    const handleNameFocus = () => {
        nameFocuses.current++;
        if (name.trim() !== '') return;
        if (nameFocuses.current < IMPATIENCE_AFTER_FOCUSES) return;
        setNamePlaceholder(pickRotating(CHANNEL_NAME_IMPATIENCE, nameFocuses.current - IMPATIENCE_AFTER_FOCUSES));
    };

    useEffect(() => {
        if (!createdFlash) return;
        const t = setTimeout(() => setCreatedFlash(null), 3000);
        return () => clearTimeout(t);
    }, [createdFlash]);

    // ── Copy-from sources ──────────────────────────────────────────────────
    const copySources: CopySource[] = useMemo(() => {
        if (!token) return [];
        const auth = { headers: { Authorization: `Bearer ${token}` } };
        const fromCats = [...categories].sort((a, b) => a.position - b.position).map(c => ({
            value: `cat:${c.category_id}`,
            label: `Category · ${c.name}`,
            load: async () => draftFromRows((await axios.get(`${API_BASE}/servers/${serverId}/categories/${c.category_id}/overrides`, auth)).data ?? []),
        }));
        const fromChannels = (channels ?? [])
            .filter(c => c.channel_id !== editing?.channel_id && (c.kind === 'text' || c.kind === 'huddle'))
            .map(c => ({
                value: `ch:${c.channel_id}`,
                label: c.kind === 'huddle' ? `Calls · ${c.name}` : `#${c.name}`,
                load: async () => draftFromRows((await axios.get(`${API_BASE}/servers/${serverId}/channels/${c.channel_id}/overrides`, auth)).data ?? []),
            }));
        return [...fromChannels, ...fromCats];
    }, [token, categories, channels, serverId, editing?.channel_id]);

    // ── Save / create ──────────────────────────────────────────────────────
    const canSubmit = name.trim().length >= 1 && !saving && (isEdit ? dirty : true) && (permsReady || !permsDirty)
        && callNamingError === null;
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const overridesBase = (channelId: string) => `${API_BASE}/servers/${serverId}/channels/${channelId}/overrides`;

    const handleCreate = async () => {
        const body: Record<string, unknown> = { name: name.trim(), kind };
        if (iconName) body.icon_name = iconName;
        if (parentId) body.parent_category_id = parentId; // omitted = uncategorised
        if (kind === 'huddle') {
            if (memberLimit > 0) body.member_limit = memberLimit;
            if (maxCalls > 0) body.max_calls = maxCalls;
            // Omitted when left at the defaults (the server's default anyway).
            if (callNamingDirty) body.call_naming = callNamingPayload(callNaming);
        } else if (topic.trim()) {
            body.topic = topic;
        }
        const res = await axios.post(`${API_BASE}/servers/${serverId}/channels`, body, auth);
        const saved: ChannelInfo = res.data;

        const result = await saveOverrideDiff({
            http: { patch: (u, b) => axios.patch(u, b, auth), delete: u => axios.delete(u, auth) },
            base: overridesBase(saved.channel_id),
            baseline: {}, draft: editor.draft, everyoneRoleId, resolveMine: guard.resolveMine,
        });
        // The channel exists either way — key distribution follows whatever
        // audience actually landed.
        onCreated?.(saved);

        const failure = describeFailures(result);
        if (failure) {
            // Become this channel's editor so only the failed overrides stay dirty.
            setLoadedFor(saved.channel_id);
            setEditing(saved);
            await data.reloadOwn({ scope: 'channel', id: saved.channel_id });
            setTab('permissions');
            setError(`Created #${saved.name}, but ${failure.charAt(0).toLowerCase()}${failure.slice(1)}. Fix it and press Save.`);
            onCreatedKeepOpen?.(saved);
            return;
        }
        if (createAnother && onCreatedKeepOpen) {
            onCreatedKeepOpen(saved);
            setCreatedFlash(`Created ${kind === 'huddle' ? '' : '#'}${saved.name}`);
            setName('');
            setTopic('');
            setNameEgg(null);
            setTab('overview');
            requestAnimationFrame(() => nameInputRef.current?.focus());
            return;
        }
        onSaved(saved);
        handleClose();
    };

    const handleSaveEdit = async () => {
        const ch = editing!;
        let saved: ChannelInfo = ch;
        if (overviewDirty) {
            const body: Record<string, unknown> = {
                name: name.trim(),
                icon_name: iconName ?? '',
                parent_category_id: parentId, // '' = move out of its category
                ...(kind === 'huddle'
                    ? { member_limit: memberLimit === 0 ? null : memberLimit, max_calls: maxCalls === 0 ? null : maxCalls }
                    : { topic }),
                ...(callNamingDirty ? { call_naming: callNamingPayload(callNaming) } : {}),
            };
            await axios.patch(`${API_BASE}/servers/${serverId}/channels/${ch.channel_id}`, body, auth);
            saved = {
                ...ch,
                name: name.trim(),
                icon_name: iconName,
                topic: kind === 'huddle' ? null : (topic.length === 0 ? null : topic),
                parent_category_id: parentId.length === 0 ? null : parentId,
                member_limit: kind === 'huddle' ? (memberLimit === 0 ? null : memberLimit) : null,
                max_calls: kind === 'huddle' ? (maxCalls === 0 ? null : maxCalls) : null,
                ...(callNamingDirty ? { call_naming: callNamingPayload(callNaming) } : {}),
            };
            setEditing(saved);
        }
        if (permsDirty) {
            const result = await saveOverrideDiff({
                http: { patch: (u, b) => axios.patch(u, b, auth), delete: u => axios.delete(u, auth) },
                base: overridesBase(ch.channel_id),
                baseline, draft: editor.draft, everyoneRoleId, resolveMine: guard.resolveMine,
            });
            const failure = describeFailures(result);
            await data.reloadOwn();
            if (failure) { setError(failure); setTab('permissions'); return; }
        }
        onSaved(saved);
        handleClose();
    };

    const submit = async () => {
        if (!token || !canSubmit) return;
        setSaving(true);
        setError(null);
        try {
            if (isEdit) await handleSaveEdit();
            else await handleCreate();
        } catch (e) {
            setError(errText(e, isEdit ? 'Failed to save channel' : 'Failed to create channel'));
        } finally {
            setSaving(false);
        }
    };

    const onDialogKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
    };

    const categoryOptions = [
        { value: '', label: 'No category' },
        ...orderedCategories.map(c => ({ value: c.category_id, label: c.name })),
    ];
    const kindWord = kind === 'huddle' ? 'Calls channel' : 'channel';
    const showPermissions = canManage || !isEdit;

    const permsBody = () => {
        if (data.rolesState === 'error') {
            return (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
                    <div className="text-[12.5px] text-cl-flash">{data.rolesError}</div>
                    <ClButton size="sm" variant="ghost" onClick={data.retry}>Retry</ClButton>
                </div>
            );
        }
        if (data.ownError) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
                    <div className="text-[12.5px] text-cl-flash">{data.ownError}</div>
                    <ClButton size="sm" variant="ghost" onClick={() => { void data.reloadOwn(); }}>Retry</ClButton>
                </div>
            );
        }
        if (!permsReady) {
            return (
                <div className="flex-1 flex items-center justify-center py-16" role="status" aria-label="Loading permissions">
                    <div className="w-5 h-5 border-2 border-white/20 border-t-cl-lume rounded-full motion-safe:animate-spin" />
                </div>
            );
        }
        return (
            <ChannelPermissionEditor
                serverId={serverId}
                kind={kind}
                scope="channel"
                scopeLabel={name.trim() ? (kind === 'huddle' ? name.trim() : `#${name.trim()}`) : `this ${kindWord}`}
                roles={data.roles}
                permRoles={permRoles}
                members={data.members}
                ownerUserId={ownerUserId}
                currentUserId={currentUserId}
                inheritedTiers={inheritedTiers}
                inheritedNote={inheritedNote}
                state={editor}
                dispatch={dispatch}
                guard={guard}
                copySources={copySources}
                syncCategoryName={parentCategory?.name ?? null}
                onSync={parentCategory ? () => dispatch({ type: 'replaceAll', draft: {}, mask, label: `Sync with ‘${parentCategory.name}’` }) : undefined}
            />
        );
    };

    return (
        <>
            <ClModal
                open={!closing}
                onClose={requestClose}
                width={showPermissions ? 860 : 540}
                label={isEdit ? `Edit ${kindWord} ${editing!.name}` : `Create ${kindWord}`}
                cardStyle={{ padding: 0, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
                <div className="flex flex-col min-h-0 flex-1" onKeyDown={onDialogKeyDown}>
                    {/* ── Header: identity + tabs + close, one row ─────────── */}
                    <div className="flex items-center gap-3 px-5 py-3 border-b border-cl-border/40 shrink-0">
                        <div className="w-8 h-8 rounded-xl bg-cl-lume/15 flex items-center justify-center text-cl-lume border border-solid border-cl-lume/20 shrink-0">
                            {kind === 'huddle' ? <Volume2 size={15} /> : <Hash size={15} />}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-[9px] font-mono font-semibold uppercase text-cl-faint truncate m-0" style={{ letterSpacing: '1.3px' }}>
                                {isEdit ? (kind === 'huddle' ? 'Calls Channel' : 'Text Channel') : (kind === 'huddle' ? 'New Calls Channel' : 'New Text Channel')}
                            </div>
                            <h2 className="font-display font-semibold text-[16px] text-cl-text truncate m-0">
                                {isEdit ? editing!.name : (kind === 'huddle' ? 'Create Calls channel' : 'Create channel')}
                            </h2>
                        </div>
                        {showPermissions && (
                            <ClSegment<Tab>
                                value={tab}
                                onChange={setTab}
                                options={[
                                    { value: 'overview', label: 'Overview' },
                                    {
                                        value: 'permissions',
                                        label: (
                                            <span className="inline-flex items-center gap-1.5">
                                                Permissions
                                                {overrideCount > 0 && (
                                                    <span className="text-[10px] font-bold opacity-80" style={{ fontFamily: 'var(--cl-font-mono)' }}>{overrideCount}</span>
                                                )}
                                            </span>
                                        ),
                                    },
                                ]}
                            />
                        )}
                        <ClButton icon onClick={requestClose} variant="ghost" tooltip="Close">
                            <X size={16} />
                        </ClButton>
                    </div>

                    {/* ── Body ──────────────────────────────────────────── */}
                    <div className="flex-1 min-h-0 relative" style={{ background: 'var(--cl-deep)' }}>
                        <div className="dock-caustics" aria-hidden="true">
                            <i className="dock-caustic dock-caustic--m1" />
                            <i className="dock-caustic dock-caustic--m2" />
                        </div>

                        {tab === 'overview' && (
                            <div className="relative z-[1] h-full overflow-y-auto custom-scrollbar px-5 py-4 space-y-4">
                                {!isEdit && (
                                    <div>
                                        <div className={sectionLabel} id="cd-type-label">Type</div>
                                        <div role="radiogroup" aria-labelledby="cd-type-label" className="grid grid-cols-2 gap-2">
                                            {([
                                                { k: 'text' as const, icon: <Hash size={15} />, title: 'Text', desc: 'Messages, files & links — end-to-end encrypted.' },
                                                { k: 'huddle' as const, icon: <Volume2 size={15} />, title: 'Calls', desc: 'Members start calls here — several can run at once.' },
                                            ]).map(({ k, icon, title, desc }) => {
                                                const on = kind === k;
                                                return (
                                                    <button
                                                        key={k}
                                                        type="button"
                                                        role="radio"
                                                        aria-checked={on}
                                                        onClick={() => changeKind(k)}
                                                        className={`flex items-center gap-2.5 text-left rounded-xl px-3 py-2 border border-solid outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60 motion-safe:transition-colors cursor-pointer ${
                                                            on ? 'bg-cl-lume/[0.08] border-cl-lume/50' : 'bg-cl-surface/40 border-cl-border/50 hover:border-cl-lume/30'
                                                        }`}
                                                    >
                                                        <span className={on ? 'text-cl-lume' : 'text-cl-muted'}>{icon}</span>
                                                        <span className="min-w-0">
                                                            <span className={`block text-[13px] font-semibold ${on ? 'text-cl-lume' : 'text-cl-text'}`}>{title}</span>
                                                            <span className="block text-[10.5px] leading-snug text-cl-faint truncate">{desc}</span>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                <div className="flex flex-col sm:flex-row gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className={sectionLabel}>Name</div>
                                        <div className="flex gap-2 items-center">
                                            <ChannelIconDropdown
                                                value={iconName}
                                                onChange={setIconName}
                                                fallbackIcon={kind === 'huddle' ? <Volume2 size={16} /> : undefined}
                                            />
                                            <ClInput
                                                ref={nameInputRef}
                                                value={name}
                                                onChange={e => handleNameChange(toPlainText(e.target.value))}
                                                onFocus={handleNameFocus}
                                                placeholder={namePlaceholder}
                                                maxLength={50}
                                                aria-label={`${kindWord} name`}
                                                className="flex-1"
                                                onKeyDown={(e: React.KeyboardEvent) => {
                                                    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void submit(); }
                                                }}
                                            />
                                        </div>
                                        {nameEgg && <div className="cl-fmsg note">{nameEgg}</div>}
                                    </div>
                                    <div className="sm:w-56 shrink-0">
                                        <div className={sectionLabel}>Category</div>
                                        <ClSelect
                                            options={categoryOptions}
                                            value={parentId}
                                            onChange={setParentId}
                                            ariaLabel="Category"
                                            style={{ width: '100%' }}
                                        />
                                    </div>
                                </div>

                                {showPermissions && (
                                    <div>
                                        <div className="flex items-center justify-between">
                                            <div className={sectionLabel}>Who can access</div>
                                            <button
                                                type="button"
                                                onClick={() => setTab('permissions')}
                                                className="text-[11px] text-cl-faint hover:text-cl-lume inline-flex items-center gap-1 mb-1.5"
                                            >
                                                <SlidersHorizontal size={11} /> Fine-tune per role
                                            </button>
                                        </div>
                                        {data.rolesState === 'error' ? (
                                            <div className="text-[12px] text-cl-flash">
                                                {data.rolesError} <button type="button" className="underline" onClick={data.retry}>Retry</button>
                                            </div>
                                        ) : !permsReady ? (
                                            <div className="h-[30px] w-[340px] rounded-lg bg-cl-surface/40 motion-safe:animate-pulse" aria-label="Loading roles" />
                                        ) : (
                                            <AccessPresetPicker
                                                kind={kind}
                                                scope="channel"
                                                roles={data.roles}
                                                permRoles={permRoles}
                                                members={data.members}
                                                ownerUserId={ownerUserId}
                                                currentUserId={currentUserId}
                                                inheritedTiers={inheritedTiers}
                                                syncCategoryName={parentCategory?.name ?? null}
                                                state={editor}
                                                dispatch={dispatch}
                                                mask={mask}
                                                guard={guard}
                                                onOpenAdvanced={() => setTab('permissions')}
                                            />
                                        )}
                                    </div>
                                )}

                                {kind === 'huddle' ? (
                                    <div>
                                        <div className={sectionLabel}>Call limits</div>
                                        <div className="rounded-xl border border-solid border-cl-border/50 bg-cl-surface/40 divide-y divide-white/[0.05]">
                                            <LimitField icon={<Users size={13} />} label="People per call" sublabel="Max in a single call" value={memberLimit} max={99} presets={[2, 5, 10, 25, 50]} onChange={setMemberLimit} />
                                            <LimitField icon={<Layers size={13} />} label="Calls at once" sublabel="Concurrent calls here" value={maxCalls} max={50} presets={[1, 2, 3, 5, 10]} onChange={setMaxCalls} />
                                        </div>
                                        <div className={`${sectionLabel} mt-4`}>Call names</div>
                                        <CallNamingSection
                                            value={callNaming}
                                            onChange={setCallNaming}
                                            channelName={name}
                                            disabled={saving}
                                        />
                                    </div>
                                ) : (
                                    <div>
                                        <div className="flex items-center justify-between">
                                            <div className={sectionLabel}>Topic <span className="normal-case tracking-normal font-sans text-cl-faint/70">(optional)</span></div>
                                            <span className="text-[10px] text-cl-faint mb-1.5">{topic.length}/500</span>
                                        </div>
                                        <ClTextarea
                                            value={topic}
                                            onChange={e => setTopic(e.target.value.slice(0, 500))}
                                            placeholder="What this channel is about — shown in the channel header."
                                            rows={2}
                                            aria-label="Topic"
                                            className="resize-none w-full"
                                        />
                                    </div>
                                )}
                            </div>
                        )}

                        {tab === 'permissions' && (
                            <div className="relative z-[1] h-[min(520px,calc(90vh-140px))] flex flex-col">
                                {permsBody()}
                            </div>
                        )}
                    </div>

                    {/* ── Footer ────────────────────────────────────────── */}
                    <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-cl-border/40 shrink-0">
                        <div className="flex items-center gap-3 min-w-0">
                            {isEdit && onDelete && (
                                <ClButton size="sm" variant="danger" onClick={() => { onDelete(editing!); handleClose(); }}>
                                    <Trash2 size={12} /> Delete
                                </ClButton>
                            )}
                            {!isEdit && onCreatedKeepOpen && (
                                <ClCheckbox checked={createAnother} onChange={setCreateAnother} label={<span className="text-[12px] text-cl-muted ml-1.5">Create another</span>} />
                            )}
                            {createdFlash && <span className="text-[12px] text-cl-lume truncate" role="status">{createdFlash}</span>}
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                            {error && <span className="text-[11.5px] text-cl-flash truncate max-w-[340px]" role="alert" title={error}>{error}</span>}
                            {isEdit && dirty && !error && <span className="text-[11px] text-cl-glow">Unsaved changes</span>}
                            <ClButton variant="ghost" onClick={requestClose}>Cancel</ClButton>
                            <ClButton onClick={() => { void submit(); }} disabled={!canSubmit} loading={saving} tooltip={isEdit ? 'Save (Ctrl+Enter)' : 'Create (Enter)'}>
                                {isEdit ? <Save size={14} /> : <Plus size={14} />}
                                {saving ? (isEdit ? 'Saving…' : 'Creating…') : (isEdit ? 'Save' : 'Create')}
                                {!saving && !isEdit && <CornerDownLeft size={12} className="opacity-60" aria-hidden="true" />}
                            </ClButton>
                        </div>
                    </div>
                </div>
            </ClModal>

            <ClConfirm
                open={confirmDiscard}
                onClose={() => setConfirmDiscard(false)}
                onConfirm={() => { setConfirmDiscard(false); handleClose(); }}
                title="Discard changes?"
                message={isEdit ? 'Your unsaved changes to this channel will be lost.' : 'This channel hasn’t been created yet.'}
                confirmLabel="Discard"
                danger
                overlayStyle={{ zIndex: 1010 }}
            />
        </>
    );
};

export default ChannelSettingsDialog;
