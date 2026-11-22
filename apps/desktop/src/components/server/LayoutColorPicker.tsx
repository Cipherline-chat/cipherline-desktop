/**
 * LayoutColorPicker — the divider colour row: the "glow in the deep" preset
 * swatches (Glow gold first = the default), the app's custom colour picker,
 * and "Default" to go back to gold.
 *
 * ONE component for both things that carry a divider look: a divider
 * (DividerFormDialog) and a DIVIDER CATEGORY's header (CategoryFormDialog).
 * Same palette, same strict `#rrggbb` rule (normalizeDividerColor) the server
 * enforces for both. Ordinary categories have no colour at all (owner,
 * 2026-11-17), so nothing else uses it.
 */

import React from 'react';
import { RotateCcw } from 'lucide-react';
import { DIVIDER_COLOR_PRESETS, DIVIDER_DEFAULT_COLOR, normalizeDividerColor } from '@cipherline/shared';
import { ColourSwatchButton } from '../settings/ui/ColourPicker';

interface Props {
    /** The stored colour (`#rrggbb`), or null = the default (Glow gold). */
    value: string | null;
    onChange: (color: string | null) => void;
    /** Accessible name of the custom picker, e.g. "Divider colour". */
    label: string;
}

export const LayoutColorPicker: React.FC<Props> = ({ value, onChange, label }) => {
    const custom = !!value && !DIVIDER_COLOR_PRESETS.includes(value);
    return (
        <div className="flex items-center gap-2 flex-wrap">
            {DIVIDER_COLOR_PRESETS.map(hex => {
                const current = (value ?? DIVIDER_DEFAULT_COLOR) === hex;
                return (
                    <button
                        key={hex}
                        type="button"
                        className="w-6 h-6 rounded-full border-2 border-solid focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume"
                        style={{ background: hex, borderColor: current ? 'var(--cl-text)' : 'transparent' }}
                        aria-label={`Colour ${hex}${hex === DIVIDER_DEFAULT_COLOR ? ' (default)' : ''}`}
                        aria-pressed={current}
                        onClick={() => onChange(hex === DIVIDER_DEFAULT_COLOR ? null : hex)}
                    />
                );
            })}
            <ColourSwatchButton
                value={value ?? DIVIDER_DEFAULT_COLOR}
                label={label}
                presets={DIVIDER_COLOR_PRESETS}
                size={24}
                triggerLabel={`Pick a custom ${label.toLowerCase()}`}
                onChange={(hex) => onChange(normalizeDividerColor(hex))}
                onCommit={(hex) => onChange(normalizeDividerColor(hex))}
                className={custom ? undefined : 'cp-trigger--dashed'}
            >
                {custom ? undefined : <span aria-hidden="true">+</span>}
            </ColourSwatchButton>
            {value && (
                <button type="button" className="text-[11px] text-cl-faint hover:text-cl-lume-text inline-flex items-center gap-1" onClick={() => onChange(null)}>
                    <RotateCcw size={11} /> Default
                </button>
            )}
        </div>
    );
};
