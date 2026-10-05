/**
 * ChannelPermissionEditor — the ONE override editor behind creating and
 * editing both channels (text + Calls) and categories.
 *
 * Left: every role in Server Settings → Roles order (highest first,
 * @everyone last), then members with their own overrides.
 * Right: the selected target's rows, each with an explicit
 * Deny / Inherit / Allow control and a live line saying what the target
 * actually ends up with and WHY — computed by the resolver preview in
 * effectivePermissions.ts, which mirrors the server exactly.
 *
 * It is fully controlled: the parent owns the draft (EditorState) so the
 * quick-create presets and this editor edit the same thing.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    ClipboardCopy, ClipboardPaste, Eye, Lock, RotateCcw, Search, Undo2, UserPlus, X, Link2, AlertTriangle,
} from 'lucide-react';
import { Permissions } from '@cipherline/shared';
import { ClSelect } from '../../cl';
import { readableRoleColorHex, roleColorHexFromInt } from '../../../utils/roleColor';
import type { Role } from '../roles/types';
import { channelPermissionMask, channelPermissionSections, type ChannelKind } from '../roles/permissions';
import {
    describeReason, reasonAllows, resolveEffective, mention,
    type PermRole, type PermSubject, type PermTier, type Resolution,
} from './effectivePermissions';
import {
    memberKey, parseKey, roleKey, triOf, triOfMask,
    type EditorAction, type EditorState, type DraftMap, type Tri,
} from './overrideDraft';
import { tierFromDraft } from './accessSummary';
import type { GuardResult } from './editorGuard';
import { permClipboard, usePermClipboard } from './permClipboard';
import { TriStateControl } from './TriStateControl';
import type { EditorMember } from './usePermissionData';
import { useEscape } from '../../../hooks/useEscape';

export interface CopySource {
    value: string;
    label: string;
    load: () => Promise<DraftMap>;
}

export interface ChannelPermissionEditorProps {
    serverId: string;
    kind: ChannelKind;
    scope: 'channel' | 'category';
    /** e.g. "#general" or "Staff" — used in copy labels and hints. */
    scopeLabel: string;
    roles: Role[];
    permRoles: PermRole[];
    members: EditorMember[];
    ownerUserId: string | null;
    currentUserId: string | null;
    /** Tiers applied BEFORE the one being edited (a channel's category). */
    inheritedTiers: PermTier[];
    inheritedNote?: string | null;
    state: EditorState;
    dispatch: (a: EditorAction) => void;
    guard: GuardResult;
    copySources?: CopySource[];
    /** Channel inside a category: offer "Sync with category". */
    syncCategoryName?: string | null;
    onSync?: () => void;
}

const MiniButton: React.FC<{
    onClick: () => void; disabled?: boolean; title?: string; children: React.ReactNode; tone?: 'lume' | 'flash' | 'plain';
}> = ({ onClick, disabled, title, children, tone = 'plain' }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={title}
        className={[
            'inline-flex items-center gap-1 h-[24px] px-2 rounded-md border border-solid text-[11px] font-semibold whitespace-nowrap',
            'motion-safe:transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60',
            disabled
                ? 'border-cl-border/40 text-cl-faint/60 cursor-not-allowed'
                : tone === 'lume'
                    ? 'border-cl-lume/30 text-cl-lume hover:bg-cl-lume/10 cursor-pointer'
                    : tone === 'flash'
                        ? 'border-cl-flash/30 text-cl-flash hover:bg-cl-flash/10 cursor-pointer'
                        : 'border-cl-border/70 text-cl-muted hover:border-cl-lume/40 hover:text-cl-text cursor-pointer',
        ].join(' ')}
    >
        {children}
    </button>
);

const Dot: React.FC<{ color: number }> = ({ color }) => {
    const hex = readableRoleColorHex(roleColorHexFromInt(color));
    return (
        <span
            className="w-2 h-2 rounded-full shrink-0"
            style={hex ? { backgroundColor: hex } : { border: '1.5px solid rgba(255,255,255,0.25)' }}
        />
    );
};

const VIEW_CHANNEL = Permissions.VIEW_CHANNEL;

const UNEDITABLE_WHY = 'You don’t have this permission here, so you can’t change it';
const BIT_UNEDITABLE = { allow: UNEDITABLE_WHY, deny: UNEDITABLE_WHY, inherit: UNEDITABLE_WHY } as const;
const SECTION_WHY = 'You don’t have any of these permissions here, so you can’t change them';
const SECTION_UNEDITABLE = { allow: SECTION_WHY, deny: SECTION_WHY, inherit: SECTION_WHY } as const;

/** Toolbar-height ClSelect: the kit's trigger is sized for forms (≈40px);
 *  this bar is 24px controls. Descendant variants out-rank the scoped `.selt`. */
const COMPACT_SELECT = '[&_.selt]:py-[3px] [&_.selt]:px-2.5 [&_.selt]:text-[11.5px] [&_.selt]:font-semibold [&_.selt]:rounded-md [&_.selt]:text-cl-muted';

const isTypingTarget = (el: EventTarget | null) => {
    const t = el as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

export const ChannelPermissionEditor: React.FC<ChannelPermissionEditorProps> = ({
    serverId, kind, scope, scopeLabel, roles, permRoles, members, ownerUserId, currentUserId,
    inheritedTiers, inheritedNote, state, dispatch, guard, copySources, syncCategoryName, onSync,
}) => {
    const sections = useMemo(() => channelPermissionSections(kind), [kind]);
    const mask = useMemo(() => channelPermissionMask(kind), [kind]);
    const everyone = roles.find(r => r.is_everyone) ?? null;
    const clip = usePermClipboard(serverId);

    // @everyone is selected until the user picks something else.
    const [pickedKey, setSelectedKey] = useState<string>('');
    const selectedKey = pickedKey || (everyone ? roleKey(everyone.role_id) : '');

    const [filter, setFilter] = useState('');
    const [previewId, setPreviewId] = useState<string>('');
    const [adding, setAdding] = useState(false);
    const [addQuery, setAddQuery] = useState('');
    // Esc backs out of the member finder only (shared escape stack), not the dialog.
    useEscape(() => { setAdding(false); setAddQuery(''); }, adding);
    const [pinnedMembers, setPinnedMembers] = useState<string[]>([]);
    const [copyFrom, setCopyFrom] = useState('');
    const [copyFromBusy, setCopyFromBusy] = useState(false);
    const [flash, setFlash] = useState<string | null>(null);
    useEffect(() => {
        if (!flash) return;
        const t = setTimeout(() => setFlash(null), 2200);
        return () => clearTimeout(t);
    }, [flash]);

    const memberById = useMemo(() => new Map(members.map(m => [m.user_id, m])), [members]);
    const roleById = useMemo(() => new Map(roles.map(r => [r.role_id, r])), [roles]);

    const tierLabel = scope === 'channel' ? 'this channel' : 'this category';
    const editTier = useMemo(() => tierFromDraft(scope, tierLabel, state.draft), [scope, tierLabel, state.draft]);

    const subjectFor = (key: string): PermSubject => {
        const t = parseKey(key);
        if (t.target_kind === 'role') return { kind: 'role', roleId: t.target_id };
        const m = memberById.get(t.target_id);
        return { kind: 'member', userId: t.target_id, roleIds: m?.role_ids ?? [], mutedUntil: m?.muted_until ?? null };
    };

    const baseCtx = { roles: permRoles, ownerUserId };
    const selSubject = selectedKey ? subjectFor(selectedKey) : null;
    const effSel: Resolution | null = useMemo(
        () => selSubject ? resolveEffective({ ...baseCtx, tiers: [...inheritedTiers, editTier] }, selSubject) : null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selectedKey, permRoles, ownerUserId, inheritedTiers, editTier, memberById],
    );
    const inhSel: Resolution | null = useMemo(
        () => selSubject
            ? resolveEffective({ ...baseCtx, tiers: [...inheritedTiers, tierFromDraft(scope, tierLabel, state.draft, selectedKey)] }, selSubject)
            : null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [selectedKey, permRoles, ownerUserId, inheritedTiers, state.draft, scope, memberById],
    );
    const previewMember = previewId ? memberById.get(previewId) ?? null : null;
    const effPreview: Resolution | null = useMemo(
        () => previewMember
            ? resolveEffective({ ...baseCtx, tiers: [...inheritedTiers, editTier] }, {
                kind: 'member', userId: previewMember.user_id, roleIds: previewMember.role_ids, mutedUntil: previewMember.muted_until,
            })
            : null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [previewMember, permRoles, ownerUserId, inheritedTiers, editTier],
    );

    // Would the person editing still see this after saving? (Owner/admins always do.)
    const me = currentUserId ? memberById.get(currentUserId) ?? null : null;
    const selfLockout = useMemo(() => {
        if (guard.privileged || !me) return false;
        return !resolveEffective({ roles: permRoles, ownerUserId, tiers: [...inheritedTiers, editTier] }, {
            kind: 'member', userId: me.user_id, roleIds: me.role_ids, mutedUntil: me.muted_until,
        }).has(VIEW_CHANNEL);
    }, [guard.privileged, me, permRoles, ownerUserId, inheritedTiers, editTier]);

    // ── Target list ───────────────────────────────────────────────────────
    const q = filter.trim().toLowerCase();
    const shownRoles = roles.filter(r => !q || r.name.toLowerCase().includes(q));
    const memberTargets = useMemo(() => {
        const ids = new Set<string>(pinnedMembers);
        for (const k of Object.keys(state.draft)) if (k.startsWith('member:')) ids.add(k.slice(7));
        return [...ids].map(id => memberById.get(id) ?? { user_id: id, name: 'Unknown member', role_ids: [], muted_until: null });
    }, [pinnedMembers, state.draft, memberById]);
    const shownMembers = memberTargets.filter(m => !q || m.name.toLowerCase().includes(q));
    const targetKeys = [...shownRoles.map(r => roleKey(r.role_id)), ...shownMembers.map(m => memberKey(m.user_id))];
    // Roving tab stop for the list: the selection, or the first visible entry.
    const listTabStop = targetKeys.includes(selectedKey) ? selectedKey : targetKeys[0];

    const counts = (key: string) => {
        const b = state.draft[key];
        if (!b) return { a: 0, d: 0 };
        let a = 0, d = 0;
        for (const s of sections) for (const p of s.permissions) {
            const t = triOf(b, p.bit);
            if (t === 'allow') a++; else if (t === 'deny') d++;
        }
        return { a, d };
    };

    const nameOf = (key: string): string => {
        const t = parseKey(key);
        if (t.target_kind === 'role') {
            const r = roleById.get(t.target_id);
            return r ? (r.is_everyone ? r.name : mention(r.name)) : 'Unknown role';
        }
        return memberById.get(t.target_id)?.name ?? 'Unknown member';
    };

    const locked = selectedKey ? guard.lockReasons.get(selectedKey) ?? null : null;
    const selEntry = selectedKey ? state.draft[selectedKey] : undefined;
    const selName = selectedKey ? nameOf(selectedKey) : '';
    const lastUndo = state.history[state.history.length - 1];

    const set = (bitMask: bigint, tri: Tri, label: string) => {
        if (!selectedKey) return;
        dispatch({ type: 'set', key: selectedKey, mask: bitMask, tri, label });
    };

    const copyRole = () => {
        if (!selectedKey) return;
        permClipboard.copyRole({
            serverId, mask,
            label: `${selName} in ${scopeLabel}`,
            bits: { allow: selEntry?.allow ?? 0n, deny: selEntry?.deny ?? 0n },
        });
        setFlash(`Copied ${selName}’s permissions`);
    };
    const pasteRole = () => {
        if (!selectedKey || !clip.role) return;
        dispatch({ type: 'setTarget', key: selectedKey, bits: clip.role.bits, mask, label: `Paste onto ${selName}` });
    };
    const copyAll = () => {
        permClipboard.copyChannel({ serverId, mask, label: scopeLabel, draft: state.draft });
        setFlash(`Copied all of ${scopeLabel}’s permissions`);
    };
    const pasteAll = () => {
        if (!clip.channel) return;
        dispatch({ type: 'replaceAll', draft: clip.channel.draft, mask, label: `Paste from ${clip.channel.label}` });
    };
    const runCopyFrom = async (value: string) => {
        setCopyFrom(value);
        const src = copySources?.find(s => s.value === value);
        if (!src) return;
        setCopyFromBusy(true);
        try {
            const d = await src.load();
            dispatch({ type: 'replaceAll', draft: d, mask, label: `Copy from ${src.label}` });
            setFlash(`Copied permissions from ${src.label}`);
        } catch {
            setFlash(`Couldn’t load ${src.label}’s permissions`);
        } finally {
            setCopyFromBusy(false);
            setCopyFrom('');
        }
    };

    // Ctrl/Cmd+Z undo anywhere in the editor; Ctrl/Cmd+C / V on the target list.
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || isTypingTarget(e.target)) return;
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); dispatch({ type: 'undo' }); }
        else if (k === 'c' && (e.target as HTMLElement).dataset.target) { e.preventDefault(); copyRole(); }
        else if (k === 'v' && (e.target as HTMLElement).dataset.target) { e.preventDefault(); pasteRole(); }
    };

    const listRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const onListKey = (e: React.KeyboardEvent, key: string) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const i = targetKeys.indexOf(key);
        const next = targetKeys[e.key === 'ArrowDown' ? Math.min(i + 1, targetKeys.length - 1) : Math.max(i - 1, 0)];
        if (next) { setSelectedKey(next); listRefs.current[next]?.focus(); }
    };

    const addCandidates = useMemo(() => {
        const qq = addQuery.trim().toLowerCase();
        const taken = new Set(memberTargets.map(m => m.user_id));
        return members.filter(m => !taken.has(m.user_id) && (!qq || m.name.toLowerCase().includes(qq))).slice(0, 6);
    }, [addQuery, members, memberTargets]);
    const addMember = (m: EditorMember) => {
        setPinnedMembers(p => [...p, m.user_id]);
        setSelectedKey(memberKey(m.user_id));
        setAdding(false);
        setAddQuery('');
    };

    const renderTarget = (key: string, label: React.ReactNode, dot: React.ReactNode, sub?: string) => {
        const c = counts(key);
        const lock = guard.lockReasons.get(key);
        const on = key === selectedKey;
        return (
            <button
                key={key}
                ref={el => { listRefs.current[key] = el; }}
                type="button"
                data-target={key}
                onClick={() => setSelectedKey(key)}
                onKeyDown={e => onListKey(e, key)}
                aria-current={on ? 'true' : undefined}
                title={lock ? `${typeof label === 'string' ? label : ''} — locked: ${lock}` : sub}
                tabIndex={key === listTabStop ? 0 : -1}
                className={[
                    'w-full flex items-center gap-2 h-[30px] px-2 rounded-lg text-left text-[12.5px] outline-none',
                    'focus-visible:ring-2 focus-visible:ring-cl-lume/60',
                    on ? 'bg-cl-lume/[0.12] text-cl-text shadow-[inset_2px_0_0_0_var(--cl-lume)]' : 'text-cl-muted hover:bg-white/[0.04] hover:text-cl-text',
                ].join(' ')}
            >
                {dot}
                <span className="flex-1 min-w-0 truncate">{label}</span>
                {lock && <Lock size={11} className="text-cl-faint shrink-0" aria-label="Locked" />}
                {c.a > 0 && <span className="text-[10px] font-bold text-cl-lume tabular-nums" aria-label={`${c.a} allowed`}>✓{c.a}</span>}
                {c.d > 0 && <span className="text-[10px] font-bold text-cl-flash tabular-nums" aria-label={`${c.d} denied`}>✕{c.d}</span>}
            </button>
        );
    };

    const previewOptions = useMemo(() => [
        { value: '', label: 'No member preview' },
        ...members.map(m => ({ value: m.user_id, label: m.name })),
    ], [members]);

    const copyOptions = useMemo(() => [
        { value: '', label: copyFromBusy ? 'Copying…' : 'Copy from…' },
        ...(copySources ?? []).map(s => ({ value: s.value, label: s.label })),
    ], [copySources, copyFromBusy]);

    const overrideTargets = Object.keys(state.draft).filter(k => ((state.draft[k].allow | state.draft[k].deny) & mask) !== 0n).length;

    return (
        <div className="flex flex-col min-h-0 h-full" onKeyDown={onKeyDown}>
            {/* Whole-set bar: copy / paste / copy-from / sync + member preview. */}
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-2 border-b border-cl-border/40 shrink-0">
                <span className="text-[11px] text-cl-faint mr-1">
                    {overrideTargets === 0 ? 'No overrides' : `${overrideTargets} override${overrideTargets === 1 ? '' : 's'}`}
                </span>
                <MiniButton onClick={copyAll} title={`Copy every override on ${scopeLabel}`}>
                    <ClipboardCopy size={11} /> Copy all
                </MiniButton>
                <MiniButton
                    onClick={pasteAll}
                    disabled={!clip.channel}
                    title={clip.channel ? `Replace these overrides with the ones copied from ${clip.channel.label}` : 'Copy a channel or category’s permissions first'}
                >
                    <ClipboardPaste size={11} /> Paste all
                </MiniButton>
                {copySources && copySources.length > 0 && (
                    <div className="w-[170px]">
                        <ClSelect
                            options={copyOptions}
                            value={copyFrom}
                            onChange={v => { void runCopyFrom(v); }}
                            ariaLabel="Copy permissions from another channel or category"
                            disabled={copyFromBusy}
                            className={COMPACT_SELECT}
                            style={{ width: '100%' }}
                        />
                    </div>
                )}
                {onSync && syncCategoryName && (
                    <MiniButton onClick={onSync} title={`Remove this channel’s own overrides so it follows ‘${syncCategoryName}’`}>
                        <Link2 size={11} /> Sync with ‘{syncCategoryName}’
                    </MiniButton>
                )}
                <div className="flex-1" />
                {members.length > 0 && (
                    <div className="flex items-center gap-1.5">
                        <Eye size={12} className="text-cl-faint" aria-hidden="true" />
                        <div className="w-[180px]">
                            <ClSelect
                                options={previewOptions}
                                value={previewId}
                                onChange={setPreviewId}
                                ariaLabel="Preview a member’s effective permissions"
                                className={COMPACT_SELECT}
                                style={{ width: '100%' }}
                            />
                        </div>
                    </div>
                )}
            </div>

            {selfLockout && (
                <div className="px-4 py-1.5 border-b border-cl-border/30 text-[11px] text-cl-glow flex items-center gap-2 shrink-0" role="alert">
                    <AlertTriangle size={12} className="shrink-0" />
                    With these settings you won’t be able to see {scopeLabel} yourself.
                </div>
            )}
            {(state.notice || flash || inheritedNote) && (
                <div className="px-4 py-1.5 border-b border-cl-border/30 text-[11px] flex items-center gap-2 shrink-0" role="status">
                    {state.notice ? (
                        <>
                            <AlertTriangle size={12} className="text-cl-glow shrink-0" />
                            <span className="text-cl-glow flex-1">{state.notice}</span>
                            <button type="button" className="text-cl-faint hover:text-cl-text" onClick={() => dispatch({ type: 'dismissNotice' })} aria-label="Dismiss">
                                <X size={12} />
                            </button>
                        </>
                    ) : flash ? (
                        <span className="text-cl-lume">{flash}</span>
                    ) : (
                        <span className="text-cl-faint">{inheritedNote}</span>
                    )}
                </div>
            )}

            <div className="flex flex-1 min-h-0">
                {/* ── Targets ─────────────────────────────────────────── */}
                <div className="w-[212px] shrink-0 border-r border-cl-border/40 flex flex-col min-h-0">
                    <div className="px-2 pt-2 pb-1">
                        <label className="flex items-center gap-1.5 h-[28px] px-2 rounded-lg bg-cl-sink/60 border border-solid border-cl-border/50 focus-within:border-cl-lume/50">
                            <Search size={12} className="text-cl-faint shrink-0" aria-hidden="true" />
                            <input
                                value={filter}
                                onChange={e => setFilter(e.target.value)}
                                placeholder="Filter roles & members"
                                aria-label="Filter roles and members"
                                className="bg-transparent border-0 p-0 focus:ring-0 outline-none text-[12px] text-cl-text placeholder:text-cl-faint w-full"
                            />
                        </label>
                    </div>
                    <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-2" role="list" aria-label="Roles and members">
                        <div className="text-[9.5px] font-mono font-semibold uppercase tracking-widest text-cl-faint px-2 pt-1.5 pb-1">Roles</div>
                        {shownRoles.map(r => renderTarget(roleKey(r.role_id), r.name, <Dot color={r.color} />))}
                        {shownRoles.length === 0 && <div className="text-[11px] text-cl-faint px-2 py-1">No matching roles</div>}

                        <div className="flex items-center justify-between px-2 pt-3 pb-1">
                            <div className="text-[9.5px] font-mono font-semibold uppercase tracking-widest text-cl-faint">Members</div>
                            {members.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setAdding(a => !a)}
                                    className="text-cl-faint hover:text-cl-lume"
                                    aria-label="Add a member override"
                                    title="Add a member override"
                                >
                                    <UserPlus size={12} />
                                </button>
                            )}
                        </div>
                        {adding && (
                            <div className="px-1 pb-1">
                                <input
                                    autoFocus
                                    value={addQuery}
                                    onChange={e => setAddQuery(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' && addCandidates[0]) { e.preventDefault(); addMember(addCandidates[0]); }
                                    }}
                                    placeholder="Find a member…"
                                    aria-label="Find a member to add"
                                    className="w-full h-[26px] px-2 py-0 focus:ring-0 rounded-md bg-cl-sink/70 border border-solid border-cl-border/60 text-[12px] text-cl-text outline-none focus:border-cl-lume/50"
                                />
                                <div className="mt-1">
                                    {addCandidates.map(m => (
                                        <button
                                            key={m.user_id}
                                            type="button"
                                            onClick={() => addMember(m)}
                                            className="w-full text-left h-[26px] px-2 rounded-md text-[12px] text-cl-muted hover:bg-white/[0.05] hover:text-cl-text truncate"
                                        >
                                            {m.name}
                                        </button>
                                    ))}
                                    {addCandidates.length === 0 && <div className="text-[11px] text-cl-faint px-2 py-1">No one else to add</div>}
                                </div>
                            </div>
                        )}
                        {shownMembers.map(m => renderTarget(
                            memberKey(m.user_id),
                            m.name,
                            <span className="w-2 h-2 rounded-full shrink-0 bg-cl-muted/40" />,
                        ))}
                        {shownMembers.length === 0 && !adding && (
                            <div className="text-[11px] text-cl-faint px-2 py-1 leading-snug">
                                {members.length ? 'None yet — add one to give a single person their own settings.' : 'Member list unavailable.'}
                            </div>
                        )}
                    </div>
                </div>

                {/* ── Rows ─────────────────────────────────────────────── */}
                <div className="flex-1 min-w-0 flex flex-col min-h-0">
                    {!selectedKey ? (
                        <div className="flex-1 flex items-center justify-center text-[12px] text-cl-faint">Pick a role or member.</div>
                    ) : (
                        <>
                            <div className="flex items-center gap-2 px-4 py-2 border-b border-cl-border/30 shrink-0">
                                <div className="min-w-0 flex-1">
                                    <div className="text-[13px] font-semibold text-cl-text truncate">{selName}</div>
                                    {locked ? (
                                        <div className="text-[10.5px] text-cl-glow truncate flex items-center gap-1" title={locked}>
                                            <Lock size={10} className="shrink-0" /> Read-only for you — {locked}
                                        </div>
                                    ) : (
                                        <div className="text-[10.5px] text-cl-faint truncate">
                                            {previewMember
                                                ? <>Showing <span className="text-cl-muted">{previewMember.name}</span>’s result — editing {selName}</>
                                                : parseKey(selectedKey).target_kind === 'role'
                                                    ? 'As a member with only this role'
                                                    : 'This member’s own override — beats every role'}
                                        </div>
                                    )}
                                </div>
                                <MiniButton tone="lume" disabled={!!locked} onClick={() => set(mask, 'allow', `Allow all for ${selName}`)} title="Allow every permission here">Allow all</MiniButton>
                                <MiniButton tone="flash" disabled={!!locked} onClick={() => set(mask, 'deny', `Deny all for ${selName}`)} title="Deny every permission here">Deny all</MiniButton>
                                <MiniButton disabled={!!locked} onClick={() => set(mask, 'inherit', `Clear ${selName}`)} title="Set everything back to Inherit">
                                    <RotateCcw size={10} /> Clear
                                </MiniButton>
                                <span className="w-px h-4 bg-cl-border/60 mx-0.5" aria-hidden="true" />
                                <MiniButton onClick={copyRole} title={`Copy ${selName}’s settings (Ctrl+C on the list)`}>
                                    <ClipboardCopy size={11} /> Copy
                                </MiniButton>
                                <MiniButton
                                    onClick={pasteRole}
                                    disabled={!clip.role || !!locked}
                                    title={clip.role ? `Paste ${clip.role.label} onto ${selName} (Ctrl+V on the list)` : 'Copy a role’s settings first'}
                                >
                                    <ClipboardPaste size={11} /> Paste
                                </MiniButton>
                                <MiniButton
                                    onClick={() => dispatch({ type: 'undo' })}
                                    disabled={!lastUndo}
                                    title={lastUndo ? `Undo “${lastUndo.label}” (Ctrl+Z)` : 'Nothing to undo'}
                                >
                                    <Undo2 size={11} /> Undo
                                </MiniButton>
                            </div>

                            <div className="flex-1 overflow-y-auto custom-scrollbar px-2 pb-3">
                                {sections.map(sec => {
                                    const bits = sec.permissions.map(p => p.bit);
                                    const secMask = bits.reduce((m, b) => m | b, 0n);
                                    // Nothing in this section is changeable by the caller → the
                                    // section control is off; a partly editable section stays on and
                                    // the guard clamps (and says so) per bit.
                                    const secLocked = (secMask & guard.editable) === 0n;
                                    return (
                                        <section key={sec.section} className="mt-2" aria-label={sec.title}>
                                            <div className="flex items-center gap-2 px-2 h-[30px]">
                                                <div className="flex-1 text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint">{sec.title}</div>
                                                <TriStateControl
                                                    size="sm"
                                                    value={triOfMask(selEntry, bits)}
                                                    onChange={t => set(secMask, t, `${sec.title} → ${t} for ${selName}`)}
                                                    label={`All ${sec.title} permissions for ${selName}`}
                                                    disabled={locked ? true : (secLocked ? SECTION_UNEDITABLE : undefined)}
                                                />
                                            </div>
                                            <div className="rounded-xl border border-solid border-cl-border/40 bg-cl-surface/25 divide-y divide-white/[0.04]">
                                                {sec.permissions.map(p => {
                                                    const tri = triOf(selEntry, p.bit);
                                                    const shown = effPreview ?? (tri === 'inherit' ? inhSel : effSel);
                                                    const reason = shown ? shown.explain(p.bit) : null;
                                                    const allowed = reason ? reasonAllows(reason) : false;
                                                    const redundant = !effPreview && tri !== 'inherit' && !!inhSel && !!effSel
                                                        && effSel.shortCircuit === null
                                                        && inhSel.has(p.bit) === (tri === 'allow');
                                                    // Mirror of the server's diff rule: a bit the caller does not
                                                    // hold HERE cannot be changed in either direction, only left as
                                                    // the server has it.
                                                    const cantChange = (p.bit & ~guard.editable) !== 0n;
                                                    return (
                                                        <div key={p.key} className="flex items-center gap-3 px-3 py-[7px]">
                                                            <div className="min-w-0 flex-1">
                                                                <div className="text-[12.5px] text-cl-text leading-tight">{p.label}</div>
                                                                {p.description && <div className="text-[10.5px] text-cl-faint leading-snug truncate">{p.description}</div>}
                                                            </div>
                                                            <div className="w-[230px] shrink-0 text-right" aria-live="polite">
                                                                {reason && (
                                                                    <div className={`text-[11px] leading-tight truncate ${allowed ? 'text-cl-lume/90' : 'text-cl-flash/90'}`} title={describeReason(reason)}>
                                                                        <span className="font-bold mr-1" aria-hidden="true">{allowed ? '✓' : '✕'}</span>
                                                                        {!effPreview && tri === 'inherit' && <span className="text-cl-faint">Inherits · </span>}
                                                                        {describeReason(reason)}
                                                                    </div>
                                                                )}
                                                                {redundant && <div className="text-[10px] text-cl-faint leading-tight">Same as inherited</div>}
                                                            </div>
                                                            <TriStateControl
                                                                value={tri}
                                                                onChange={t => set(p.bit, t, `${p.label} → ${t} for ${selName}`)}
                                                                label={`${p.label} for ${selName}`}
                                                                disabled={locked ? true : (cantChange ? BIT_UNEDITABLE : undefined)}
                                                            />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </section>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ChannelPermissionEditor;
