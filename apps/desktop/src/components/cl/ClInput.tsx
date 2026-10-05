import React from 'react';

/* ── Raw input (guide `.inp`) ── */
export interface ClInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
    error?: boolean;
}
export const ClInput = React.forwardRef<HTMLInputElement, ClInputProps>(
    ({ className, ...rest }, ref) => (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <input ref={ref} className={['inp', className ?? ''].filter(Boolean).join(' ')} {...rest} />
        </span>
    ),
);
ClInput.displayName = 'ClInput';

/* ── Textarea variant ── */
export interface ClTextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    error?: boolean;
}
export const ClTextarea = React.forwardRef<HTMLTextAreaElement, ClTextareaProps>(
    ({ className, ...rest }, ref) => (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <textarea ref={ref} className={['inp', className ?? ''].filter(Boolean).join(' ')} {...rest} />
        </span>
    ),
);
ClTextarea.displayName = 'ClTextarea';

/* ── Field wrapper: label + control + message (guide `.fld` / `.fmsg`) ── */
interface ClFieldProps {
    label?: React.ReactNode;
    /** Error string renders red + shakes; `note` renders lume helper text. */
    error?: string;
    note?: string;
    htmlFor?: string;
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
}
export const ClField: React.FC<ClFieldProps> = ({
    label, error, note, htmlFor, children, className, style,
}) => (
    <span className="cl-kit" style={{ display: 'contents' }}>
        <div className={['fld', error ? 'errd' : '', className ?? ''].filter(Boolean).join(' ')} style={style}>
            {label && <label htmlFor={htmlFor}>{label}</label>}
            {children}
            {(error || note) && (
                <p className={['fmsg', !error && note ? 'note' : ''].filter(Boolean).join(' ')}>
                    {error || note}
                </p>
            )}
        </div>
    </span>
);

/* ── Search input: icon + input (guide `.srch`) ── */
interface ClSearchProps extends ClInputProps {
    icon: React.ReactNode;
}
export const ClSearch = React.forwardRef<HTMLInputElement, ClSearchProps>(
    ({ icon, className, ...rest }, ref) => (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <div className="srch">
                {icon}
                <input ref={ref} className={['inp', className ?? ''].filter(Boolean).join(' ')} {...rest} />
            </div>
        </span>
    ),
);
ClSearch.displayName = 'ClSearch';

export default ClInput;
