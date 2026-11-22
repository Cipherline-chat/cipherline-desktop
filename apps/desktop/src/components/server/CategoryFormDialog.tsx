/**
 * CategoryFormDialog — create or edit a channel category.
 *
 * Same shape as ChannelSettingsDialog, and the same permission editor: a
 * compact Overview (name, icon for Calls categories, one-click access
 * presets) and the full per-role / per-member editor on the Permissions tab.
 * Channels under a category inherit its overrides unless they set their own,
 * which is exactly what the editor's "Inherits …" lines on a channel show.
 *
 * Also creates / edits SUB-CATEGORIES (`parentCategoryId`, or a category
 * whose `parent_category_id` is set): an optional approved icon (the same picker channels use) before the name, a
 * "Sits in" picker (another top-level category; a NEW sub-category can never sit at top level), and the
 * parent's overrides shown as the tier it inherits - the cascade is
 * category -> sub-category -> channel, resolved by the server.
 *
 * DIVIDER CATEGORIES (owner, 2026-11-17): a top-level category can be drawn
 * as a labelled divider instead of the usual category label ("Looks like").
 * It is still a category in every other way. Its look is a divider label
 * style (label / header / pill / text) plus the divider colour, picked with
 * the same tiles and LayoutColorPicker the divider dialog uses. Edit can
 * switch it either way and change style / colour. Ordinary categories have
 * no colour (owner). Sub-categories are always ordinary: picking a parent in
 * "Sits in" drops the divider look (the server refuses it on a sub-category),
 * and "Sits in" is hidden while the divider look is on.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Folder, Radio, X, Plus, Trash2, Save, SlidersHorizontal, CornerDownLeft, CornerDownRight } from 'lucide-react';
import { apiUrl } from '../../utils/apiPath';
import type { CategoryInfo, ChannelInfo } from '../../hooks/useServers';
import { ChannelIconDropdown, ChannelIconRenderer } from './ChannelIconPicker';
import { ClButton, ClModal, ClInput, ClSegment, ClConfirm, ClSelect } from '../cl';
import type { PermTier } from './channelPerms/effectivePermissions';
import { useModalExit } from '../../hooks/useModalExit';
import { channelPermissionMask } from './roles/permissions';
import { ChannelPermissionEditor, type CopySource } from './channelPerms/ChannelPermissionEditor';
import { AccessPresetPicker } from './channelPerms/AccessPresetPicker';
import { usePermissionData } from './channelPerms/usePermissionData';
import { useOverrideEditor } from './channelPerms/useOverrideEditor';
import { computeGuard } from './channelPerms/editorGuard';
import { roleFromWire } from './channelPerms/effectivePermissions';
import { countTargets, draftFromRows, draftsEqual, type DraftMap } from './channelPerms/overrideDraft';
import { describeFailures, saveOverrideDiff, type SaveResult } from './channelPerms/saveOverrides';
import { createWithOverrides } from './channelPerms/createWithOverrides';
import { channelNameDraftError, CHANNEL_NAME_INPUT_MAX_UNITS } from '../../utils/displayName';
import { DIVIDER_LABEL_STYLES, isLabelDividerStyle, normalizeDividerColor, type DividerStyle } from '@cipherline/shared';
import { ChannelDividerVisual } from './ChannelDividerRow';
import { LayoutColorPicker } from './LayoutColorPicker';

const HEADER_STYLE_NAMES: Record<string, string> = { label: 'Centred', header: 'Header', pill: 'Pill', text: 'Text' };

type Tab = 'overview' | 'permissions';

interface Props {
    serverId: string;
    token: string | null;
    category?: CategoryInfo | null;
    kind?: 'text' | 'huddle';
    onClose: () => void;
    onSaved: (category: CategoryInfo) => void;
    onDelete?: (category: CategoryInfo) => void;
    initialTab?: Tab;
    ownerUserId?: string | null;
    currentUserId?: string | null;
    myPermissions?: bigint;
    /** For "Copy from…". */
    categories?: CategoryInfo[];
    channels?: ChannelInfo[];
    /** Create a SUB-CATEGORY of this top-level category. */
    parentCategoryId?: string | null;
}

const sectionLabel = 'text-[10.5px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5';
const errText = (e: unknown, fallback: string) =>
    ((e as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) ?? fallback;

export const CategoryFormDialog: React.FC<Props> = ({
    serverId, token, category, kind = 'text',
    onClose, onSaved, onDelete, initialTab,
    ownerUserId = null, currentUserId = null, myPermissions, categories, channels, parentCategoryId = null,
}) => {
    const { closing, handleClose } = useModalExit(onClose, 260);

    const [editing, setEditing] = useState<CategoryInfo | null>(category ?? null);
    const isEdit = !!editing;
    const effectiveKind = editing?.kind ?? kind;
    const isHuddle = effectiveKind === 'huddle';
    const mask = useMemo(() => channelPermissionMask(effectiveKind), [effectiveKind]);

    const [tab, setTab] = useState<Tab>(initialTab ?? 'overview');
    const [name, setName] = useState(category?.name ?? '');
    const [iconName, setIconName] = useState<string | null>(category?.icon_name ?? null);
    // Sub-categories: where it sits ('' = top level).
    // A NEW sub-category always has a parent: one of the top-level text categories.
    // A parent that is not one (stale id, a sub-category, a Calls category) means
    // there is no sub-category to make: it is an ordinary category.
    const [pickedParent, setPickedParent] = useState<string>(() => {
        if (category) return category.parent_category_id ?? '';
        if (!parentCategoryId) return '';
        const ok = !categories || categories.some(c => c.category_id === parentCategoryId && c.kind === 'text' && !c.parent_category_id);
        return ok ? parentCategoryId : '';
    });
    const isSub = !!pickedParent;
    // Divider category look (top-level only). null = an ordinary category.
    const [headerStyle, setHeaderStyle] = useState<string | null>(
        isLabelDividerStyle(category?.header_style) ? category!.header_style! : null,
    );
    const [headerColor, setHeaderColor] = useState<string | null>(normalizeDividerColor(category?.header_color));
    /** What the row will be saved as: never a divider look on a sub-category. */
    const effectiveHeaderStyle = isSub ? null : headerStyle;
    const effectiveHeaderColor = effectiveHeaderStyle ? headerColor : null;
    // Calls categories and sub-categories carry an icon from the approved set.
    const hasIcon = isHuddle || isSub;
    const parentCat = isSub ? (categories ?? []).find(c => c.category_id === pickedParent) ?? null : null;
    // A category that has sub-categories of its own cannot become one.
    const hasSubs = !!editing && (categories ?? []).some(c => c.parent_category_id === editing.category_id);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    // rAF: land after ClModal's own open-focus of its first focusable.
    useEffect(() => {
        if (tab !== 'overview') return;
        const r = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(r);
    }, [tab]);

    const data = usePermissionData({
        serverId, token,
        // A top-level category is the first override tier; a sub-category
        // inherits its parent's.
        inheritFromCategoryId: parentCat?.category_id ?? null,
        own: editing ? { scope: 'category', id: editing.category_id } : null,
        myPermissions,
    });
    const permRoles = useMemo(() => data.roles.map(roleFromWire), [data.roles]);
    const everyoneRoleId = data.roles.find(r => r.is_everyone)?.role_id ?? null;

    const baseline: DraftMap = useMemo(() => (data.ownRows ? draftFromRows(data.ownRows) : {}), [data.ownRows]);
    const inheritedTiers: PermTier[] = useMemo(() => (parentCat
        ? [{ kind: 'category' as const, label: `category ‘${parentCat.name}’`, overrides: data.inherited }]
        : []), [parentCat, data.inherited]);
    const guard = useMemo(() => computeGuard({
        roles: permRoles, members: data.members, ownerUserId, currentUserId,
        myPermissions: data.myPerms ?? 0n, baseline, scope: 'category', inheritedTiers,
    }), [permRoles, data.members, ownerUserId, currentUserId, data.myPerms, baseline, inheritedTiers]);
    const { state: editor, dispatch, reset } = useOverrideEditor(guard);

    // Load saved overrides into the draft once per category (during render).
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    if (editing && data.ownRows && loadedFor !== editing.category_id) {
        setLoadedFor(editing.category_id);
        reset(draftFromRows(data.ownRows));
    }

    const permsReady = data.rolesState === 'ready' && data.myPerms !== null && (!editing || data.ownRows !== null);
    const overrideCount = countTargets(editor.draft, mask);

    const parentDirty = isEdit && pickedParent !== (editing!.parent_category_id ?? '');
    const headerDirty = isEdit && (
        effectiveHeaderStyle !== (editing!.header_style ?? null)
        || effectiveHeaderColor !== (normalizeDividerColor(editing!.header_color) ?? null)
    );
    const overviewDirty = isEdit
        ? name.trim() !== editing!.name || (hasIcon && (iconName ?? null) !== (editing!.icon_name ?? null)) || parentDirty || headerDirty
        : name.trim().length > 0;
    const permsDirty = !draftsEqual(baseline, editor.draft);
    const dirty = overviewDirty || permsDirty;
    const nameError = channelNameDraftError(name);
    const canSubmit = name.trim().length >= 1 && nameError === null && !saving && (isEdit ? dirty : true) && (permsReady || !permsDirty);

    const requestClose = () => {
        if (dirty && !saving) setConfirmDiscard(true);
        else handleClose();
    };

    const copySources: CopySource[] = useMemo(() => {
        if (!token) return [];
        const auth = { headers: { Authorization: `Bearer ${token}` } };
        return [
            ...(categories ?? [])
                .filter(c => c.category_id !== editing?.category_id)
                .sort((a, b) => a.position - b.position)
                .map(c => ({
                    value: `cat:${c.category_id}`,
                    label: `Category · ${c.name}`,
                    load: async () => draftFromRows((await axios.get(apiUrl`/servers/${serverId}/categories/${c.category_id}/overrides`, auth)).data ?? []),
                })),
            ...(channels ?? [])
                .filter(c => c.kind === 'text' || c.kind === 'huddle')
                .map(c => ({
                    value: `ch:${c.channel_id}`,
                    label: c.kind === 'huddle' ? `Calls · ${c.name}` : `#${c.name}`,
                    load: async () => draftFromRows((await axios.get(apiUrl`/servers/${serverId}/channels/${c.channel_id}/overrides`, auth)).data ?? []),
                })),
        ];
    }, [token, categories, channels, serverId, editing?.category_id]);

    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const http = { patch: (u: string, b: unknown) => axios.patch(u, b, auth), delete: (u: string) => axios.delete(u, auth) };
    const overridesBase = (id: string) => apiUrl`/servers/${serverId}/categories/${id}/overrides`;

    const handleCreate = async () => {
        // Overrides ride WITH the create (one transaction, announced only to
        // members who can see it): a private category is never listed to
        // anyone half-restricted. An API that predates the field falls back
        // to the old create-then-PATCH inside createWithOverrides.
        const made = await createWithOverrides<CategoryInfo>({
            post: b => axios.post(apiUrl`/servers/${serverId}/categories`, b, auth),
            body: {
                name: name.trim(), kind: effectiveKind, icon_name: hasIcon ? (iconName || null) : null,
                ...(isSub ? { parent_category_id: pickedParent } : {}),
                ...(effectiveHeaderStyle ? { header_style: effectiveHeaderStyle, header_color: effectiveHeaderColor } : {}),
            },
            draft: editor.draft, everyoneRoleId,
        });
        const created: CategoryInfo = made.data;
        const result: SaveResult = made.overridesSent
            ? { applied: 0, failed: [] }
            : await saveOverrideDiff({ http, base: overridesBase(created.category_id), baseline: {}, draft: editor.draft, everyoneRoleId, resolveMine: guard.resolveMine });
        const failure = describeFailures(result);
        if (failure) {
            setLoadedFor(created.category_id);
            setEditing(created);
            await data.reloadOwn({ scope: 'category', id: created.category_id });
            setTab('permissions');
            setError(`Created ‘${created.name}’, but ${failure.charAt(0).toLowerCase()}${failure.slice(1)}. Fix it and press Save.`);
            return;
        }
        onSaved(created);
        handleClose();
    };

    const handleSaveEdit = async () => {
        const cat = editing!;
        let saved = cat;
        if (overviewDirty) {
            const iconPayload = hasIcon ? (iconName || null) : null;
            const body: Record<string, unknown> = { name: name.trim(), icon_name: iconPayload };
            // Free-emoji icons are retired: clear any left over from before.
            if (cat.icon_emoji) body.icon_emoji = '';
            if (parentDirty) body.parent_category_id = pickedParent; // '' = top level
            if (headerDirty) {
                body.header_style = effectiveHeaderStyle;
                body.header_color = effectiveHeaderColor;
            }
            const res = await axios.patch(apiUrl`/servers/${serverId}/categories/${cat.category_id}`, body, auth);
            saved = {
                ...cat, ...(res.data ?? {}),
                name: name.trim(), icon_name: iconPayload, icon_emoji: null, parent_category_id: pickedParent || null,
                header_style: effectiveHeaderStyle, header_color: effectiveHeaderColor,
            };
            setEditing(saved);
        }
        if (permsDirty) {
            const result = await saveOverrideDiff({ http, base: overridesBase(cat.category_id), baseline, draft: editor.draft, everyoneRoleId, resolveMine: guard.resolveMine });
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
            setError(errText(e, isEdit ? `Failed to save ${noun}` : `Failed to create ${noun}`));
        } finally {
            setSaving(false);
        }
    };

    const scopeLabel = name.trim() || (isSub ? 'this sub-category' : 'this category');
    const noun = isSub ? 'sub-category' : 'category';
    // "Sits in": the other top-level text categories, or top level.
    const parentOptions = useMemo(() => [
        { value: '', label: 'Top level (a category)' },
        ...(categories ?? [])
            .filter(c => c.kind === 'text' && !c.parent_category_id && c.category_id !== editing?.category_id)
            .sort((a, b) => a.position - b.position)
            .map(c => ({ value: c.category_id, label: c.name })),
    ], [categories, editing?.category_id]);

    const permsBody = () => {
        if (data.rolesState === 'error' || data.ownError) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
                    <div className="text-[12.5px] text-cl-flash-text">{data.rolesError ?? data.ownError}</div>
                    <ClButton size="sm" variant="ghost" onClick={data.retry}>Retry</ClButton>
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
                kind={effectiveKind}
                scope="category"
                scopeLabel={scopeLabel}
                roles={data.roles}
                permRoles={permRoles}
                members={data.members}
                ownerUserId={ownerUserId}
                currentUserId={currentUserId}
                inheritedTiers={inheritedTiers}
                state={editor}
                dispatch={dispatch}
                guard={guard}
                copySources={copySources}
            />
        );
    };

    return (
        <>
            <ClModal
                open={!closing}
                onClose={requestClose}
                width={860}
                label={isEdit ? `Edit ${noun} ${editing!.name}` : `Create ${noun}`}
                cardClassName="mcard--panel"
            >
                <div
                    className="flex flex-col min-h-0 flex-1"
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
                >
                    <div className="flex items-center gap-3 px-5 py-3 border-b border-cl-border/40 shrink-0">
                        <div className="w-8 h-8 rounded-xl bg-cl-lume/15 flex items-center justify-center text-cl-lume-text border border-solid border-cl-lume/20 shrink-0">
                            {(hasIcon && iconName) ? <ChannelIconRenderer name={iconName} size={15} />
                                : isHuddle ? <Radio size={15} />
                                    : isSub ? <CornerDownRight size={15} /> : <Folder size={15} />}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-[9px] font-mono font-semibold uppercase text-cl-faint truncate m-0" style={{ letterSpacing: '1.3px' }}>
                                {isSub
                                    ? `${isEdit ? 'Sub-category' : 'New Sub-category'}${parentCat ? ` · in ${parentCat.name}` : ''}`
                                    : isEdit ? (isHuddle ? 'Calls Category' : 'Text Category') : (isHuddle ? 'New Calls Category' : 'New Category')}
                            </div>
                            <h2 className="font-display font-semibold text-[16px] text-cl-text truncate m-0">
                                {isEdit ? editing!.name : isSub ? 'Create sub-category' : (isHuddle ? 'Create Calls category' : 'Create category')}
                            </h2>
                        </div>
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
                        <ClButton icon onClick={requestClose} variant="ghost" tooltip="Close">
                            <X size={16} />
                        </ClButton>
                    </div>

                    <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden" style={{ background: 'var(--cl-deep)' }} data-modal-body>
                        {tab === 'overview' && (
                            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar px-5 py-4 space-y-4" data-modal-scroll>
                                <div>
                                    <div className={sectionLabel}>Name</div>
                                    <div className="flex items-center gap-2">
                                        {isHuddle && (
                                            <ChannelIconDropdown value={iconName} onChange={setIconName} fallbackIcon={<Radio size={16} />} />
                                        )}
                                        {isSub && (
                                            <ChannelIconDropdown value={iconName} onChange={setIconName} fallbackIcon={<CornerDownRight size={16} />} />
                                        )}
                                        <ClInput
                                            ref={inputRef}
                                            value={name}
                                            onChange={e => setName(e.target.value)}
                                            placeholder={isHuddle ? 'Calls' : isSub ? 'Woodworking' : 'Channels'}
                                            maxLength={CHANNEL_NAME_INPUT_MAX_UNITS}
                                            aria-label={isSub ? 'Sub-category name' : 'Category name'}
                                            aria-invalid={nameError !== null}
                                            aria-describedby={nameError ? 'category-name-error' : undefined}
                                            onKeyDown={(e: React.KeyboardEvent) => {
                                                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void submit(); }
                                            }}
                                        />
                                    </div>
                                    {nameError && <div id="category-name-error" role="alert" className="cl-fmsg">{nameError}</div>}
                                </div>
                                {!isSub && (
                                    <div data-testid="category-look">
                                        <div className={sectionLabel}>Looks like</div>
                                        <ClSegment<'category' | 'divider'>
                                            value={headerStyle ? 'divider' : 'category'}
                                            onChange={(v) => setHeaderStyle(v === 'divider' ? (headerStyle ?? 'header') : null)}
                                            options={[
                                                { value: 'category', label: 'Category' },
                                                { value: 'divider', label: 'Divider category' },
                                            ]}
                                        />
                                        <div className="text-[11px] text-cl-faint mt-1.5">
                                            {headerStyle
                                                ? 'Drawn as a divider you can collapse. It still holds channels and sub-categories, with its own permissions.'
                                                : 'The usual category heading.'}
                                        </div>
                                        {headerStyle && (
                                            <div className="mt-3 space-y-3">
                                                <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Divider style">
                                                    {DIVIDER_LABEL_STYLES.map(st => {
                                                        const selected = st === headerStyle;
                                                        return (
                                                            <button
                                                                key={st}
                                                                type="button"
                                                                role="radio"
                                                                aria-checked={selected}
                                                                data-style={st}
                                                                onClick={() => setHeaderStyle(st)}
                                                                className={`text-left rounded-[9px] border border-solid px-2 pt-2.5 pb-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume ${
                                                                    selected ? 'border-cl-lume bg-cl-abyss' : 'border-cl-border bg-cl-abyss hover:border-cl-lume/40'
                                                                }`}
                                                                style={selected ? { boxShadow: '0 0 0 1px var(--cl-lume) inset' } : undefined}
                                                            >
                                                                <div className="min-h-[24px] flex flex-col justify-center pointer-events-none">
                                                                    <ChannelDividerVisual compact divider={{ style: st as DividerStyle, label: 'Label', color: headerColor }} />
                                                                </div>
                                                                <div className="text-[12px] font-bold text-cl-faint mt-1.5 pl-1">{HEADER_STYLE_NAMES[st]}</div>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                                <div>
                                                    <div className={sectionLabel}>Colour</div>
                                                    <LayoutColorPicker value={headerColor} onChange={setHeaderColor} label="Divider colour" />
                                                </div>
                                                <div className="rounded-[10px] border border-solid border-cl-border px-2 py-1" style={{ background: 'var(--cl-deep)' }} aria-hidden="true">
                                                    <ChannelDividerVisual divider={{ style: headerStyle as DividerStyle, label: name.trim() || (isHuddle ? 'Calls' : 'Channels'), color: headerColor }} />
                                                    <div className="px-2 py-1 text-[13px] text-cl-muted font-medium"># general</div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}
                                {!headerStyle && (isEdit ? (!isHuddle && (isSub || !hasSubs) && parentOptions.length > 1) : (isSub && parentOptions.length > 2)) && (
                                    <div className="sm:w-72">
                                        <div className={sectionLabel}>Sits in</div>
                                        <ClSelect
                                            options={isEdit ? parentOptions : parentOptions.filter(o => o.value !== '')}
                                            value={pickedParent}
                                            onChange={setPickedParent}
                                            ariaLabel="Parent category"
                                            style={{ width: '100%' }}
                                        />
                                    </div>
                                )}
                                <div>
                                    <div className="flex items-center justify-between">
                                        <div className={sectionLabel}>Who can access</div>
                                        <button type="button" onClick={() => setTab('permissions')} className="text-[11px] text-cl-faint hover:text-cl-lume-text inline-flex items-center gap-1 mb-1.5">
                                            <SlidersHorizontal size={11} /> Fine-tune per role
                                        </button>
                                    </div>
                                    {data.rolesState === 'error' ? (
                                        <div className="text-[12px] text-cl-flash-text">
                                            {data.rolesError} <button type="button" className="underline" onClick={data.retry}>Retry</button>
                                        </div>
                                    ) : !permsReady ? (
                                        <div className="h-[30px] w-[340px] rounded-lg bg-cl-surface/40 motion-safe:animate-pulse" aria-label="Loading roles" />
                                    ) : (
                                        <AccessPresetPicker
                                            kind={effectiveKind}
                                            scope="category"
                                            roles={data.roles}
                                            permRoles={permRoles}
                                            members={data.members}
                                            ownerUserId={ownerUserId}
                                            currentUserId={currentUserId}
                                            inheritedTiers={inheritedTiers}
                                            syncCategoryName={null}
                                            state={editor}
                                            dispatch={dispatch}
                                            mask={mask}
                                            guard={guard}
                                            onOpenAdvanced={() => setTab('permissions')}
                                        />
                                    )}
                                    <div className="text-[11px] text-cl-faint mt-2.5">
                                        {isSub && parentCat
                                            ? `Starts from ‘${parentCat.name}’. Channels in this sub-category follow these settings unless they set their own.`
                                            : 'Channels in this category follow these settings unless they set their own.'}
                                    </div>
                                </div>
                            </div>
                        )}
                        {tab === 'permissions' && (
                            <div className="h-[min(520px,calc(100dvh-190px))] min-h-[160px] shrink-0 flex flex-col">
                                {permsBody()}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-cl-border/40 shrink-0">
                        <div>
                            {isEdit && onDelete && (
                                <ClButton size="sm" variant="danger" onClick={() => { onDelete(editing!); handleClose(); }}>
                                    <Trash2 size={12} /> Delete
                                </ClButton>
                            )}
                        </div>
                        <div className="flex items-center gap-2 min-w-0">
                            {error && <span className="text-[11.5px] text-cl-flash-text truncate max-w-[340px]" role="alert" title={error}>{error}</span>}
                            {isEdit && dirty && !error && <span className="text-[11px] text-cl-glow-text">Unsaved changes</span>}
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
                message={isEdit ? `Your unsaved changes to this ${noun} will be lost.` : `This ${noun} hasn’t been created yet.`}
                confirmLabel="Discard"
                danger
                overlayStyle={{ zIndex: 1010 }}
            />
        </>
    );
};

export default CategoryFormDialog;
