import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog, type ConfirmOptions } from '../components/primitives/ConfirmDialog';

/**
 * Shell-side "you have unsaved changes" guard for Settings / Server Settings.
 *
 * Panes that hold a draft (profile card, server overview, role permissions,
 * channel overrides) report their dirty flag up via `setDirty`; the shell
 * routes every way out — Escape, click on the veil, the X button, and
 * switching to another pane (which unmounts the draft) — through `guard`,
 * which either runs the action immediately or shows a confirm first.
 *
 * Render `dialog` once inside the shell (it portals to document.body so a
 * transformed / windowed shell can't clip it). While it is open, the shell's
 * own Escape listener should bail (`confirmOpen`) so the dialog owns the key.
 */
export function useUnsavedChangesGuard(what = 'Your changes') {
    const [dirty, setDirty] = useState(false);
    const [pending, setPending] = useState<ConfirmOptions | null>(null);

    const guard = useCallback((action: () => void) => {
        if (!dirty) { action(); return; }
        setPending({
            title: 'Unsaved changes',
            message: `${what} haven't been saved yet. Leave anyway and lose them?`,
            confirmLabel: 'Discard changes',
            onConfirm: () => { setDirty(false); action(); },
        });
    }, [dirty, what]);

    const dialog = pending ? createPortal(
        <ConfirmDialog
            {...pending}
            onConfirm={() => { pending.onConfirm(); setPending(null); }}
            onCancel={() => setPending(null)}
        />,
        document.body,
    ) : null;

    return { dirty, setDirty, guard, confirmOpen: pending !== null, dialog };
}

/**
 * Pane-side half: pushes a computed dirty flag to the parent whenever it
 * changes, and clears it on unmount so a pane that goes away (after a
 * confirmed discard, or a save that closes it) never leaves a stale flag.
 */
export function useReportDirty(dirty: boolean, onDirtyChange?: (dirty: boolean) => void) {
    const cb = useRef(onDirtyChange);
    useEffect(() => { cb.current = onDirtyChange; });
    useEffect(() => { cb.current?.(dirty); }, [dirty]);
    useEffect(() => () => { cb.current?.(false); }, []);
}
