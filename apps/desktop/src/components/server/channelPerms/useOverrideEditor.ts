import { useCallback, useEffect, useReducer, useRef } from 'react';
import {
    editorReducer, initialEditorState,
    type DraftMap, type EditGuard, type EditorAction, type EditorState,
} from './overrideDraft';

type Guarded = { action: EditorAction; guard: EditGuard | null };

const guardedReducer = (s: EditorState, g: Guarded) =>
    g.guard ? editorReducer(s, g.action, g.guard) : editorReducer(s, g.action);

/**
 * The draft reducer, with the CURRENT guard attached to each action at
 * dispatch time. The guard changes as data loads (roles, members, the
 * caller's permissions), so it travels with the action instead of being
 * baked into the reducer. `reset` needs no guard and is safe to call while
 * rendering (loading a saved override set).
 */
export function useOverrideEditor(guard: EditGuard): {
    state: EditorState;
    dispatch: (a: EditorAction) => void;
    reset: (draft: DraftMap) => void;
} {
    const guardRef = useRef(guard);
    useEffect(() => { guardRef.current = guard; }, [guard]);
    const [state, raw] = useReducer(guardedReducer, undefined, () => initialEditorState());
    const dispatch = useCallback((action: EditorAction) => raw({ action, guard: guardRef.current }), []);
    const reset = useCallback((draft: DraftMap) => raw({ action: { type: 'reset', draft }, guard: null }), []);
    return { state, dispatch, reset };
}
