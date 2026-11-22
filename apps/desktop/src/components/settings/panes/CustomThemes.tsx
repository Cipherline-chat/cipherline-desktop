import React, { useMemo, useRef, useState } from 'react';
import { Check, Copy, Eye, Import, Pencil, Plus, Share2, Trash2 } from 'lucide-react';
import { ClButton, ClConfirm } from '../../cl';
import { useAuth } from '../../../contexts/AuthContext';
import { getActiveCustomThemeId, startThemePreview, useTheme, useThemePreference, useThemePreview } from '../../../theme/engine';
import { customThemeFromBase, customThemeFromTheme, deriveCustomTheme, type CustomThemeDef, type StoredCustomTheme } from '../../../theme/customTheme';
import { chooseCustomTheme } from '../../../theme/activeThemeMirror';
import { useCustomThemes } from '../../../theme/customThemeLibrary';
import { CustomThemeEditor } from './CustomThemeEditor';
import { CustomThemeExportDialog, CustomThemeImportDialog } from './CustomThemeShareDialog';
import { CustomThemeMini } from './CustomThemePreview';
import '../../../styles/custom-themes.css';

/**
 * Settings → Appearance → Theme → "Your themes": the custom theme library
 * (theme/customThemeLibrary.ts) as picker tiles under the built-in ones, plus
 * Create / Import, and Edit / Duplicate / Share / Delete on each tile.
 * Picking a tile applies it on this device (engine.setCustomTheme); the
 * library itself follows the account (backups + the `themes` sync slot).
 * Free for everyone (owner decision D5).
 */

type Dialog =
    | { kind: 'create'; seed: CustomThemeDef }
    | { kind: 'edit'; theme: StoredCustomTheme }
    | { kind: 'export'; def: CustomThemeDef }
    | { kind: 'import' }
    | { kind: 'delete'; theme: StoredCustomTheme }
    | null;

const stripId = ({ id: _id, ...def }: StoredCustomTheme): CustomThemeDef => { void _id; return def; };

export const CustomThemes: React.FC = () => {
    const { userId, user } = useAuth();
    const uid = userId ?? user?.user_id ?? null;
    const lib = useCustomThemes(uid);
    const pref = useThemePreference();
    const active = useTheme();
    const previewing = useThemePreview();
    const activeId = pref === 'custom' ? getActiveCustomThemeId() : null;
    const [dialog, setDialog] = useState<Dialog>(null);
    const minis = useMemo(() => new Map(lib.items.map((t) => [t.id, deriveCustomTheme(stripId(t), t.id)])), [lib.items]);

    const pickTheme = (t: StoredCustomTheme) => { void chooseCustomTheme(uid, t.id, stripId(t)); };
    // Keyboard, as the built-in tiles above (ThemePicker): one Tab stop for the
    // tiles (the theme in use, else the first), arrow keys move AND use; each
    // tile's Edit / Duplicate / Share / Delete stay ordinary Tab stops.
    const pickRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const activeIndex = lib.items.findIndex((t) => t.id === activeId);
    const onPickKeyDown = (e: React.KeyboardEvent, i: number) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step || lib.items.length < 2) return;
        e.preventDefault();
        const n = lib.items.length;
        const next = (i + step + n) % n;
        pickTheme(lib.items[next]);
        pickRefs.current[next]?.focus();
    };
    const createAndUse = (def: CustomThemeDef): boolean => {
        const entry = lib.create(def);
        if (!entry) return false;
        void chooseCustomTheme(uid, entry.id, stripId(entry));
        return true;
    };
    const canAdd = lib.ready && !lib.full;
    const addHint = !lib.ready ? 'Your themes are loading…' : lib.full ? 'You have 24 themes. Delete one to add another.' : '';

    return (
        <div className="ctl" data-labels="Custom themes|Create theme|Import theme|Theme code">
            <div className="ctl-head">
                <div>
                    <h4>Your themes</h4>
                    <p className="sd-sub">Make your own from a few colours. They are saved in your encrypted backups and follow you to your other devices.</p>
                </div>
                <div className="ctl-head-actions">
                    <ClButton variant="ghost" size="sm" onClick={() => setDialog({ kind: 'import' })} disabled={!canAdd}><Import size={14} /> Import</ClButton>
                </div>
            </div>
            <div className="tp-grid ctl-grid">
                {lib.items.map((t, i) => {
                    const on = t.id === activeId;
                    const isPreview = previewing?.libraryId === t.id;
                    const mini = minis.get(t.id)!;
                    return (
                        <div key={t.id} className={`tp-opt ctl-tile${on ? ' tp-opt--on' : ''}${isPreview ? ' ctl-tile--preview' : ''}`} data-custom-theme-tile={t.id}>
                            <button
                                type="button"
                                className="ctl-pick"
                                ref={(el) => { pickRefs.current[i] = el; }}
                                tabIndex={on || (activeIndex < 0 && i === 0) ? 0 : -1}
                                aria-pressed={on}
                                onClick={() => pickTheme(t)}
                                onKeyDown={(e) => onPickKeyDown(e, i)}
                                aria-label={`Use ${t.name}`}
                            >
                                <span className="tp-pic">
                                    <CustomThemeMini theme={mini} />
                                    {on && <span className="tp-check"><Check size={13} strokeWidth={3} /></span>}
                                </span>
                                <span className="tp-label">{t.name}</span>
                                <span className="tp-desc">{isPreview ? 'Previewing' : `${t.base === 'dark' ? 'Dark' : 'Light'} base${t.glow ? ' · glow' : ''}`}</span>
                            </button>
                            <div className="ctl-actions">
                                <ClButton
                                    variant="ghost"
                                    size="sm"
                                    icon
                                    ariaLabel={`Preview ${t.name}`}
                                    tooltip={on ? 'In use' : isPreview ? 'Previewing now' : 'Preview on the whole app'}
                                    disabled={on}
                                    ariaPressed={isPreview}
                                    onClick={() => startThemePreview(stripId(t), { libraryId: t.id })}
                                ><Eye size={14} /></ClButton>
                                <ClButton variant="ghost" size="sm" icon ariaLabel={`Edit ${t.name}`} tooltip="Edit" onClick={() => setDialog({ kind: 'edit', theme: t })}><Pencil size={14} /></ClButton>
                                <ClButton variant="ghost" size="sm" icon ariaLabel={`Duplicate ${t.name}`} tooltip="Duplicate" disabled={!canAdd} onClick={() => { lib.duplicate(t.id); }}><Copy size={14} /></ClButton>
                                <ClButton variant="ghost" size="sm" icon ariaLabel={`Share ${t.name}`} tooltip="Share" onClick={() => setDialog({ kind: 'export', def: stripId(t) })}><Share2 size={14} /></ClButton>
                                <ClButton variant="ghost" size="sm" icon ariaLabel={`Delete ${t.name}`} tooltip="Delete" onClick={() => setDialog({ kind: 'delete', theme: t })}><Trash2 size={14} /></ClButton>
                            </div>
                        </div>
                    );
                })}
                <button
                    type="button"
                    className="ctl-new"
                    onClick={() => setDialog({ kind: 'create', seed: active.customId ? customThemeFromBase(active.scheme) : customThemeFromTheme(active) })}
                    disabled={!canAdd}
                    title={addHint || undefined}
                    data-create-theme
                >
                    <span className="ctl-new-ic" aria-hidden="true"><Plus size={18} strokeWidth={2.5} /></span>
                    <span className="tp-label">Create theme</span>
                    <span className="tp-desc">{addHint || 'Nine colours, a live preview, readable by design.'}</span>
                </button>
            </div>

            {dialog?.kind === 'create' && (
                <CustomThemeEditor
                    mode="create"
                    initial={dialog.seed}
                    onCancel={() => setDialog(null)}
                    onSave={(def) => { const ok = createAndUse(def); if (ok) setDialog(null); return ok; }}
                />
            )}
            {dialog?.kind === 'edit' && (
                <CustomThemeEditor
                    mode="edit"
                    initial={stripId(dialog.theme)}
                    onCancel={() => setDialog(null)}
                    onShare={() => setDialog({ kind: 'export', def: stripId(dialog.theme) })}
                    onSave={(def) => {
                        const ok = lib.update(dialog.theme.id, def);
                        if (ok) { void chooseCustomTheme(uid, dialog.theme.id, def); setDialog(null); }
                        return ok;
                    }}
                />
            )}
            {dialog?.kind === 'export' && <CustomThemeExportDialog def={dialog.def} onClose={() => setDialog(null)} />}
            {dialog?.kind === 'import' && (
                <CustomThemeImportDialog
                    onClose={() => setDialog(null)}
                    onImport={(def, useIt) => {
                        const entry = lib.create(def);
                        if (!entry) return false;
                        if (useIt) void chooseCustomTheme(uid, entry.id, stripId(entry));
                        setDialog(null);
                        return true;
                    }}
                />
            )}
            <ClConfirm
                open={dialog?.kind === 'delete'}
                danger
                onClose={() => setDialog(null)}
                onConfirm={() => { if (dialog?.kind === 'delete') lib.remove(dialog.theme.id); setDialog(null); }}
                title={dialog?.kind === 'delete' ? `Delete “${dialog.theme.name}”?` : 'Delete theme?'}
                message={dialog?.kind === 'delete' && dialog.theme.id === activeId
                    ? 'This is the theme you are using. Cipherline goes back to its base theme. It is also removed from your other devices.'
                    : 'It is also removed from your other devices.'}
                confirmLabel="Delete"
            />
        </div>
    );
};

export default CustomThemes;
