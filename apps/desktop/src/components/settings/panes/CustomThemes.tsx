import React, { useMemo, useRef, useState } from 'react';
import { Check, Copy, Import, Pencil, Plus, Share2, Trash2 } from 'lucide-react';
import { ClButton, ClConfirm } from '../../cl';
import { useAuth } from '../../../contexts/AuthContext';
import { getActiveCustomThemeId, realTheme, startThemePreview, stopThemePreview, useThemePreference, useThemePreview } from '../../../theme/engine';
import { customThemeFromBase, customThemeFromTheme, deriveCustomTheme, type CustomThemeDef, type StoredCustomTheme } from '../../../theme/customTheme';
import { useCustomThemes } from '../../../theme/customThemeLibrary';
import { CustomThemeEditor } from './CustomThemeEditor';
import { CustomThemeExportDialog, CustomThemeImportDialog } from './CustomThemeShareDialog';
import { CustomThemeMini } from './CustomThemePreview';
import '../../../styles/custom-themes.css';

/**
 * Settings → Appearance → Theme → "Your themes": the custom theme library
 * (theme/customThemeLibrary.ts) as picker tiles under the built-in ones, plus
 * Create / Import, and Edit / Duplicate / Share / Delete on each tile.
 * Picking a tile (and Save in the editor, Save and use on an import) PREVIEWS
 * it on the whole app (engine.startThemePreview): the bar's Keep makes it this
 * device's theme (activeThemeMirror.chooseCustomTheme), and without Keep the
 * real theme comes back by itself after 15 s. Colours are never contrast-
 * corrected, so this is what stops a black-on-black theme stranding anyone.
 * Editing the theme IN USE writes nothing until Keep (the library entry IS the
 * device's theme); reverting reopens the editor with the edit so nothing is
 * lost. The library itself follows the account (backups + the `themes` sync
 * slot). Free for everyone (owner decision D5).
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
    const previewing = useThemePreview();
    const activeId = pref === 'custom' ? getActiveCustomThemeId() : null;
    const [dialog, setDialog] = useState<Dialog>(null);
    const minis = useMemo(() => new Map(lib.items.map((t) => [t.id, deriveCustomTheme(stripId(t), t.id)])), [lib.items]);

    /** A library theme on the whole app, waiting for Keep on the preview bar. */
    const tryTheme = (id: string, def: CustomThemeDef) => { startThemePreview(def, { libraryId: id, source: 'settings' }); };
    const pickTheme = (t: StoredCustomTheme) => {
        // The theme in use: nothing to try (and while previewing, back to it = Revert).
        if (t.id === activeId) { if (previewing) stopThemePreview(); return; }
        tryTheme(t.id, stripId(t));
    };
    // Keyboard, as the built-in tiles above (ThemePicker): one Tab stop for the
    // tiles (the one on screen, else the first), arrow keys move focus only
    // (a pick moves focus to the preview bar's Keep); each tile's Edit /
    // Duplicate / Share / Delete stay ordinary Tab stops.
    const pickRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const shownId = previewing ? previewing.libraryId : activeId;
    const shownIndex = lib.items.findIndex((t) => t.id === shownId);
    const onPickKeyDown = (e: React.KeyboardEvent, i: number) => {
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!step || lib.items.length < 2) return;
        e.preventDefault();
        const n = lib.items.length;
        pickRefs.current[(i + step + n) % n]?.focus();
    };
    const createAndTry = (def: CustomThemeDef): boolean => {
        const entry = lib.create(def);
        if (!entry) return false;
        tryTheme(entry.id, stripId(entry));
        return true;
    };
    const saveEdit = (theme: StoredCustomTheme, def: CustomThemeDef): boolean => {
        if (theme.id === activeId) {
            // The theme in use: its library entry IS the device's theme, so nothing
            // is written until Keep. Reverting reopens the editor with the edit.
            if (!lib.ready) return false;
            startThemePreview(def, {
                libraryId: theme.id, source: 'settings', pendingEdit: true,
                onRevert: () => setDialog({ kind: 'edit', theme: { ...def, id: theme.id } }),
            });
            return true;
        }
        if (!lib.update(theme.id, def)) return false;
        tryTheme(theme.id, def);
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
                        <div key={t.id} className={`tp-opt ctl-tile${on ? ' tp-opt--on' : ''}${isPreview ? ' tp-opt--preview ctl-tile--preview' : ''}`} data-custom-theme-tile={t.id}>
                            <button
                                type="button"
                                className="ctl-pick"
                                ref={(el) => { pickRefs.current[i] = el; }}
                                tabIndex={i === Math.max(0, shownIndex) ? 0 : -1}
                                aria-pressed={t.id === shownId}
                                onClick={() => pickTheme(t)}
                                onKeyDown={(e) => onPickKeyDown(e, i)}
                                aria-label={on ? `${t.name}, in use` : `Preview ${t.name}`}
                            >
                                <span className="tp-pic">
                                    <CustomThemeMini theme={mini} />
                                    {on && <span className="tp-check"><Check size={13} strokeWidth={3} /></span>}
                                </span>
                                <span className="tp-label">{t.name}</span>
                                <span className="tp-desc">{isPreview ? 'Previewing. Press Keep to use it.' : `${t.base === 'dark' ? 'Dark' : 'Light'} base${t.glow ? ' · glow' : ''}`}</span>
                            </button>
                            <div className="ctl-actions">
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
                    onClick={() => { const real = realTheme(); setDialog({ kind: 'create', seed: real.customId ? customThemeFromBase(real.scheme) : customThemeFromTheme(real) }); }}
                    disabled={!canAdd}
                    title={addHint || undefined}
                    data-create-theme
                >
                    <span className="ctl-new-ic" aria-hidden="true"><Plus size={18} strokeWidth={2.5} /></span>
                    <span className="tp-label">Create theme</span>
                    <span className="tp-desc">{addHint || 'Pick any colours you like, with a live preview.'}</span>
                </button>
            </div>

            {dialog?.kind === 'create' && (
                <CustomThemeEditor
                    mode="create"
                    initial={dialog.seed}
                    onCancel={() => setDialog(null)}
                    onSave={(def) => { const ok = createAndTry(def); if (ok) setDialog(null); return ok; }}
                />
            )}
            {dialog?.kind === 'edit' && (
                <CustomThemeEditor
                    mode="edit"
                    initial={stripId(dialog.theme)}
                    onCancel={() => setDialog(null)}
                    onShare={() => setDialog({ kind: 'export', def: stripId(dialog.theme) })}
                    onSave={(def) => {
                        const ok = saveEdit(dialog.theme, def);
                        if (ok) setDialog(null);
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
                        if (useIt) tryTheme(entry.id, stripId(entry));
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
