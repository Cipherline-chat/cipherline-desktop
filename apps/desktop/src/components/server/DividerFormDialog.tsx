/**
 * DividerFormDialog — create or edit a channel-list divider.
 *
 * Pick one of the four styles (tiles with live previews), then - for the
 * label styles - an optional label and a colour
 * (the app's own colour picker, seeded with the "glow in the deep" palette;
 * Glow gold is the default). A preview strip shows the result in the
 * sidebar's own surface.
 *
 * Dumb on purpose: Submit hands the values to the list, which applies them
 * optimistically, calls the API and rolls back with a toast if refused (the
 * same pattern as channel create/edit). The checks here are the shared
 * channel-layout rules, identical to the server's.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Minus, X, Trash2, Save, Plus } from 'lucide-react';
import {
    DIVIDER_STYLES, isLabelDividerStyle, DIVIDER_LABEL_MAX,
    dividerLabelError, DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME, normalizeDividerColor, type DividerStyle,
} from '@cipherline/shared';
import { ClButton, ClModal, ClInput } from '../cl';
import { useModalExit } from '../../hooks/useModalExit';
import { LayoutColorPicker } from './LayoutColorPicker';
import { ChannelDividerVisual } from './ChannelDividerRow';
import type { DividerInfo } from '../../hooks/useServers';

export interface DividerValues {
    style: DividerStyle;
    label: string | null;
    color: string | null;
}

interface Props {
    divider?: DividerInfo | null;
    /** Where a new divider goes, for the subtitle ("in Crafting"). */
    containerName?: string | null;
    onClose: () => void;
    onSubmit: (values: DividerValues) => void;
    onDelete?: () => void;
}

const STYLE_NAMES: Record<DividerStyle, string> = {
    label: 'Centred', header: 'Header', pill: 'Pill', text: 'Text', line: 'Line', dots: 'Dots', space: 'Blank space',
};
const sectionLabel = 'text-[10.5px] font-mono font-semibold uppercase tracking-widest text-cl-faint mb-1.5';
/** Drop characters the server would refuse, as the user types. */

export const DividerFormDialog: React.FC<Props> = ({ divider, containerName, onClose, onSubmit, onDelete }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const isEdit = !!divider;
    const [style, setStyle] = useState<DividerStyle>(divider?.style ?? 'label');
    const [label, setLabel] = useState(divider?.label ?? '');
    const [color, setColor] = useState<string | null>(normalizeDividerColor(divider?.color));
    const labelRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const r = requestAnimationFrame(() => { if (isLabelDividerStyle(style)) labelRef.current?.focus(); });
        return () => cancelAnimationFrame(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once on open
    }, []);

    const trimmed = label.trim();
    const labelError = trimmed === '' ? null : dividerLabelError(trimmed);
    const labelOk = labelError === null;
    const hasLabel = isLabelDividerStyle(style);
    const values: DividerValues = hasLabel
        ? { style, label: trimmed || null, color }
        : { style, label: null, color: null };
    const dirty = !isEdit || JSON.stringify(values) !== JSON.stringify({
        style: divider!.style, label: divider!.label, color: normalizeDividerColor(divider!.color),
    });
    const canSubmit = labelOk && dirty;

    const submit = () => {
        if (!canSubmit) return;
        onSubmit(values);
        handleClose();
    };

    return (
        <ClModal open={!closing} onClose={handleClose} width={480} label={isEdit ? 'Edit divider' : 'Add divider'} cardClassName="mcard--panel">
            <div
                className="flex flex-col min-h-0 flex-1"
                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } }}
            >
                <div className="flex items-center gap-3 px-5 py-3 border-b border-cl-border/40 shrink-0">
                    <div className="w-8 h-8 rounded-xl bg-cl-glow/15 flex items-center justify-center text-cl-glow-text border border-solid border-cl-glow/25 shrink-0">
                        <Minus size={15} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-[9px] font-mono font-semibold uppercase text-cl-faint truncate m-0" style={{ letterSpacing: '1.3px' }}>
                            {isEdit ? 'Divider' : 'New Divider'}{containerName ? ` · in ${containerName}` : ''}
                        </div>
                        <h2 className="font-display font-semibold text-[16px] text-cl-text truncate m-0">
                            {isEdit ? 'Edit divider' : 'Add a divider'}
                        </h2>
                    </div>
                    <ClButton icon onClick={handleClose} variant="ghost" tooltip="Close">
                        <X size={16} />
                    </ClButton>
                </div>

                <div className="px-5 py-4 space-y-4 overflow-y-auto custom-scrollbar" style={{ background: 'var(--cl-deep)' }}>
                    <div>
                        <div className={sectionLabel} id="divider-style-label">Style</div>
                        <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-labelledby="divider-style-label">
                            {DIVIDER_STYLES.map(st => {
                                const selected = st === style;
                                return (
                                    <button
                                        key={st}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        tabIndex={selected ? 0 : -1}
                                        onClick={() => setStyle(st)}
                                        onKeyDown={e => {
                                            const i = DIVIDER_STYLES.indexOf(style);
                                            const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
                                            if (!step) return;
                                            e.preventDefault();
                                            const next = DIVIDER_STYLES[(i + step + DIVIDER_STYLES.length) % DIVIDER_STYLES.length];
                                            setStyle(next);
                                            (e.currentTarget.parentElement?.querySelector(`[data-style="${next}"]`) as HTMLElement | null)?.focus();
                                        }}
                                        data-style={st}
                                        className={`text-left rounded-[9px] border border-solid px-2 pt-2.5 pb-2 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume ${
                                            selected ? 'border-cl-lume bg-cl-abyss' : 'border-cl-border bg-cl-abyss hover:border-cl-lume/40'
                                        }`}
                                        style={selected ? { boxShadow: '0 0 0 1px var(--cl-lume) inset' } : undefined}
                                    >
                                        <div className="min-h-[24px] flex flex-col justify-center pointer-events-none">
                                            <ChannelDividerVisual
                                                compact
                                                divider={isLabelDividerStyle(st)
                                                    // A short fixed word keeps the compact tile readable;
                                                    // the real label is in the Preview below.
                                                    ? { style: st, label: 'Label', color }
                                                    : { style: st, label: null, color: null }}
                                            />
                                        </div>
                                        <div className="text-[12px] font-bold text-cl-faint mt-1.5 pl-1">{STYLE_NAMES[st]}</div>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {hasLabel && (
                        <>
                            <div>
                                <div className={sectionLabel}>Label</div>
                                <div className="flex items-center gap-2">
                                    <ClInput
                                        ref={labelRef}
                                        value={label}
                                        onChange={e => setLabel(e.target.value)}
                                        placeholder="Community (optional)"
                                        maxLength={DIVIDER_LABEL_MAX * DISPLAY_NAME_MAX_UNITS_PER_GRAPHEME}
                                        aria-label="Divider label"
                                        aria-invalid={!labelOk}
                                        onKeyDown={(e: React.KeyboardEvent) => {
                                            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); submit(); }
                                        }}
                                    />
                                </div>
                                {!labelOk && <div className="text-[11px] text-cl-flash-text mt-1" role="alert">{labelError}</div>}
                                <div className="text-[11px] text-cl-faint mt-1">Shown exactly as typed. Paste in any symbols or emoji you like.</div>
                            </div>
                            <div>
                                <div className={sectionLabel}>Colour</div>
                                <LayoutColorPicker value={color} onChange={setColor} label="Divider colour" />
                            </div>
                        </>
                    )}

                    <div>
                        <div className={sectionLabel}>Preview</div>
                        <div className="rounded-[10px] border border-solid border-cl-border px-2 py-1.5" style={{ background: 'var(--cl-deep)' }} aria-hidden="true">
                            <div className="px-2 py-1 text-[13px] text-cl-muted font-semibold"># announcements</div>
                            <ChannelDividerVisual divider={values} />
                            <div className="px-2 py-1 text-[13px] text-cl-muted font-semibold"># general</div>
                        </div>
                        <div className="text-[11px] text-cl-faint mt-2">
                            Dividers are only decoration: nobody can post in one, and members only see it when they can see a channel next to it.
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-cl-border/40 shrink-0">
                    <div>
                        {isEdit && onDelete && (
                            <ClButton size="sm" variant="danger" onClick={() => { onDelete(); handleClose(); }}>
                                <Trash2 size={12} /> Delete
                            </ClButton>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <ClButton variant="ghost" onClick={handleClose}>Cancel</ClButton>
                        <ClButton onClick={submit} disabled={!canSubmit} tooltip={isEdit ? 'Save (Ctrl+Enter)' : 'Add (Enter)'}>
                            {isEdit ? <Save size={14} /> : <Plus size={14} />}
                            {isEdit ? 'Save' : 'Add divider'}
                        </ClButton>
                    </div>
                </div>
            </div>
        </ClModal>
    );
};

export default DividerFormDialog;
