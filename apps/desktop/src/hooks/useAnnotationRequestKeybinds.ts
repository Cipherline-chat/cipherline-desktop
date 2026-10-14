/**
 * Dashboard's half of the drawing-request keybinds (the dock's half is
 * utils/annotationRequestKeybind.ts - read that first).
 *
 *  - `buildAnnotationKeybindHandlers` hands useGlobalKeybindListener a handler
 *    ONLY for an action that is currently armed. With no handler, both
 *    listener tiers ignore the action entirely: the local keydown tier returns
 *    before preventDefault, so outside a pending request the combo reaches the
 *    focused app (or the text box) as if Cipherline did not exist. Arming is
 *    also what decides whether the OS-level shortcut is registered at all
 *    (useKeybinds' buildGlobalShortcutMap), so the two can never disagree.
 *
 *  - A handler re-checks at press time: it approves (or declines) the oldest
 *    request still on screen in the dock, through the very function the dock's
 *    button calls, or does nothing.
 *
 *  - `useAnnotationKeyHintPublisher` publishes the bindings for the dock's
 *    "Allow (Ctrl+Shift+Y)" hint - only for an action that WOULD be armed, so
 *    the dock never advertises a key that is not going to work (unbound, or
 *    the push-to-talk key, which is never armed).
 */
import { useEffect } from 'react';
import {
    approveOldestAnnotationRequest, declineOldestAnnotationRequest, setAnnotationKeyHints,
    type AnswerableRequest,
} from '../utils/annotationRequestKeybind';
import { armedAnnotationActions, formatCombo, type BindableAction, type KeybindMap } from './useKeybinds';
import type { KeybindActionHandlers } from './useGlobalKeybindListener';

export interface AnnotationKeybindDeps {
    /** Is the Cipherline window focused right now? */
    isAppFocused: () => boolean;
    /** Subtle confirmation for an approval made while NOT focused. */
    confirmInBackground: (approved: AnswerableRequest) => void;
    /** Overridable for tests; default the real implementations. */
    approve?: () => AnswerableRequest | null;
    decline?: () => AnswerableRequest | null;
}

export function buildAnnotationKeybindHandlers(
    armed: ReadonlySet<BindableAction>,
    deps: AnnotationKeybindDeps,
): Pick<KeybindActionHandlers, 'approve-annotation-request' | 'decline-annotation-request'> {
    const out: Pick<KeybindActionHandlers, 'approve-annotation-request' | 'decline-annotation-request'> = {};
    if (armed.has('approve-annotation-request')) {
        out['approve-annotation-request'] = () => {
            const approved = (deps.approve ?? approveOldestAnnotationRequest)();
            if (approved && !deps.isAppFocused()) deps.confirmInBackground(approved);
        };
    }
    if (armed.has('decline-annotation-request')) {
        out['decline-annotation-request'] = () => { (deps.decline ?? declineOldestAnnotationRequest)(); };
    }
    return out;
}

/** "Ctrl + Shift + Y" -> "Ctrl+Shift+Y", for a hint inside a button. */
export const compactCombo = (combo: string): string => formatCombo(combo).split(' + ').join('+');

export function annotationKeyHintsFor(binds: KeybindMap, pushToTalkKey: string | null) {
    const wouldArm = armedAnnotationActions(binds, true, pushToTalkKey);
    const hint = (a: BindableAction) => (wouldArm.has(a) && binds[a] ? compactCombo(binds[a]!) : null);
    return { approve: hint('approve-annotation-request'), decline: hint('decline-annotation-request') };
}

export function useAnnotationKeyHintPublisher(binds: KeybindMap, pushToTalkKey: string | null): void {
    const approve = binds['approve-annotation-request'];
    const decline = binds['decline-annotation-request'];
    useEffect(() => {
        setAnnotationKeyHints(annotationKeyHintsFor(
            { 'approve-annotation-request': approve, 'decline-annotation-request': decline },
            pushToTalkKey,
        ));
    }, [approve, decline, pushToTalkKey]);
}
