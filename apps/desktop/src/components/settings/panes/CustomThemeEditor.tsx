import React, { useDeferredValue, useId, useMemo, useState } from 'react';
import { Palette, Share2 } from 'lucide-react';
import { ClButton, ClInput, ClModal, ClSegment, ClToggle } from '../../cl';
import { DialogBody, DialogFooter, DialogHeader } from '../../dialog/DialogFrame';
import { ColourSwatchButton } from '../ui/ColourPicker';
import { contrastRatio } from '../../../theme/contrast';
import {
    CUSTOM_THEME_KNOBS, CUSTOM_THEME_NAME_MAX, KNOB_LABELS, deriveCustomTheme, formatRatio,
    knobsFromTheme, normalizeCustomTheme, type CustomThemeBase, type CustomThemeDef, type CustomThemeKnob,
} from '../../../theme/customTheme';
import { CUSTOM_THEME_PRESETS } from '../../../theme/customPresets';
import { DARK_THEME, LIGHT_THEME } from '../../../theme/themes';
import { CustomThemePreview } from './CustomThemePreview';

/**
 * Settings → Appearance → Theme → Create theme / Edit.
 *
 * Left: a name, Dark or Light underneath, a few starting points, then the
 * nine colours (Cipherline's own colour picker) and Glow. Right: a live
 * preview of the app painted from the theme as it will be saved.
 *
 * Every colour is used EXACTLY as picked — in the preview, in the saved
 * theme and in the app (owner, 2026-11-23: "let people do whatever they
 * want"). Nothing is adjusted for contrast and nothing blocks Save. The small
 * ratio next to Text / Secondary text / Text on accent is information only.
 */

interface Props {
    /** The theme being edited, or a starting point for a new one. */
    initial: CustomThemeDef;
    mode: 'create' | 'edit';
    onCancel: () => void;
    /** Save (and apply). Return false when the library refused (not ready / full). */
    onSave: (def: CustomThemeDef) => boolean;
    /** Edit mode: open the share dialog for the saved version. */
    onShare?: () => void;
}

/** Knobs whose row shows a contrast ratio — information only, never a gate. */
const RATIO_ROWS: Partial<Record<CustomThemeKnob, (c: CustomThemeDef['colors']) => { bg: string; what: string }>> = {
    text: (c) => ({ bg: c.panel, what: 'on panels' }),
    muted: (c) => ({ bg: c.panel, what: 'on panels' }),
    onAccent: (c) => ({ bg: c.accent, what: 'on accent' }),
};

export const CustomThemeEditor: React.FC<Props> = ({ initial, mode, onCancel, onSave, onShare }) => {
    const [draft, setDraft] = useState<CustomThemeDef>(initial);
    const [nameTouched, setNameTouched] = useState(mode === 'edit');
    const [saveError, setSaveError] = useState('');
    const nameId = useId();

    const result = useMemo(() => normalizeCustomTheme(draft), [draft]);
    const saved = result.ok ? result.def : null;
    const theme = useMemo(() => (saved ? deriveCustomTheme(saved) : null), [saved]);
    const previewTheme = useDeferredValue(theme);
    const canSave = !!saved;

    const setColor = (k: CustomThemeKnob, hex: string) => setDraft((d) => (d.colors[k] === hex ? d : { ...d, colors: { ...d.colors, [k]: hex } }));
    const setBase = (base: CustomThemeBase) => setDraft((d) => {
        if (d.base === base) return d;
        // A new ground for the other base; the accent and danger picks carry over.
        const seed = knobsFromTheme(base === 'light' ? LIGHT_THEME : DARK_THEME);
        return { ...d, base, glow: base === 'dark' ? d.glow : false, colors: { ...seed, accent: d.colors.accent, danger: d.colors.danger } };
    });
    const startFrom = (def: CustomThemeDef) => setDraft((d) => ({ ...def, name: nameTouched ? d.name : def.name }));

    const save = () => {
        if (!saved || !canSave) return;
        if (!onSave(saved)) setSaveError(mode === 'create' ? 'Could not save: your themes are still loading, or you already have 24.' : 'Could not save this theme.');
    };

    const hint = saveError
        ? <span className="cte-hint cte-hint--err">{saveError}</span>
        : !saved ? <span className="cte-hint cte-hint--err">These colours cannot be used.</span>
            : undefined;

    return (
        <ClModal
            open
            onClose={onCancel}
            width="min(1080px, calc(100vw - 32px))"
            label={mode === 'create' ? 'Create theme' : 'Edit theme'}
            cardClassName="dlg-card cte-card"
            closeOnOverlay={false}
        >
            <DialogHeader
                icon={<Palette size={18} />}
                title={mode === 'create' ? 'Create theme' : 'Edit theme'}
                subtitle="Pick a few colours. Cipherline works out the rest and uses yours exactly as picked."
                trailing={mode === 'edit' && onShare ? <ClButton variant="ghost" size="sm" onClick={onShare}><Share2 size={14} /> Share</ClButton> : undefined}
            />
            <DialogBody className="cte-body">
                <div className="cte-layout">
                    <div className="cte-controls">
                        <div className="cte-field">
                            <label className="cte-label" htmlFor={nameId}>Name</label>
                            <ClInput
                                id={nameId}
                                value={draft.name}
                                maxLength={CUSTOM_THEME_NAME_MAX}
                                onChange={(e) => { setNameTouched(true); setDraft((d) => ({ ...d, name: e.target.value })); }}
                                placeholder="My theme"
                            />
                        </div>
                        <div className="cte-field">
                            <span className="cte-label" id={`${nameId}-base`}>Base</span>
                            <div role="group" aria-labelledby={`${nameId}-base`}>
                                <ClSegment<CustomThemeBase>
                                    options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
                                    value={draft.base}
                                    onChange={setBase}
                                />
                            </div>
                        </div>
                        <div className="cte-field">
                            <span className="cte-label" id={`${nameId}-start`}>Start from</span>
                            <div className="cte-presets" role="group" aria-labelledby={`${nameId}-start`}>
                                {CUSTOM_THEME_PRESETS.map((p) => (
                                    <button key={p.key} type="button" className="cte-preset" onClick={() => startFrom(p.def)} title={p.blurb} data-preset={p.key}>
                                        <span className="cte-preset-sw" aria-hidden="true">
                                            <i style={{ background: p.def.colors.bg }} />
                                            <i style={{ background: p.def.colors.panel }} />
                                            <i style={{ background: p.def.colors.accent }} />
                                            <i style={{ background: p.def.colors.text }} />
                                        </span>
                                        {p.key === 'dark' ? 'Dark' : p.key === 'light' ? 'Light' : p.def.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="cte-colors" role="group" aria-label="Colours">
                            {CUSTOM_THEME_KNOBS.map((k) => {
                                const ratioOf = RATIO_ROWS[k];
                                const used = saved?.colors[k] ?? draft.colors[k];
                                const r = ratioOf && saved ? ratioOf(saved.colors) : null;
                                return (
                                    <div key={k} className="cte-row" data-knob={k}>
                                        <ColourSwatchButton
                                            value={draft.colors[k]}
                                            label={KNOB_LABELS[k].label}
                                            onChange={(hex) => setColor(k, hex)}
                                            onCommit={(hex) => setColor(k, hex)}
                                            size={30}
                                            showRecent
                                        />
                                        <div className="cte-row-text">
                                            <b>{KNOB_LABELS[k].label}</b>
                                            <span>{KNOB_LABELS[k].hint}</span>
                                        </div>
                                        <div className="cte-row-val">
                                            {r ? (
                                                <span className="cte-ratio" title={`Contrast ${r.what}`}>{formatRatio(contrastRatio(used, r.bg))}</span>
                                            ) : null}
                                            <code className="cte-hex">{used.toUpperCase()}</code>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="cte-row cte-row--toggle">
                            <div className="cte-row-text">
                                <b id={`${nameId}-glow`}>Glow</b>
                                <span>Soft accent glows on buttons and selection, like Dark.</span>
                            </div>
                            <ClToggle checked={draft.glow} onChange={(v: boolean) => setDraft((d) => ({ ...d, glow: v }))} aria-label="Glow" />
                        </div>
                        <p className="cte-fine">Verified, warning and status colours are not part of a theme: they keep their meaning and stay visible on your backgrounds.</p>
                    </div>
                    <div className="cte-preview-col">
                        <div className="cte-preview-label" aria-hidden="true">Preview</div>
                        {previewTheme ? <CustomThemePreview theme={previewTheme} label={`Preview of ${draft.name || 'your theme'}`} /> : null}
                    </div>
                </div>
            </DialogBody>
            <DialogFooter hint={hint}>
                <ClButton variant="ghost" onClick={onCancel}>Cancel</ClButton>
                <ClButton onClick={save} disabled={!canSave}>{mode === 'create' ? 'Save and use' : 'Save'}</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

export default CustomThemeEditor;
