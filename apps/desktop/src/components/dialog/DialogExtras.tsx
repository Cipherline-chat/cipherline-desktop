import React from 'react';
import '../../styles/dialog-extras.css';

/**
 * Form-dialog pieces that sit alongside DialogFrame (header / body / footer).
 * See styles/dialog-extras.css for what each class does and why it exists.
 *
 * Kept in its own file so the frame itself stays the small, stable reference
 * and so dialogs with fields share spacing instead of hand-rolling inline
 * styles. Text nodes are divs/spans, never <p>/<h4> (the kit styles those
 * inside `.mcard`).
 */

/**
 * A <form> between the card and its header/body/footer. It keeps the card's
 * flex column intact (`.dlg-form`), and makes Enter in any field submit the
 * primary action — the same keyboard contract as a native form.
 */
export const DialogForm: React.FC<{
    onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
    children: React.ReactNode;
    className?: string;
    'data-testid'?: string;
}> = ({ onSubmit, children, className, ...rest }) => (
    <form
        className={['dlg-form', className ?? ''].filter(Boolean).join(' ')}
        noValidate
        onSubmit={(e) => { e.preventDefault(); onSubmit(e); }}
        {...rest}
    >
        {children}
    </form>
);

/** Vertical rhythm for a body's children. */
export const DialogStack: React.FC<{ children: React.ReactNode; tight?: boolean; center?: boolean; className?: string }> = ({ children, tight, center, className }) => (
    <div className={['dlg-stack', tight ? 'dlg-stack--tight' : '', center ? 'dlg-stack--center' : '', className ?? ''].filter(Boolean).join(' ')}>{children}</div>
);

/** Label + control + helper / inline error. `error` replaces `help` while set. */
export const DialogField: React.FC<{
    label: React.ReactNode;
    htmlFor?: string;
    /** Right-aligned small text on the label row (a counter, "Optional"). */
    aside?: React.ReactNode;
    help?: React.ReactNode;
    helpId?: string;
    error?: React.ReactNode;
    errorId?: string;
    children: React.ReactNode;
}> = ({ label, htmlFor, aside, help, helpId, error, errorId, children }) => (
    <div className="dlg-field">
        <label className="dlg-label" htmlFor={htmlFor}>
            <span>{label}</span>
            {aside != null && <small>{aside}</small>}
        </label>
        {children}
        {error
            ? <div className="dlg-field-error" id={errorId} role="alert">{error}</div>
            : help ? <div className="dlg-help" id={helpId}>{help}</div> : null}
    </div>
);

export type DialogNoteTone = 'info' | 'warn' | 'danger' | 'ok';

/** Callout. `icon` is a lucide icon (≈15px). */
export const DialogNote: React.FC<{
    tone?: DialogNoteTone;
    icon?: React.ReactNode;
    children: React.ReactNode;
    role?: 'note' | 'alert' | 'status';
    id?: string;
}> = ({ tone = 'info', icon, children, role, id }) => (
    <div id={id} className={['dlg-note', tone === 'info' ? '' : `dlg-note--${tone}`].filter(Boolean).join(' ')} role={role}>
        {icon}
        <div>{children}</div>
    </div>
);

/** Quiet text action inside a body. Always `type="button"` — never submits the form. */
export const DialogLinkButton: React.FC<{
    onClick: () => void;
    disabled?: boolean;
    children: React.ReactNode;
    autoFocus?: boolean;
}> = ({ onClick, disabled, children, autoFocus }) => (
    <button type="button" className="dlg-linkbtn" onClick={onClick} disabled={disabled} autoFocus={autoFocus}>{children}</button>
);

/** Plain paragraph of body copy (a div: see the file note on <p>). */
export const DialogCopy: React.FC<{ children: React.ReactNode; id?: string }> = ({ children, id }) => (
    <div className="dlg-copy" id={id}>{children}</div>
);

/** "Step 2 of 4" dots for a footer hint. */
export const DialogSteps: React.FC<{ index: number; count: number; label?: string }> = ({ index, count, label }) => (
    <>
        <span className="dlg-steps" aria-hidden="true">
            {Array.from({ length: count }, (_, i) => <i key={i} className={i <= index ? 'on' : ''} />)}
        </span>
        <span>{label ?? `Step ${index + 1} of ${count}`}</span>
    </>
);
