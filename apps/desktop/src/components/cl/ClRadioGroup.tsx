import React from 'react';
import { ClRadio } from './ClCheckbox';

export interface ClRadioOption<T extends string> {
    value: T;
    label: React.ReactNode;
    disabled?: boolean;
}

interface ClRadioGroupProps<T extends string> {
    options: ClRadioOption<T>[];
    value: T;
    onChange: (v: T) => void;
    /** Layout direction of the group. */
    direction?: 'column' | 'row';
    gap?: number;
    className?: string;
    style?: React.CSSProperties;
}

/** A set of brand radios (guide `[data-rgroup]`) with single-select semantics. */
export function ClRadioGroup<T extends string>({
    options, value, onChange, direction = 'column', gap = 12, className, style,
}: ClRadioGroupProps<T>) {
    return (
        <div
            role="radiogroup"
            className={className}
            style={{ display: 'flex', flexDirection: direction, gap, ...style }}
        >
            {options.map((o) => (
                <ClRadio
                    key={o.value}
                    checked={value === o.value}
                    disabled={o.disabled}
                    onChange={() => onChange(o.value)}
                    label={o.label}
                />
            ))}
        </div>
    );
}

export default ClRadioGroup;
