/**
 * CategoryFormDialog — create or edit a channel category.
 *
 * Same shape as ChannelSettingsDialog, and the same permission editor: a
 * compact Overview (name, icon for Calls categories, one-click access
 * presets) and the full per-role / per-member editor on the Permissions tab.
 * Channels under a category inherit its overrides unless they set their own,
 * which is exactly what the editor's "Inherits …" lines on a channel show.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { Folder, Radio, X, Plus, Trash2, Save, SlidersHorizontal, CornerDownLeft } from 'lucide-react';
import { API_BASE } from '../../constants';
import type { CategoryInfo, ChannelInfo } from '../../hooks/useServers';
import { ChannelIconDropdown, ChannelIconRenderer } from './ChannelIconPicker';
import { ClButton, ClModal, ClInput, ClSegment, ClConfirm } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { channelPermissionMask } from './roles/permissions';
import { ChannelPermissionEditor, type CopySource } from './channelPerms/ChannelPermissionEditor';
import { AccessPresetPicker } from './channelPerms/AccessPresetPicker';
import { usePermissionData } from './channelPerms/usePermissionData';
import { useOverrideEditor } from './channelPerms/useOverrideEditor';
import { computeGuard } from './channelPerms/editorGuard';
import { roleFromWire } from './channelPerms/effectivePermissions';
import { countTargets, draftFromRows, draftsEqual, type DraftMap } from './channelPerms/overrideDraft';
import { describeFailures, saveOverrideDiff } from './channelPerms/saveOverrides';

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
}

const sectionLabel = 'text-[10.5px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5';
const toPlainText = (s: string) => s.replace(/[^a-zA-Z0-9 '\-_.]/g, '');
const errText = (e: unknown, fallback: string) =>
    ((e as { response?: { data?: { message?: unknown } } })?.response?.data?.message as string | undefined) ?? fallback;

export const CategoryFormDialog: React.FC<Props> = ({
    serverId, token, category, kind = 'text',
    onClose, onSaved, onDelete, initialTab,
    ownerUserId = null, currentUserId = null, myPermissions, categories, channels,
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
        inheritFromCategoryId: null, // a category is the first override tier
        own: editing ? { scope: 'category', id: editing.category_id } : null,
        myPermissions,
    });
    const permRoles = useMemo(() => data.roles.map(roleFromWire), [data.roles]);
    const everyoneRoleId = data.roles.find(r => r.is_everyone)?.role_id ?? null;

    const baseline: DraftMap = useMemo(() => (data.ownRows ? draftFromRows(data.ownRows) : {}), [data.ownRows]);
    const guard = useMemo(() => computeGuard({
        roles: permRoles, members: data.members, ownerUserId, currentUserId,
        myPermissions: data.myPerms ?? 0n, baseline, scope: 'category', inheritedTiers: [],
    }), [permRoles, data.members, ownerUserId, currentUserId, data.myPerms, baseline]);
    const { state: editor, dispatch, reset } = useOverrideEditor(guard);

    // Load saved overrides into the draft once per category (during render).
    const [loadedFor, setLoadedFor] = useState<string | null>(null);
    if (editing && data.ownRows && loadedFor !== editing.category_id) {
        setLoadedFor(editing.category_id);
        reset(draftFromRows(data.ownRows));
    }

    const permsReady = data.rolesState === 'ready' && data.myPerms !== null && (!editing || data.ownRows !== null);
    const overrideCount = countTargets(editor.draft, mask);

    const overviewDirty = isEdit
        ? name.trim() !== editing!.name || (isHuddle && (iconName ?? null) !== (editing!.icon_name ?? null))
        : name.trim().length > 0;
    const permsDirty = !draftsEqual(baseline, editor.draft);
    const dirty = overviewDirty || permsDirty;
    const canSubmit = name.trim().length >= 1 && !saving && (isEdit ? dirty : true) && (permsReady || !permsDirty);

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
                    load: async () => draftFromRows((await axios.get(`${API_BASE}/servers/${serverId}/categories/${c.category_id}/overrides`, auth)).data ?? []),
                })),
            ...(channels ?? [])
                .filter(c => c.kind === 'text' || c.kind === 'huddle')
                .map(c => ({
                    value: `ch:${c.channel_id}`,
                    label: c.kind === 'huddle' ? `Calls · ${c.name}` : `#${c.name}`,
                    load: async () => draftFromRows((await axios.get(`${API_BASE}/servers/${serverId}/channels/${c.channel_id}/overrides`, auth)).data ?? []),
                })),
        ];
    }, [token, categories, channels, serverId, editing?.category_id]);

    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const http = { patch: (u: string, b: unknown) => axios.patch(u, b, auth), delete: (u: string) => axios.delete(u, auth) };
    const overridesBase = (id: string) => `${API_BASE}/servers/${serverId}/categories/${id}/overrides`;

    const handleCreate = async () => {
        const res = await axios.post(
            `${API_BASE}/servers/${serverId}/categories`,
            { name: name.trim(), kind: effectiveKind, icon_name: isHuddle ? (iconName || null) : null },
            auth,
        );
        const created: CategoryInfo = res.data;
        const result = await saveOverrideDiff({ http, base: overridesBase(created.category_id), baseline: {}, draft: editor.draft, everyoneRoleId, resolveMine: guard.resolveMine });
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
            const iconPayload = isHuddle ? (iconName || null) : null;
            await axios.patch(`${API_BASE}/servers/${serverId}/categories/${cat.category_id}`, { name: name.trim(), icon_name: iconPayload }, auth);
            saved = { ...cat, name: name.trim(), icon_name: iconPayload };
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
            setError(errText(e, isEdit ? 'Failed to save category' : 'Failed to create category'));
        } finally {
            setSaving(false);
        }
    };

    const scopeLabel = name.trim() || 'this category';

    const permsBody = () => {
        if (data.rolesState === 'error' || data.ownError) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
                    <div className="text-[12.5px] text-cl-flash">{data.rolesError ?? data.ownError}</div>
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
                inheritedTiers={[]}
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
                label={isEdit ? `Edit category ${editing!.name}` : 'Create category'}
                cardStyle={{ padding: 0, maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
            >
                <div
                    className="flex flex-col min-h-0 flex-1"
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); } }}
                >
                    <div className="flex items-center gap-3 px-5 py-3 border-b border-cl-border/40 shrink-0">
                        <div className="w-8 h-8 rounded-xl bg-cl-lume/15 flex items-center justify-center text-cl-lume border border-solid border-cl-lume/20 shrink-0">
                            {(isHuddle && iconName) ? <ChannelIconRenderer name={iconName} size={15} /> : isHuddle ? <Radio size={15} /> : <Folder size={15} />}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-[9px] font-mono font-semibold uppercase text-cl-faint truncate m-0" style={{ letterSpacing: '1.3px' }}>
                                {isEdit ? (isHuddle ? 'Calls Category' : 'Text Category') : (isHuddle ? 'New Calls Category' : 'New Category')}
                            </div>
                            <h2 className="font-display font-semibold text-[16px] text-cl-text truncate m-0">
                                {isEdit ? editing!.name : (isHuddle ? 'Create Calls category' : 'Create category')}
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

                    <div className="flex-1 min-h-0 relative" style={{ background: 'var(--cl-deep)' }}>
                        {tab === 'overview' && (
                            <div className="h-full overflow-y-auto custom-scrollbar px-5 py-4 space-y-4">
                                <div>
                                    <div className={sectionLabel}>Name</div>
                                    <div className="flex items-center gap-2">
                                        {isHuddle && (
                                            <ChannelIconDropdown value={iconName} onChange={setIconName} fallbackIcon={<Radio size={16} />} />
                                        )}
                                        <ClInput
                                            ref={inputRef}
                                            value={name}
                                            onChange={e => setName(toPlainText(e.target.value))}
                                            placeholder={isHuddle ? 'Calls' : 'Channels'}
                                            maxLength={50}
                                            aria-label="Category name"
                                            onKeyDown={(e: React.KeyboardEvent) => {
                                                if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); void submit(); }
                                            }}
                                        />
                                    </div>
                                </div>
                                <div>
                                    <div className="flex items-center justify-between">
                                        <div className={sectionLabel}>Who can access</div>
                                        <button type="button" onClick={() => setTab('permissions')} className="text-[11px] text-cl-faint hover:text-cl-lume inline-flex items-center gap-1 mb-1.5">
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
                                            kind={effectiveKind}
                                            scope="category"
                                            roles={data.roles}
                                            permRoles={permRoles}
                                            members={data.members}
                                            ownerUserId={ownerUserId}
                                            currentUserId={currentUserId}
                                            inheritedTiers={[]}
                                            syncCategoryName={null}
                                            state={editor}
                                            dispatch={dispatch}
                                            mask={mask}
                                            guard={guard}
                                            onOpenAdvanced={() => setTab('permissions')}
                                        />
                                    )}
                                    <div className="text-[11px] text-cl-faint mt-2.5">
                                        Channels in this category follow these settings unless they set their own.
                                    </div>
                                </div>
                            </div>
                        )}
                        {tab === 'permissions' && (
                            <div className="h-[min(520px,calc(90vh-140px))] flex flex-col">
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
                message={isEdit ? 'Your unsaved changes to this category will be lost.' : 'This category hasn’t been created yet.'}
                confirmLabel="Discard"
                danger
                overlayStyle={{ zIndex: 1010 }}
            />
        </>
    );
};

export default CategoryFormDialog;
