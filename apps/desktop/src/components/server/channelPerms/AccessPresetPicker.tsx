/**
 * AccessPresetPicker — the "who can get in" row on the quick-create screen.
 *
 * One click sets the whole override set (through the same reducer as the
 * full editor, so it is undoable and fully editable afterwards), and a live
 * line underneath says what the choice resolves to for this server's actual
 * roles. Private / Staff only / Read-only show role chips (hierarchy order)
 * to adjust who gets access: every role as a one-click chip while the server
 * has only a few, otherwise just the granted ones plus a "+ Role" search.
 *
 * Individual members are NOT searched here — that is per-member override
 * territory and lives in the Permissions tab. Member overrides that already
 * exist on the channel stay visible (and removable) as chips so opening this
 * screen never hides access.
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Globe, Link2, Lock, Megaphone, Mic, Plus, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import { Permissions, isAdministrator } from '@cipherline/shared';
import { readableRoleColorHex, roleColorHexFromInt } from '../../../utils/roleColor';
import type { Role } from '../roles/types';
import type { ChannelKind } from '../roles/permissions';
import { resolveEffective, type PermRole, type PermTier } from './effectivePermissions';
import { buildPreset, detectPreset, staffRoleIds, type PresetId } from './channelPresets';
import { roleKey, type EditorAction, type EditorState } from './overrideDraft';
import { describeAccess, summarizeAccess, tierFromDraft } from './accessSummary';
import type { GuardResult } from './editorGuard';
import type { EditorMember } from './usePermissionData';
import { useEscape } from '../../../hooks/useEscape';

type Choice = PresetId | 'sync';

/** Up to this many assignable roles, every role is a one-click chip. Past it
 *  only granted roles are chips and the rest are reached through "+ Role". */
export const ROLE_CHIP_THRESHOLD = 6;

interface Props {
    kind: ChannelKind;
    scope: 'channel' | 'category';
    roles: Role[];
    permRoles: PermRole[];
    members: EditorMember[];
    ownerUserId: string | null;
    currentUserId: string | null;
    inheritedTiers: PermTier[];
    /** Channel inside a category: offer (and default to) "Sync with category". */
    syncCategoryName: string | null;
    state: EditorState;
    dispatch: (a: EditorAction) => void;
    mask: bigint;
    guard: GuardResult;
    onOpenAdvanced: () => void;
}

export const AccessPresetPicker: React.FC<Props> = ({
    kind, scope, roles, permRoles, members, ownerUserId, currentUserId, inheritedTiers,
    syncCategoryName, state, dispatch, mask, guard, onOpenAdvanced,
}) => {
    const everyone = roles.find(r => r.is_everyone) ?? null;
    const staff = useMemo(() => staffRoleIds(permRoles), [permRoles]);
    const [adding, setAdding] = useState(false);
    const [addQuery, setAddQuery] = useState('');
    const [activeId, setActiveId] = useState<string | null>(null);
    const listId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const refocusTrigger = useRef(false);
    const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const closeFinder = (refocus = false) => {
        if (blurTimer.current) { clearTimeout(blurTimer.current); blurTimer.current = null; }
        refocusTrigger.current = refocus;
        setAdding(false);
        setAddQuery('');
        setActiveId(null);
    };
    // The finder's list is absolutely positioned inside the dialog's scroll body, so on a
    // short window it can open below the visible part of that body. Scroll it into view
    // (a no-op when it already is) instead of leaving it half hidden under the footer.
    useEffect(() => {
        if (!adding) return;
        document.getElementById(listId)?.scrollIntoView?.({ block: 'nearest' });
    }, [adding, listId]);
    // Esc backs out of the role finder only (shared escape stack), not the dialog.
    useEscape(() => closeFinder(true), adding);
    // Put keyboard focus back on "+ Role" after Esc / a pick (not after a blur).
    useEffect(() => {
        if (!adding && refocusTrigger.current) { refocusTrigger.current = false; triggerRef.current?.focus(); }
    }, [adding]);
    useEffect(() => () => { if (blurTimer.current) clearTimeout(blurTimer.current); }, []);

    const tierKind = scope;
    const tierLabel = scope === 'channel' ? 'this channel' : 'this category';
    const tiers = useMemo(
        () => [...inheritedTiers, tierFromDraft(tierKind, tierLabel, state.draft)],
        [inheritedTiers, tierKind, tierLabel, state.draft],
    );

    const everyoneViewInheritedDenied = useMemo(() => {
        if (!everyone || inheritedTiers.length === 0) return false;
        return !resolveEffective({ roles: permRoles, ownerUserId, tiers: inheritedTiers }, { kind: 'role', roleId: everyone.role_id })
            .has(Permissions.VIEW_CHANNEL);
    }, [everyone, inheritedTiers, permRoles, ownerUserId]);

    const detected = useMemo(
        () => everyone
            ? detectPreset(state.draft, { kind, everyoneRoleId: everyone.role_id, staffIds: staff, mask })
            : { id: 'custom' as const, roleIds: [], memberIds: [] },
        [state.draft, kind, everyone, staff, mask],
    );
    const empty = Object.values(state.draft).every(b => ((b.allow | b.deny) & mask) === 0n);
    // "Private" and "Staff only" can be the same override set; remember which
    // one the user actually picked so the button they clicked stays lit.
    const [intent, setIntent] = useState<'private' | 'staff' | null>(null);
    const current: Choice | 'custom' = syncCategoryName && empty
        ? 'sync'
        : (intent && (detected.id === 'private' || detected.id === 'staff') ? intent : detected.id);

    const summary = useMemo(
        () => describeAccess(summarizeAccess({ roles: permRoles, ownerUserId, tiers }, kind), kind),
        [permRoles, ownerUserId, tiers, kind],
    );

    // Would the person creating this still be able to see it?
    const selfLockout = useMemo(() => {
        if (guard.privileged || !currentUserId) return false;
        const me = members.find(m => m.user_id === currentUserId);
        if (!me) return false;
        return !resolveEffective({ roles: permRoles, ownerUserId, tiers }, {
            kind: 'member', userId: me.user_id, roleIds: me.role_ids, mutedUntil: me.muted_until,
        }).has(Permissions.VIEW_CHANNEL);
    }, [guard.privileged, currentUserId, members, permRoles, ownerUserId, tiers]);

    const editable = (rid: string) => !guard.lockedKeys.has(roleKey(rid));
    const myRoleIds = useMemo(() => {
        if (guard.privileged) return [];
        return members.find(m => m.user_id === currentUserId)?.role_ids.filter(editable) ?? [];
    }, [guard.privileged, members, currentUserId]); // eslint-disable-line react-hooks/exhaustive-deps

    const readonlyLabel = kind === 'huddle' ? 'Listen-only' : 'Read-only';
    const LABELS: Record<Choice, string> = {
        sync: syncCategoryName ? `Sync with ‘${syncCategoryName}’` : 'Sync',
        public: 'Public',
        private: 'Private',
        readonly: readonlyLabel,
        staff: 'Staff only',
    };
    const HINTS: Record<Choice, string> = {
        sync: 'No overrides of its own — follows the category, now and later.',
        public: 'Everyone in the server can see it.',
        private: 'Hidden from everyone except the roles and people you pick.',
        readonly: kind === 'huddle' ? 'Everyone can join and listen; only the picked roles can talk, show video or share.' : 'Everyone can read; only the picked roles can post.',
        staff: 'Only moderation roles (and admins) can see it.',
    };
    const ICONS: Record<Choice, React.ReactNode> = {
        sync: <Link2 size={13} />,
        public: <Globe size={13} />,
        private: <Lock size={13} />,
        readonly: kind === 'huddle' ? <Mic size={13} /> : <Megaphone size={13} />,
        staff: <ShieldCheck size={13} />,
    };

    const apply = (id: PresetId, roleIds: string[], memberIds: string[], label: string) => {
        if (!everyone) return;
        const draft = buildPreset(id, {
            kind,
            everyoneRoleId: everyone.role_id,
            roleIds: roleIds.filter(editable),
            memberIds,
            everyoneViewInheritedDenied,
        });
        dispatch({ type: 'replaceAll', draft, mask, label });
    };

    const choose = (c: Choice) => {
        if (c === 'sync') { dispatch({ type: 'replaceAll', draft: {}, mask, label: `Sync with ‘${syncCategoryName}’` }); return; }
        setIntent(c === 'private' || c === 'staff' ? c : null);
        const keep = (current === 'private' || current === 'staff' || current === 'readonly') ? detected.roleIds : [];
        // Private starts from whoever already had access (or just your own
        // roles, so you don't lock yourself out) — you pick the rest.
        const defaults = c === 'staff'
            ? staff
            : keep.length ? keep : c === 'private' ? myRoleIds : [...new Set([...staff, ...myRoleIds])];
        apply(c, defaults, c === 'staff' ? [] : detected.memberIds, LABELS[c]);
    };

    const grantedRoles = new Set(detected.roleIds);
    const toggleRole = (rid: string) => {
        const next = grantedRoles.has(rid) ? detected.roleIds.filter(r => r !== rid) : [...detected.roleIds, rid];
        if (current !== 'readonly') setIntent('private');
        apply(current === 'readonly' ? 'readonly' : 'private', next, detected.memberIds, 'Change who has access');
    };
    // Member overrides are only ever removed from here; adding one is done in
    // the Permissions tab.
    const removeMember = (uid: string) => {
        const next = detected.memberIds.filter(m => m !== uid);
        apply(current === 'readonly' ? 'readonly' : 'private', detected.roleIds, next, 'Remove member');
    };

    const choices: Choice[] = [
        ...(syncCategoryName ? ['sync' as const] : []),
        // Inside a category that's already public, "Public" and "Sync" are the
        // same empty set — offer just the one that says what it does.
        ...(!syncCategoryName || everyoneViewInheritedDenied ? ['public' as const] : []),
        'private', 'readonly', 'staff',
    ];

    const showRolePicker = current === 'private' || current === 'staff' || current === 'readonly';
    const pickable = roles.filter(r => !r.is_everyone && !isAdministrator(permRoles.find(p => p.role_id === r.role_id)?.permissions ?? 0n));
    const memberName = (uid: string) => members.find(m => m.user_id === uid)?.name ?? 'Unknown member';

    // Few roles: every role is a toggle chip. Many: only the granted ones, the
    // rest come from the "+ Role" search so the row doesn't sprawl.
    const showAllRoleChips = pickable.length <= ROLE_CHIP_THRESHOLD;
    const chipRoles = showAllRoleChips ? pickable : pickable.filter(r => grantedRoles.has(r.role_id));
    const addable = pickable.filter(r => !grantedRoles.has(r.role_id));
    const q = addQuery.trim().toLowerCase();
    const roleMatches = addable.filter(r => !q || r.name.toLowerCase().includes(q));
    const isPickable = (r: Role) => !guard.lockReasons.get(roleKey(r.role_id));
    const enabledMatches = roleMatches.filter(isPickable);
    // The highlighted option: the user's arrowed-to one if it is still listed,
    // else the first role that can actually be added.
    const activeRole = enabledMatches.find(r => r.role_id === activeId) ?? enabledMatches[0] ?? null;
    const optionId = (rid: string) => `${listId}-opt-${rid}`;

    const pickRole = (r: Role) => {
        if (!isPickable(r)) return;
        toggleRole(r.role_id);
        closeFinder(true);
    };
    const moveActive = (dir: 1 | -1) => {
        if (enabledMatches.length === 0) return;
        const i = activeRole ? enabledMatches.indexOf(activeRole) : -1;
        setActiveId(enabledMatches[(i + dir + enabledMatches.length) % enabledMatches.length].role_id);
    };

    return (
        <div>
            <div role="radiogroup" aria-label="Who can access" className="flex flex-wrap gap-1.5">
                {choices.map(c => {
                    const on = current === c;
                    return (
                        <button
                            key={c}
                            type="button"
                            role="radio"
                            aria-checked={on}
                            onClick={() => choose(c)}
                            title={HINTS[c]}
                            className={[
                                'inline-flex items-center gap-1.5 h-[30px] px-3 rounded-lg border border-solid text-[12.5px] font-semibold outline-none',
                                'motion-safe:transition-colors focus-visible:ring-2 focus-visible:ring-cl-lume/60',
                                on
                                    ? 'bg-cl-lume/[0.14] border-cl-lume/60 text-cl-lume'
                                    : 'bg-cl-surface/40 border-cl-border/60 text-cl-muted hover:border-cl-lume/35 hover:text-cl-text cursor-pointer',
                            ].join(' ')}
                        >
                            {ICONS[c]}{LABELS[c]}
                        </button>
                    );
                })}
                {current === 'custom' && (
                    <button
                        type="button"
                        role="radio"
                        aria-checked
                        onClick={onOpenAdvanced}
                        title="Custom overrides — open the full editor"
                        className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-lg border border-solid text-[12.5px] font-semibold bg-cl-glow/[0.10] border-cl-glow/50 text-cl-glow"
                    >
                        <SlidersHorizontal size={13} /> Custom
                    </button>
                )}
            </div>

            <div className="text-[11.5px] text-cl-muted mt-2 leading-snug" aria-live="polite">
                <span className="text-cl-faint">{current === 'custom' ? 'Custom overrides. ' : `${HINTS[current as Choice]} `}</span>
                {summary}.
            </div>

            {showRolePicker && (
                <div className="mt-2.5">
                    <div className="text-[10px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5">
                        {current === 'readonly' ? (kind === 'huddle' ? 'Who can talk' : 'Who can post') : 'Who gets in'}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                        {chipRoles.map(r => {
                            const on = grantedRoles.has(r.role_id);
                            const lock = guard.lockReasons.get(roleKey(r.role_id));
                            const hex = readableRoleColorHex(roleColorHexFromInt(r.color));
                            return (
                                <button
                                    key={r.role_id}
                                    type="button"
                                    role="checkbox"
                                    aria-checked={on}
                                    disabled={!!lock}
                                    title={lock ? `Locked: ${lock}` : undefined}
                                    onClick={() => toggleRole(r.role_id)}
                                    className={[
                                        'inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full border border-solid text-[12px] outline-none',
                                        'focus-visible:ring-2 focus-visible:ring-cl-lume/60',
                                        lock ? 'opacity-40 cursor-not-allowed border-cl-border/50 text-cl-faint'
                                            : on ? 'bg-cl-lume/[0.12] border-cl-lume/50 text-cl-text cursor-pointer'
                                                : 'border-cl-border/60 text-cl-faint hover:text-cl-muted hover:border-cl-lume/30 cursor-pointer',
                                    ].join(' ')}
                                >
                                    <span className="w-2 h-2 rounded-full" style={hex ? { backgroundColor: hex } : { border: '1.5px solid rgba(255,255,255,0.25)' }} />
                                    {r.name}
                                    {lock && <Lock size={10} />}
                                </button>
                            );
                        })}
                        {detected.memberIds.map(uid => (
                            <span key={uid} className="inline-flex items-center gap-1 h-[26px] pl-2.5 pr-1 rounded-full border border-solid border-cl-lume/40 bg-cl-lume/[0.08] text-[12px] text-cl-text">
                                {memberName(uid)}
                                <button type="button" onClick={() => removeMember(uid)} aria-label={`Remove ${memberName(uid)}`} className="w-5 h-5 flex items-center justify-center rounded-full text-cl-faint hover:text-cl-flash outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60">
                                    <X size={11} />
                                </button>
                            </span>
                        ))}
                        {addable.length > 0 && (
                            adding ? (
                                <span className="relative">
                                    <input
                                        autoFocus
                                        role="combobox"
                                        aria-expanded
                                        aria-haspopup="listbox"
                                        aria-controls={listId}
                                        aria-autocomplete="list"
                                        aria-activedescendant={activeRole ? optionId(activeRole.role_id) : undefined}
                                        aria-label="Add a role"
                                        value={addQuery}
                                        onChange={e => { setAddQuery(e.target.value); setActiveId(null); }}
                                        onKeyDown={e => {
                                            if (e.key === 'Enter') {
                                                e.preventDefault();
                                                if (activeRole) pickRole(activeRole);
                                            } else if (e.key === 'ArrowDown') {
                                                e.preventDefault();
                                                moveActive(1);
                                            } else if (e.key === 'ArrowUp') {
                                                e.preventDefault();
                                                moveActive(-1);
                                            }
                                        }}
                                        onBlur={() => {
                                            if (blurTimer.current) clearTimeout(blurTimer.current);
                                            blurTimer.current = setTimeout(() => closeFinder(), 150);
                                        }}
                                        placeholder="Add a role…"
                                        className="h-[26px] w-[150px] px-2.5 py-0 focus:ring-0 rounded-full bg-cl-sink/70 border border-solid border-cl-lume/40 text-[12px] text-cl-text outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60"
                                    />
                                    <span
                                        id={listId}
                                        role="listbox"
                                        aria-label="Roles"
                                        className="absolute left-0 top-[30px] z-10 w-[220px] max-h-[188px] overflow-y-auto rounded-lg border border-solid border-cl-border bg-cl-deep shadow-cl-menu p-1 flex flex-col"
                                    >
                                        {roleMatches.map(r => {
                                            const lock = guard.lockReasons.get(roleKey(r.role_id));
                                            const hex = readableRoleColorHex(roleColorHexFromInt(r.color));
                                            const active = activeRole?.role_id === r.role_id;
                                            return (
                                                <span
                                                    key={r.role_id}
                                                    id={optionId(r.role_id)}
                                                    role="option"
                                                    aria-selected={active}
                                                    aria-disabled={lock ? true : undefined}
                                                    title={lock ? `Locked: ${lock}` : undefined}
                                                    onMouseDown={e => e.preventDefault()}
                                                    onMouseEnter={() => { if (!lock) setActiveId(r.role_id); }}
                                                    onClick={() => pickRole(r)}
                                                    className={[
                                                        'flex items-center gap-1.5 text-left h-[26px] px-2 rounded-md text-[12px]',
                                                        lock ? 'opacity-40 cursor-not-allowed text-cl-faint'
                                                            : active ? 'bg-white/[0.07] text-cl-text cursor-pointer'
                                                                : 'text-cl-muted hover:bg-white/[0.05] hover:text-cl-text cursor-pointer',
                                                    ].join(' ')}
                                                >
                                                    <span className="w-2 h-2 shrink-0 rounded-full" style={hex ? { backgroundColor: hex } : { border: '1.5px solid rgba(255,255,255,0.25)' }} />
                                                    <span className="truncate">{r.name}</span>
                                                    {lock && <Lock size={10} className="shrink-0 ml-auto" />}
                                                </span>
                                            );
                                        })}
                                        {roleMatches.length === 0 && (
                                            <span className="h-[26px] px-2 flex items-center text-[12px] text-cl-faint">No matching roles</span>
                                        )}
                                    </span>
                                </span>
                            ) : (
                                <button
                                    ref={triggerRef}
                                    type="button"
                                    onClick={() => setAdding(true)}
                                    className="inline-flex items-center gap-1 h-[26px] px-2.5 rounded-full border border-dashed border-cl-border/70 text-[12px] text-cl-faint hover:text-cl-lume hover:border-cl-lume/40 outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60"
                                >
                                    <Plus size={11} /> Role
                                </button>
                            )
                        )}
                    </div>
                    {members.length > 0 && current !== 'staff' && (
                        <button
                            type="button"
                            onClick={onOpenAdvanced}
                            className="mt-1.5 text-[11px] text-cl-faint hover:text-cl-lume hover:underline underline-offset-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/60"
                        >
                            Members: set in Permissions
                        </button>
                    )}
                </div>
            )}

            {selfLockout && (
                <div className="mt-2 text-[11.5px] text-cl-glow flex items-center gap-1.5" role="alert">
                    <AlertTriangle size={12} />
                    You won’t be able to see this {scope === 'category' ? 'category' : 'channel'} yourself — add one of your roles.
                </div>
            )}
        </div>
    );
};

export default AccessPresetPicker;
