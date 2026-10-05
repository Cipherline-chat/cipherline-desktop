import React from 'react';
import { ClSlider } from './cl';

/**
 * Drop-in replacement for <input type="range"> that resets to `resetValue`
 * on double-click. All other props (className, style, min, max, step, …)
 * are forwarded unchanged.
 */
interface ResetSliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> {
    value: number;
    resetValue: number;
    onChangeValue: (v: number) => void;
}

export const ResetSlider: React.FC<ResetSliderProps> = ({
    value,
    resetValue,
    onChangeValue,
    onDoubleClick,
    min,
    max,
    step,
    disabled,
    className,
    style,
    ...rest
}) => (
    <div
        onDoubleClick={e => {
            onChangeValue(resetValue);
            onDoubleClick?.(e as any);
        }}
        style={style}
        className={className}
        {...rest}
    >
        <ClSlider
            value={value}
            onChange={onChangeValue}
            min={min !== undefined ? Number(min) : 0}
            max={max !== undefined ? Number(max) : 100}
            step={step !== undefined ? Number(step) : undefined}
            disabled={disabled}
        />
    </div>
);
