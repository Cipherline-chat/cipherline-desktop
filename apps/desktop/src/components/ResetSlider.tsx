import React from 'react';
import { ClSlider } from './cl';

/**
 * Drop-in replacement for <input type="range"> that resets to `resetValue`
 * on double-click. The reset itself lives in ClSlider (so it commits through
 * the same onChange a drag does, repaints the thumb, and shows the
 * "Double-click to reset" hint); this wrapper only maps the old
 * input-style props onto it. All other props (className, style, min, max,
 * step, …) are forwarded unchanged.
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
    min,
    max,
    step,
    disabled,
    className,
    style,
    ...rest
}) => (
    <div
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
            resetValue={resetValue}
            disabled={disabled}
        />
    </div>
);
