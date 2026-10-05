/**
 * ConfirmDialog — styled dark-theme confirmation modal.
 *
 * Drop-in replacement for `window.confirm()`. Matches the app's dark dialog
 * aesthetic (same shell as ChannelSettingsDialog / CategoryFormDialog).
 *
 * Usage:
 *   const [pending, setPending] = useState<ConfirmOptions | null>(null);
 *
 *   // Trigger from a button / context-menu item:
 *   setPending({
 *     title: 'Delete "general"?',
 *     message: 'This channel will be permanently removed.',
 *     confirmLabel: 'Delete',
 *     onConfirm: () => deleteChannel(id),
 *   });
 *
 *   // Render once in the component tree:
 *   {pending && (
 *     <ConfirmDialog
 *       {...pending}
 *       onCancel={() => setPending(null)}
 *       onConfirm={() => { pending.onConfirm(); setPending(null); }}
 *     />
 *   )}
 */

import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';

/** Same fade+zoom-out timing every other modal in the app uses via
 *  useModalExit — that hook is wired to a single onClose callback, but this
 *  dialog needs the exit animation to precede EITHER onCancel or onConfirm
 *  (whichever the user picked), so it manages its own closing state. */
const EXIT_MS = 160;

export interface ConfirmOptions {
    title: string;
    /**
     * Body text under the title. Omit it for a bare yes/no: the dialog then
     * switches to a compact, centred layout (title above, buttons centred
     * below) — a question with nothing to read reads better centred than
     * hanging off an icon on the left.
     */
    message?: string;
    /** Button label — defaults to "Delete" */
    confirmLabel?: string;
    /**
     * Quiet secondary line under the button row — for teaching a shortcut that
     * skips this dialog next time ("Hold Shift…"). Deliberately below the
     * actions and dimmer than `message`: it is a thing to notice on the second
     * or third visit, not another sentence to read before deciding. Omit it and
     * nothing renders.
     */
    hint?: string;
    /** Callback invoked when the user confirms. */
    onConfirm: () => void;
}

interface Props extends ConfirmOptions {
    onCancel: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({
    title,
    message,
    confirmLabel = 'Delete',
    hint,
    onConfirm,
    onCancel,
}) => {
    const cancelWrapRef = useRef<HTMLSpanElement>(null);
    const [closing, setClosing] = useState(false);
    const pendingActionRef = useRef<(() => void) | null>(null);

    // Previously this dialog had an entrance animation but NO exit one — Cancel,
    // Confirm, Escape, and backdrop-click all unmounted it instantly, which read
    // as an abrupt hard cut against the rest of the app's modals (all of which
    // fade+zoom out via useModalExit). Play the same exit here before actually
    // invoking whichever callback the user picked.
    const startClose = (action: () => void) => {
        if (closing) return;
        pendingActionRef.current = action;
        setClosing(true);
        window.setTimeout(() => { pendingActionRef.current?.(); }, EXIT_MS);
    };

    // P2-REND-4: Focus the Cancel button on open so Enter doesn't accidentally
    // confirm a destructive action. The confirm button is reachable by Tab.
    useEffect(() => {
        cancelWrapRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    }, []);

    // Escape = Cancel. Through the shared stack so that, opened on top of an
    // editor or a menu, this dialog is the only thing the press closes.
    useEscape(() => startClose(onCancel));

    const actions = (
        <>
            <span ref={cancelWrapRef}>
                <ClButton
                    variant="ghost"
                    onClick={() => startClose(onCancel)}
                >
                    Cancel
                </ClButton>
            </span>
            <ClButton
                variant="danger"
                onClick={() => startClose(onConfirm)}
            >
                {confirmLabel}
            </ClButton>
        </>
    );

    return (
        <div
            className={`fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm ${
                closing ? 'fade-exit' : 'fade-enter'
            }`}
            onClick={(e) => { if (e.target === e.currentTarget) startClose(onCancel); }}
        >
            <div
                // max-w-xs left "Discard changes" + "Cancel" within half a
                // pixel of the button row's available width — comfortably
                // fine on one machine's font metrics, wrapping on another's.
                // max-w-sm gives every confirmLabel in use real margin.
                className={`bg-cl-deep border border-white/[0.08] rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 ${
                    closing ? 'fade-pop-exit' : ''
                }`}
                // House "pop" idiom (cl-kit.css: --spr spring easing + the pop
                // keyframe) instead of the flat animate-in/zoom-in-95 shim —
                // that shim has no overshoot, which read as a non-event.
                style={closing ? undefined : { animation: 'pop 320ms var(--spr) both' }}
            >
                {message ? (
                    <>
                        {/* Icon + title */}
                        <div className="flex items-start gap-3 mb-3">
                            <div className="w-9 h-9 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shrink-0 mt-0.5">
                                <AlertTriangle size={16} />
                            </div>
                            <div className="min-w-0">
                                <h2 className="font-bold text-[15px] text-white leading-tight">{title}</h2>
                                <p className="text-[13px] text-white/50 mt-1 leading-snug">{message}</p>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center justify-end gap-2 mt-5">
                            {actions}
                        </div>
                    </>
                ) : (
                    <>
                        <h2 className="font-bold text-[15px] text-white leading-tight text-center">{title}</h2>
                        <div className="flex items-center justify-center gap-2 mt-5">
                            {actions}
                        </div>
                    </>
                )}

                {hint && (
                    <p className={`text-[11.5px] text-white/30 mt-3 leading-snug ${message ? 'text-right' : 'text-center'}`}>
                        {hint}
                    </p>
                )}
            </div>
        </div>
    );
};

export default ConfirmDialog;
