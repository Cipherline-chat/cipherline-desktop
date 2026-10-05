import React from 'react';

const CHK = 'M2.5 7.5 L5.5 10.5 L11.5 3.5';

interface ClCheckboxProps {
    checked: boolean;
    onChange: (v: boolean) => void;
    label?: React.ReactNode;
    disabled?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

/** Checkbox — guide markup verbatim: `.clc` + `.cwrap`/`.csh`/`.cbox`/`.chk`. */
export const ClCheckbox: React.FC<ClCheckboxProps> = ({
    checked, onChange, label, disabled, className, style,
}) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !disabled && onChange(!checked)}
            className={['clc', checked ? 'on' : '', className ?? ''].filter(Boolean).join(' ')}
            style={{ ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : null), ...style }}
        >
            <span className="cwrap">
                <span className="csh" />
                <span className="cbox">
                    <svg width="13" height="13" viewBox="0 0 14 14"><path className="chk" d={CHK} /></svg>
                </span>
            </span>
            {label}
        </button>
    </span>
);

interface ClRadioProps {
    checked: boolean;
    onChange: () => void;
    label?: React.ReactNode;
    disabled?: boolean;
    className?: string;
    style?: React.CSSProperties;
}

/** Radio — guide markup verbatim: `.clr` + `.rwrap`/`.rsh`/`.rbox`/`.rdot`. */
export const ClRadio: React.FC<ClRadioProps> = ({
    checked, onChange, label, disabled, className, style,
}) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <button
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !disabled && onChange()}
            className={['clr', checked ? 'on' : '', className ?? ''].filter(Boolean).join(' ')}
            style={{ ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : null), ...style }}
        >
            <span className="rwrap">
                <span className="rsh" />
                <span className="rbox"><span className="rdot" /></span>
            </span>
            {label}
        </button>
    </span>
);

export default ClCheckbox;
