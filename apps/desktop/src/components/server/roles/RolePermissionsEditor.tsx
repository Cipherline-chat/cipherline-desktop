/**
 * RolePermissionsEditor — chip-grid layout for the role's permission bitfield.
 *
 * Permissions are grouped under section headings (General / Membership /
 * Text / Voice). A chip shows THIS ROLE'S OWN grant — teal = granted by this
 * role, red = granted and dangerous (Administrator), dim = not granted by this
 * role. A separate `@everyone` marker on the chip says "every member already
 * has this anyway", which is orthogonal to the role's own bit and never blocks
 * editing it. Save/reset sticky footer appears only when there are unsaved
 * changes.
 *
 * Three behaviours here are deliberate reversals of the original version:
 *
 *  1. EVERY chip toggles. It used to hard-return out of `toggle()` for any bit
 *     @everyone happened to grant, and to stamp those chips `pointer-events:
 *     none` — which killed ~13 of the 28 chips (the whole
 *     `DEFAULT_EVERYONE_PERMISSIONS` set) with no feedback at all. The lock had
 *     no server counterpart: `PermissionsService.resolveServerPermissions` ORs
 *     @everyone with each held role, so a role's own bit is independent and
 *     worth setting — it is what survives if @everyone later loses the
 *     permission.
 *  2. The chip's on/off state is the role's OWN bit, not the OR. Showing the OR
 *     made a permission the role explicitly holds render identically to one it
 *     does not, so the editor could not be read at all.
 *  3. Descriptions are an inline, fixed-height line under each group instead of
 *     a hover tooltip. The tooltip was a ~380px overlay on a ~110px chip: it
 *     armed 400ms after hover, got clamped to the window edge (well away from
 *     the chip it described, on top of the section heading), and was destroyed
 *     again by the pointerdown of the very click it was describing. That flash
 *     was the reported "weird thing that pops up and goes away really fast".
 */

import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, Users } from 'lucide-react';
import { API_BASE } from '../../../constants';
import {
    PERMISSION_GROUPS,
    countGroup,
    parsePermissions,
    permissionChipState,
    togglePermissionBit,
    type PermissionDescriptor,
} from './permissions';
import type { Role } from './types';
import { ClButton } from '../../cl';

interface Props {
    role: Role;
    serverId: string;
    token: string | null;
    readOnly?: boolean;
    everyonePerms?: bigint;
    onSaved: (next: Role) => void;
    onError?: (msg: string) => void;
    onDirtyChange?: (dirty: boolean) => void;
}

export const RolePermissionsEditor: React.FC<Props> = ({
    role, serverId, token, readOnly, everyonePerms, onSaved, onError, onDirtyChange,
}) => {
    const [bits, setBits] = useState<bigint>(() => parsePermissions(role.permissions));
    const [saving, setSaving] = useState(false);
    /** Permission whose description is currently shown, per group title. */
    const [hovered, setHovered] = useState<Record<string, PermissionDescriptor | null>>({});

    useEffect(() => { setBits(parsePermissions(role.permissions)); }, [role.role_id, role.permissions]);

    const dirty = bits.toString(10) !== parsePermissions(role.permissions).toString(10);
    useEffect(() => { onDirtyChange?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

    const isAdmin = (bits & 1n) === 1n;
    const everyone = everyonePerms ?? 0n;

    const stateOf = (bit: bigint) =>
        permissionChipState(bits, everyone, bit, role.is_everyone);

    /** Any chip in this role inherits from @everyone → show the legend. */
    const anyInherited = useMemo(
        () => !role.is_everyone && PERMISSION_GROUPS.some(
            g => g.permissions.some(p => stateOf(p.bit).viaEveryone && !stateOf(p.bit).own),
        ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [bits, everyone, role.is_everyone],
    );

    const toggle = (bit: bigint) => {
        if (readOnly) return;
        setBits(prev => togglePermissionBit(prev, bit));
    };

    const save = async () => {
        if (!token || !dirty || saving) return;
        setSaving(true);
        try {
            await axios.patch(
                `${API_BASE}/servers/${serverId}/roles/${role.role_id}`,
                { permissions: bits.toString(10) },
                { headers: { Authorization: `Bearer ${token}` } },
            );
            onSaved({ ...role, permissions: bits.toString(10) });
        } catch (e: any) {
            onError?.(e?.response?.data?.message ?? 'Failed to save permissions');
        } finally { setSaving(false); }
    };

    const reset = () => setBits(parsePermissions(role.permissions));

    return (
        <div className="flex flex-col">
            {/* Admin warning banner */}
            {isAdmin && (
                <div className="mb-6 rounded-[14px] border border-cl-flash/30 bg-cl-flash/10 px-4 py-3 flex items-start gap-3">
                    <AlertTriangle size={18} className="text-cl-flash shrink-0 mt-0.5" />
                    <div>
                        <p className="text-[13px] font-semibold text-cl-flash">Administrator bypasses every other permission.</p>
                        <p className="text-[12px] text-cl-flash/70 mt-0.5">Members in this role can do anything in the server. Grant carefully.</p>
                    </div>
                </div>
            )}

            {/* Legend — explains the @everyone marker the moment one is on screen.
                Without it the marker is just an unexplained glyph; with it the
                editor answers "what does this role add on top of the baseline?"
                at a glance, which is the whole point of showing inheritance. */}
            {anyInherited && (
                <div className="mb-3 flex items-center gap-2 text-[11px]" style={{ color: 'var(--cl-faint)' }}>
                    <Users size={12} className="shrink-0" style={{ color: 'var(--cl-lume)' }} />
                    <span>
                        Marked permissions are already granted to <strong className="font-semibold">@everyone</strong>,
                        so all members have them whether or not this role does. Turning one on here only matters
                        if @everyone later loses it.
                    </span>
                </div>
            )}

            {/* Permission groups — each is a card on the drafting table with a
                granted-counter in the header, so the shape of a role can be
                read at a glance without parsing every chip. */}
            <div className="space-y-4">
                {PERMISSION_GROUPS.map(group => {
                    const tally = countGroup(group, bits, everyone, role.is_everyone);
                    const active = hovered[group.title] ?? null;
                    const activeState = active ? stateOf(active.bit) : null;
                    return (
                    <section
                        key={group.title}
                        className="rounded-[14px] border border-cl-border/40 px-4 pt-3.5 pb-3"
                        style={{ background: 'rgba(28,37,66,.35)' }}
                    >
                        <div className="flex items-baseline justify-between gap-3 mb-3">
                            <p
                                className="text-[10px] font-mono font-semibold uppercase tracking-widest m-0"
                                style={{ color: 'var(--cl-faint)' }}
                            >
                                {group.title}
                            </p>
                            <span className="text-[10px] font-mono font-semibold shrink-0">
                                <span style={{ color: tally.own > 0 ? 'var(--cl-lume)' : 'var(--cl-faint)' }}>
                                    {tally.own}/{tally.total} on this role
                                </span>
                                {tally.viaEveryoneOnly > 0 && (
                                    <span style={{ color: 'var(--cl-faint)' }}>
                                        {' · '}{tally.viaEveryoneOnly} via @everyone
                                    </span>
                                )}
                            </span>
                        </div>
                        <div
                            className="flex flex-wrap gap-2"
                            onMouseLeave={() => setHovered(h => ({ ...h, [group.title]: null }))}
                        >
                            {group.permissions.map(p => {
                                const s = stateOf(p.bit);
                                const danger = !!p.danger;
                                return (
                                    <span
                                        key={p.key}
                                        onMouseEnter={() => setHovered(h => ({ ...h, [group.title]: p }))}
                                        onFocus={() => setHovered(h => ({ ...h, [group.title]: p }))}
                                    >
                                        <ClButton
                                            chip
                                            variant="ghost"
                                            active={s.own}
                                            onClick={() => toggle(p.bit)}
                                            className={danger && s.own ? 'perm-danger' : undefined}
                                        >
                                            {p.label}
                                            {s.viaEveryone && (
                                                <Users
                                                    size={11}
                                                    aria-label="already granted to @everyone"
                                                    style={{
                                                        // Always lume, never the chip's own text colour: the
                                                        // marker states a fact about @everyone, not about
                                                        // whether this role grants the bit.
                                                        color: 'var(--cl-lume)',
                                                        opacity: s.own ? 0.9 : 0.75,
                                                    }}
                                                />
                                            )}
                                        </ClButton>
                                    </span>
                                );
                            })}
                        </div>

                        {/* Description line. Fixed min-height and always rendered, so
                            moving across the chips never reflows the card and nothing
                            ever overlays the grid. Replaces the per-chip hover
                            tooltip — see the header comment. */}
                        <p
                            className="text-[11px] leading-[16px] mt-2.5 mb-0 min-h-[16px]"
                            style={{ color: 'var(--cl-faint)' }}
                            role="status"
                            aria-live="polite"
                        >
                            {active && (
                                <>
                                    <span className="font-semibold" style={{ color: 'var(--cl-muted)' }}>{active.label}</span>
                                    {active.description ? <> — {active.description}</> : null}
                                    {activeState?.viaEveryone && (
                                        <span style={{ color: 'var(--cl-lume)' }}>
                                            {' · '}already granted to @everyone
                                        </span>
                                    )}
                                </>
                            )}
                        </p>
                    </section>
                    );
                })}
            </div>

            {/* Sticky save/reset footer */}
            {dirty && !readOnly && (
                <div
                    className="sticky bottom-0 mt-6 -mx-2 px-4 py-3 rounded-[14px] border border-cl-border/50 flex items-center justify-between shadow-lg"
                    style={{ background: 'var(--cl-deep)' }}
                >
                    <span className="text-[13px] text-cl-muted">Unsaved permission changes</span>
                    <div className="flex gap-2">
                        <ClButton size="sm" variant="ghost" onClick={reset}>Reset</ClButton>
                        <ClButton size="sm" disabled={saving} loading={saving} onClick={save}>Save</ClButton>
                    </div>
                </div>
            )}
        </div>
    );
};
