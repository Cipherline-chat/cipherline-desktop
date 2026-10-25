import React from 'react';
import '../../styles/dialog-frame.css';

/**
 * Dialog layout pattern — header / body / footer for a ClModal card.
 *
 * The house layout every redesigned pop-up uses (first adopter: the New
 * Message dialog, StartDMModal). Deliberately OUTSIDE `components/cl/`: the
 * website imports that folder through the `@app-cl` alias, and this is app
 * chrome, not a brand primitive.
 *
 * Usage — give the ClModal card no padding of its own and let these pieces
 * own the spacing:
 *
 *   <ClModal open onClose={close} width={480} label="Rename server"
 *            cardClassName="dlg-card">
 *     <DialogHeader icon={<Pencil size={18} />} title="Rename server"
 *                   subtitle="Members see the new name right away." />
 *     <DialogBody>…</DialogBody>
 *     <DialogFooter hint={<>…</>}>
 *       <ClButton variant="ghost" size="sm" onClick={close}>Cancel</ClButton>
 *       <ClButton size="sm" onClick={save}>Save</ClButton>
 *     </DialogFooter>
 *   </ClModal>
 *
 * Rules the pattern encodes (keep them when adopting it):
 *   - one title (Fredoka) + at most one line of subtitle that says what the
 *     dialog is FOR, not what the controls are;
 *   - the footer always holds the primary action (rightmost) and Cancel; a
 *     dialog never ends in a lone Cancel — when there is nothing to do yet,
 *     the primary is disabled and the footer hint says what enables it;
 *   - the footer hint (left) carries state: a count, a reassurance, a reason.
 *
 * Text nodes are divs/spans, never <p>/<h4>: cl-kit.css styles `.mcard p` and
 * `.mcard h4` (margins, colour) inside its @scope, which would fight this
 * layout.
 */

export type DialogTone = 'default' | 'danger' | 'warn' | 'ok';

export const DialogHeader: React.FC<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
    /** A lucide icon (≈18px); drawn in a lume-tinted tile. */
    icon?: React.ReactNode;
    /** id for the title, so a host can point aria-labelledby at it. */
    titleId?: string;
    /** Trailing slot (e.g. a close button). Rendered after the text in DOM order. */
    trailing?: React.ReactNode;
    /** Icon tile colour: `danger` for destructive confirms, `warn` for cautions. */
    tone?: DialogTone;
}> = ({ title, subtitle, icon, titleId, trailing, tone = 'default' }) => (
    <div className="dlg-head">
        {icon && <div className={`dlg-head-icon${tone === 'default' ? '' : ` dlg-head-icon--${tone}`}`} aria-hidden="true">{icon}</div>}
        <div className="dlg-head-text">
            <h2 className="dlg-title" id={titleId}>{title}</h2>
            {subtitle && <div className="dlg-subtitle">{subtitle}</div>}
        </div>
        {trailing && <div className="dlg-head-trailing">{trailing}</div>}
    </div>
);

export const DialogBody: React.FC<{ children: React.ReactNode; className?: string; flush?: boolean }> = ({ children, className, flush }) => (
    <div className={['dlg-body', flush ? 'dlg-body--flush' : '', className ?? ''].filter(Boolean).join(' ')}>{children}</div>
);

export const DialogFooter: React.FC<{
    /** Left side: state / reassurance / reason the primary is disabled. */
    hint?: React.ReactNode;
    /** Buttons, Cancel first and the primary last. */
    children: React.ReactNode;
}> = ({ hint, children }) => (
    <div className="dlg-foot">
        <div className="dlg-foot-hint" aria-live="polite">{hint}</div>
        <div className="dlg-foot-actions">{children}</div>
    </div>
);

/** Inline error strip that sits between body and footer. */
export const DialogError: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="dlg-error" role="alert">{children}</div>
);

/** Inline success strip that sits between body and footer. */
export const DialogOk: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="dlg-ok" role="status">{children}</div>
);

/** Explanatory body text. A div, not a <p>, so the kit's `.mcard p` rule stays out of it. */
export const DialogText: React.FC<{ children: React.ReactNode; id?: string }> = ({ children, id }) => (
    <div className="dlg-text" id={id}>{children}</div>
);

/** Quiet boxed note — what a destructive action will also do, or a caution. */
export const DialogCallout: React.FC<{ children: React.ReactNode; icon?: React.ReactNode; tone?: 'warn' | 'danger' | 'ok' }> = ({ children, icon, tone = 'warn' }) => (
    <div className={`dlg-callout${tone === 'warn' ? '' : ` dlg-callout--${tone}`}`}>
        {icon}
        <span>{children}</span>
    </div>
);

/** Label above a control (and optional help line below it). */
export const DialogField: React.FC<{ label?: React.ReactNode; htmlFor?: string; help?: React.ReactNode; children: React.ReactNode }> = ({ label, htmlFor, help, children }) => (
    <div className="dlg-field">
        {label && <label className="dlg-label" htmlFor={htmlFor}>{label}</label>}
        {children}
        {help && <div className="dlg-help">{help}</div>}
    </div>
);

/**
 * Initial focus for a footer button. ClModal focuses the FIRST focusable
 * element of its card a frame after opening; a dialog whose safe/primary
 * button is not first in DOM order (a non-destructive confirm wants focus on
 * the primary so Enter confirms) wraps that button in a `.dlg-focus-slot`
 * and passes the ref here. Runs after ClModal's own focus move.
 */
// eslint-disable-next-line react-refresh/only-export-components -- co-located hook; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function useInitialFocus(ref: React.RefObject<HTMLElement | null>, active: boolean): void {
    React.useEffect(() => {
        if (!active) return;
        const t = window.setTimeout(() => {
            ref.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
        }, 80);
        return () => window.clearTimeout(t);
    }, [ref, active]);
}

export default DialogHeader;
