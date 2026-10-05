/**
 * RoleDisplayEditor — name, color palette + custom picker, mentionable
 * toggle, and a live preview chip.
 *
 * Auto-saves: name input debounces PATCH by 500ms; color clicks are
 * immediate (palette presets) or debounced 300ms (native picker drag).
 * Toggles (mentionable / hoist) fire PATCH immediately.
 */

import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Lock, Trash2 } from 'lucide-react';
import { API_BASE } from '../../../constants';
import { roleColorHexFromInt } from '../../../utils/roleColor';
import { ClButton, ClInput, ClToggle } from '../../cl';
import type { Role } from './types';

const PRESET_COLORS = [
    '#25E0C8', // lume — brand accent
    '#FF6B5E', // flash — danger/energy
    '#5865F2', // classic blurple
    '#23CF65', // ok green
    '#F5A623', // warm gold
    '#A855F7', // violet
    '#EC4899', // fuchsia
    '#64748B', // cool slate
];

interface Props {
    role: Role;
    serverId: string;
    token: string | null;
    readOnly?: boolean;
    /** Show the hero's Delete action (MANAGE_ROLES holder, non-@everyone). */
    canDelete?: boolean;
    onDelete?: () => void;
    onSaved: (next: Role) => void;
    onError?: (msg: string) => void;
    onDirtyChange?: (dirty: boolean) => void;
}

export const RoleDisplayEditor: React.FC<Props> = ({ role, serverId, token, readOnly, canDelete, onDelete, onSaved, onError, onDirtyChange }) => {
    const [name, setName] = useState(role.name);
    const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [localColorHex, setLocalColorHex] = useState<string | null>(() => roleColorHexFromInt(role.color));
    const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const nameRef = useRef(name);
    nameRef.current = name;

    useEffect(() => { setLocalColorHex(roleColorHexFromInt(role.color)); }, [role.role_id]);
    useEffect(() => { setName(role.name); }, [role.role_id, role.name]);

    const patchRef = useRef<typeof patch | null>(null);
    useEffect(() => () => {
        if (nameTimer.current) {
            clearTimeout(nameTimer.current);
            nameTimer.current = null;
            const trimmed = nameRef.current.trim();
            if (trimmed && patchRef.current) patchRef.current({ name: trimmed });
        }
        if (colorTimer.current) {
            clearTimeout(colorTimer.current);
            colorTimer.current = null;
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const nameDirty = name.trim() !== role.name && name.trim().length > 0;
    useEffect(() => { onDirtyChange?.(nameDirty); }, [nameDirty]); // eslint-disable-line react-hooks/exhaustive-deps

    const patch = async (props: Partial<Role>): Promise<void> => {
        if (!token || readOnly) return;
        // Optimistic: apply the change to the parent's role state IMMEDIATELY so
        // the toggle/name/colour reflects the click without waiting on the PATCH
        // round-trip. Previously onSaved only fired after the await, so a toggle
        // sat unresponsive for the full request latency (~1s on a slow link)
        // before it visibly flipped. Snapshot the prior values first so a failed
        // request can roll the optimistic change back.
        const roleRec = role as unknown as Record<string, unknown>;
        const prev = Object.fromEntries(
            Object.keys(props).map(k => [k, roleRec[k]]),
        ) as Partial<Role>;
        onSaved({ ...role, ...props });
        try {
            await axios.patch(
                `${API_BASE}/servers/${serverId}/roles/${role.role_id}`,
                props,
                { headers: { Authorization: `Bearer ${token}` } },
            );
        } catch (e: any) {
            onSaved({ ...role, ...prev }); // roll back the optimistic apply
            onError?.(e?.response?.data?.message ?? 'Failed to update role');
        }
    };
    patchRef.current = patch;

    const onNameChange = (v: string) => {
        setName(v);
        if (nameTimer.current) clearTimeout(nameTimer.current);
        nameTimer.current = setTimeout(() => {
            const trimmed = v.trim();
            if (trimmed && trimmed !== role.name) patch({ name: trimmed });
        }, 500);
    };

    const applyColorHex = (hex: string) => {
        const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
        if (!m) return;
        setLocalColorHex(`#${m[1]}`);
        if (colorTimer.current) clearTimeout(colorTimer.current);
        colorTimer.current = setTimeout(() => {
            patch({ color: parseInt(m[1], 16) });
        }, 300);
    };

    const applyColorImmediate = (hex: string) => {
        const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
        if (!m || readOnly) return;
        if (colorTimer.current) { clearTimeout(colorTimer.current); colorTimer.current = null; }
        setLocalColorHex(`#${m[1]}`);
        patch({ color: parseInt(m[1], 16) });
    };

    const onColorReset = () => {
        if (colorTimer.current) { clearTimeout(colorTimer.current); colorTimer.current = null; }
        setLocalColorHex(null);
        patch({ color: -1 });
    };

    const previewColor = localColorHex ?? 'rgba(255,255,255,0.9)';
    // Live preview name mirrors the local (debounced) name input, not the
    // saved role.name, so the hero updates as you type.
    const liveName = name.trim() || 'role name';
    const displayName = liveName.startsWith('@') ? liveName : `@${liveName}`;

    return (
        <div className="space-y-8">
            {/* ── Identity hero ──────────────────────────────────────────
                Color-washed banner that IS the pane's header + live preview in
                one (was previously two separate elements both showing the
                name-in-colour). A soft diagonal wash + edge glow keyed to the
                role colour gives each role a distinct on-brand identity rather
                than the generic settings-card look. */}
            <div
                className="relative overflow-hidden rounded-[18px] border px-5 py-5"
                style={{
                    borderColor: localColorHex ? `${localColorHex}33` : 'rgba(255,255,255,0.07)',
                    background: localColorHex
                        ? `linear-gradient(120deg, ${localColorHex}1f 0%, ${localColorHex}0a 42%, rgba(255,255,255,0.015) 100%)`
                        : 'linear-gradient(120deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.015) 60%, transparent 100%)',
                }}
            >
                {/* corner bloom */}
                {localColorHex && (
                    <span
                        aria-hidden
                        className="pointer-events-none absolute -top-10 -right-8 w-40 h-40 rounded-full blur-3xl"
                        style={{ background: `${localColorHex}22` }}
                    />
                )}
                <div className="relative flex items-center gap-4">
                    <span
                        className="w-12 h-12 rounded-2xl shrink-0 flex items-center justify-center text-[20px] font-bold"
                        style={{
                            backgroundColor: localColorHex ? `${localColorHex}26` : 'rgba(255,255,255,0.07)',
                            color: previewColor,
                            boxShadow: localColorHex ? `0 0 20px ${localColorHex}45, inset 0 0 0 1px ${localColorHex}40` : 'inset 0 0 0 1px rgba(255,255,255,0.08)',
                        }}
                    >
                        {(liveName[0] ?? 'R').toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-mono font-semibold uppercase tracking-[1.4px] text-cl-faint m-0 mb-1">
                            {role.is_everyone ? 'Default role' : 'Server role'}
                        </p>
                        <p className="text-[22px] font-bold leading-none tracking-tight truncate" style={{ color: previewColor }}>
                            {displayName}
                        </p>
                    </div>
                    {role.is_everyone && (
                        <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full bg-black/25 text-cl-faint shrink-0 backdrop-blur-sm">
                            <Lock size={10} /> default
                        </span>
                    )}
                    {canDelete && (
                        <ClButton variant="danger" size="sm" onClick={onDelete} className="shrink-0">
                            <Trash2 size={13} /> Delete
                        </ClButton>
                    )}
                </div>
            </div>

            {/* ── Role name ──────────────────────────────────────────── */}
            <section>
                <label className="block text-[11px] font-mono font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--cl-faint)' }}>
                    Role Name
                </label>
                <ClInput
                    type="text"
                    value={name}
                    onChange={e => onNameChange(e.target.value)}
                    disabled={readOnly || role.is_everyone}
                    maxLength={50}
                    placeholder="role name"
                />
                {role.is_everyone && (
                    <p className="mt-2 text-[12px] text-cl-faint">@everyone is the default role and cannot be renamed.</p>
                )}
            </section>

            {/* ── Color picker — hidden for @everyone ─────────────────── */}
            {!role.is_everyone && (
                <section>
                    <div className="flex items-center justify-between mb-3">
                        <label className="text-[11px] font-mono font-semibold uppercase tracking-widest" style={{ color: 'var(--cl-faint)' }}>
                            Role Color
                        </label>
                        {localColorHex && (
                            <ClButton variant="ghost" size="sm" onClick={onColorReset} disabled={readOnly}>
                                Reset
                            </ClButton>
                        )}
                    </div>

                    {/* Preset palette + custom picker */}
                    <div className="flex flex-wrap items-center gap-2">
                        {/* "None" swatch */}
                        <button
                            type="button"
                            disabled={readOnly}
                            onClick={onColorReset}
                            title="No color"
                            className={`w-7 h-7 rounded-full border-2 transition-all ${
                                !localColorHex
                                    ? 'border-white scale-110 ring-2 ring-white/20 ring-offset-1 ring-offset-cl-deep'
                                    : 'border-white/20 hover:border-white/40'
                            }`}
                            style={{
                                backgroundImage: 'repeating-conic-gradient(rgba(255,255,255,0.06) 0 25%, transparent 0 50%)',
                                backgroundSize: '10px 10px',
                            }}
                        />
                        {PRESET_COLORS.map(c => {
                            const active = localColorHex?.toLowerCase() === c.toLowerCase();
                            return (
                                <button
                                    key={c}
                                    type="button"
                                    disabled={readOnly}
                                    onClick={() => applyColorImmediate(c)}
                                    title={c}
                                    className={`w-7 h-7 rounded-full border-2 transition-all ${
                                        active
                                            ? 'border-white scale-110'
                                            : 'border-transparent hover:scale-110'
                                    }`}
                                    style={{
                                        backgroundColor: c,
                                        boxShadow: active ? `0 0 10px ${c}80` : undefined,
                                    }}
                                />
                            );
                        })}
                        {/* Custom picker */}
                        <label
                            className="w-7 h-7 rounded-full cursor-pointer border-2 border-dashed border-white/25 flex items-center justify-center text-[11px] text-cl-faint hover:border-white/50 hover:text-cl-muted transition-colors"
                            title="Custom color"
                        >
                            +
                            <input
                                type="color"
                                className="sr-only"
                                value={localColorHex ?? '#5865f2'}
                                onChange={e => applyColorHex(e.target.value)}
                                disabled={readOnly}
                            />
                        </label>
                    </div>

                    {localColorHex && (
                        <p className="mt-2 text-[12px] text-cl-faint">
                            Selected: <span className="font-mono text-cl-muted">{localColorHex}</span>
                            <span className="ml-2 text-cl-faint">· member names use the highest role's color</span>
                        </p>
                    )}
                </section>
            )}

            {/* ── Options — both toggles in one divided card (one idiom,
                   matching the app's other settings cards) ─────────────── */}
            <section>
                <label className="block text-[11px] font-mono font-semibold uppercase tracking-widest mb-2" style={{ color: 'var(--cl-faint)' }}>
                    Options
                </label>
                <div className="rounded-[14px] border border-cl-border/40 bg-white/[0.02] divide-y divide-white/[0.05]">
                    <div className="flex items-center justify-between px-5 py-4">
                        <span className="flex-1 pr-4">
                            <span className="block text-[14px] font-medium text-cl-text">Allow @mention</span>
                            <span className="block text-[12px] text-cl-faint mt-0.5">
                                Anyone can ping this role. When off, only members with Mention @everyone can.
                            </span>
                        </span>
                        <ClToggle checked={role.mentionable} onChange={v => patch({ mentionable: v })} disabled={readOnly} />
                    </div>
                    <div className="flex items-center justify-between px-5 py-4">
                        <span className="flex-1 pr-4">
                            <span className="block text-[14px] font-medium text-cl-text">Display members separately</span>
                            <span className="block text-[12px] text-cl-faint mt-0.5">
                                Members with this role appear in their own group in the member list.
                            </span>
                        </span>
                        <ClToggle checked={role.hoisted} onChange={v => patch({ hoisted: v })} disabled={readOnly} />
                    </div>
                </div>
            </section>
        </div>
    );
};
