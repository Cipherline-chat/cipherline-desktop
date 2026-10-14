import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    ACTIONS, ACTION_CATEGORIES, GLOBAL_ACTIONS, ARMED_ONLY_ACTIONS, ANNOTATION_REQUEST_ACTIONS,
    buildGlobalShortcutMap, armedAnnotationActions, mergeKeybinds, comboToAccelerator, UNBOUND,
    type BindableAction, type KeybindMap,
} from './useKeybinds';
import { buildAnnotationKeybindHandlers, annotationKeyHintsFor } from './useAnnotationRequestKeybinds';
import { annotationStore as store, trackKey, clock } from '../utils/annotationStore';
import { setAnnotationKeybindContext, hasAnswerableAnnotationRequest } from '../utils/annotationRequestKeybind';
import { KNOWN_GLOBAL_SHORTCUT_ACTIONS, validateGlobalShortcutMap, isValidAccelerator } from '../../electron/global-shortcut-payload';

const APPROVE: BindableAction = 'approve-annotation-request';
const DECLINE: BindableAction = 'decline-annotation-request';
const NONE = new Set<BindableAction>();

// The defaults as the hook starts with them (mergeKeybinds of nothing saved).
const DEFAULTS = mergeKeybinds(undefined);

describe('settings wiring - actions, category and defaults', () => {
    it('declares both actions as global, armed-only, in their own category', () => {
        for (const id of [APPROVE, DECLINE]) {
            const meta = ACTIONS.find(a => a.id === id)!;
            expect(meta).toBeDefined();
            expect(meta.global).toBe(true);
            expect(meta.armedOnly).toBe(true);
            expect(meta.category).toBe('annotation');
            expect(GLOBAL_ACTIONS.has(id)).toBe(true);
            expect(ARMED_ONLY_ACTIONS.has(id)).toBe(true);
        }
        expect(ACTION_CATEGORIES.some(c => c.id === 'annotation')).toBe(true);
        // Nothing else became armed-only by accident.
        expect([...ARMED_ONLY_ACTIONS].sort()).toEqual([...ANNOTATION_REQUEST_ACTIONS].sort());
    });

    it('approve is bound by default to Ctrl+Shift+Y, decline is not bound', () => {
        expect(DEFAULTS[APPROVE]).toBe('ctrl+shift+y');
        expect(DEFAULTS[DECLINE]).toBeUndefined();
    });

    it('no two default actions share a combo', () => {
        const combos = Object.values(DEFAULTS).filter(Boolean);
        expect(new Set(combos).size).toBe(combos.length);
    });

    it('an existing user who already uses Ctrl+Shift+Y elsewhere does not get it as the approve default', () => {
        const merged = mergeKeybinds({ 'toggle-camera': 'ctrl+shift+y' });
        expect(merged['toggle-camera']).toBe('ctrl+shift+y');
        expect(merged[APPROVE]).toBeUndefined();
    });

    it('an existing user without it gets the new default', () => {
        const merged = mergeKeybinds({ 'toggle-mute': 'ctrl+shift+m' });
        expect(merged[APPROVE]).toBe('ctrl+shift+y');
    });

    it('a cleared binding (persisted as UNBOUND) survives a reload instead of the default merging back', () => {
        const saved = JSON.parse(JSON.stringify({ ...DEFAULTS, [APPROVE]: UNBOUND }));
        const merged = mergeKeybinds(saved);
        expect(merged[APPROVE]).toBe(UNBOUND);
        expect(buildGlobalShortcutMap(merged, new Set([APPROVE]))).toEqual(
            buildGlobalShortcutMap(merged, NONE),
        );
    });

    it('a user-chosen decline binding is kept', () => {
        expect(mergeKeybinds({ [DECLINE]: 'ctrl+shift+n' })[DECLINE]).toBe('ctrl+shift+n');
    });

    it('ignores unknown action ids and non-string values from storage', () => {
        const merged = mergeKeybinds({ 'format-disk': 'ctrl+shift+f', 'toggle-mute': 42 });
        expect('format-disk' in merged).toBe(false);
        expect(merged['toggle-mute']).toBe('ctrl+shift+m'); // fell back to default
    });
});

describe('pending-gated register / unregister (the IPC map)', () => {
    const accel = comboToAccelerator('ctrl+shift+y');

    it('leaves the approve combo out while nothing is pending', () => {
        const map = buildGlobalShortcutMap(DEFAULTS, armedAnnotationActions(DEFAULTS, false));
        expect(map[accel]).toBeUndefined();
        expect(Object.values(map)).not.toContain(APPROVE);
        // ...while the always-on controls are still there.
        expect(Object.values(map)).toContain('toggle-mute');
    });

    it('adds it when a request is pending, and removes it again when none remain', () => {
        const on = buildGlobalShortcutMap(DEFAULTS, armedAnnotationActions(DEFAULTS, true));
        expect(on[accel]).toBe(APPROVE);
        const off = buildGlobalShortcutMap(DEFAULTS, armedAnnotationActions(DEFAULTS, false));
        expect(off[accel]).toBeUndefined();
        // Everything else is identical either way: arming touches only its own keys.
        const rest = { ...on };
        delete rest[accel];
        expect(rest).toEqual(off);
    });

    it('arms decline only when it is bound', () => {
        expect(armedAnnotationActions(DEFAULTS, true).has(DECLINE)).toBe(false);
        const withDecline: KeybindMap = { ...DEFAULTS, [DECLINE]: 'ctrl+shift+n' };
        const armed = armedAnnotationActions(withDecline, true);
        expect(armed.has(DECLINE)).toBe(true);
        expect(buildGlobalShortcutMap(withDecline, armed)[comboToAccelerator('ctrl+shift+n')]).toBe(DECLINE);
    });

    it('never arms a combo that is the push-to-talk key', () => {
        expect(armedAnnotationActions(DEFAULTS, true, 'ctrl+shift+y').has(APPROVE)).toBe(false);
        expect(armedAnnotationActions(DEFAULTS, true, 'space').has(APPROVE)).toBe(true);
    });

    it('arms nothing at all while nothing is pending, whatever is bound', () => {
        const all: KeybindMap = { ...DEFAULTS, [DECLINE]: 'ctrl+shift+n' };
        expect(armedAnnotationActions(all, false).size).toBe(0);
    });

    it('every map it produces passes the main-process validator unchanged', () => {
        const all: KeybindMap = { ...DEFAULTS, [DECLINE]: 'ctrl+shift+n' };
        const map = buildGlobalShortcutMap(all, armedAnnotationActions(all, true));
        const v = validateGlobalShortcutMap(map);
        expect(v.ok).toBe(true);
        if (v.ok) { expect(v.map).toEqual(map); expect(v.rejected).toEqual([]); }
    });
});

describe('main-process payload validation (electron/global-shortcut-payload)', () => {
    it('its allow-list is exactly the renderer\'s global actions', () => {
        expect([...KNOWN_GLOBAL_SHORTCUT_ACTIONS].sort()).toEqual([...GLOBAL_ACTIONS].sort());
    });

    it('rejects a payload that is not a plain object', () => {
        for (const bad of [null, undefined, 'x', 42, ['CmdOrCtrl+Shift+Y'], new Map()]) {
            expect(validateGlobalShortcutMap(bad).ok).toBe(false);
        }
    });

    it('rejects an oversized payload', () => {
        const big: Record<string, string> = {};
        for (let i = 0; i < 40; i++) big[`CmdOrCtrl+Shift+${i}`] = 'toggle-mute';
        expect(validateGlobalShortcutMap(big).ok).toBe(false);
    });

    it('drops and reports an unknown action or a malformed accelerator, keeps the rest', () => {
        const v = validateGlobalShortcutMap({
            'CmdOrCtrl+Shift+M': 'toggle-mute',
            'CmdOrCtrl+Shift+P': 'run-anything',
            'CmdOrCtrl+Shift+ Y': APPROVE,
            'Super+Y': DECLINE,
        });
        expect(v.ok).toBe(true);
        if (!v.ok) return;
        expect(v.map).toEqual({ 'CmdOrCtrl+Shift+M': 'toggle-mute' });
        expect(v.rejected.sort()).toEqual([APPROVE, DECLINE, 'unknown-action'].sort());
    });

    it('accepts the accelerator vocabulary comboToAccelerator produces', () => {
        for (const c of ['ctrl+shift+y', 'ctrl+,', 'ctrl+.', 'alt+f5', 'ctrl+alt+shift+arrowup', 'escape', 'space']) {
            expect(isValidAccelerator(comboToAccelerator(c))).toBe(true);
        }
        expect(isValidAccelerator('')).toBe(false);
        expect(isValidAccelerator('CmdOrCtrl+\u0000')).toBe(false);
        expect(isValidAccelerator('x'.repeat(65))).toBe(false);
    });
});

describe('keybind handlers', () => {
    const ME = 'me-id';
    const SCREEN = trackKey(ME, 'screen_share');
    let clearCtx: () => void;
    const T = 5_000_000;

    beforeEach(() => {
        clock.now = () => T;
        store.reset();
        clearCtx = setAnnotationKeybindContext({ me: ME, isPresent: id => id === 'alice' || id === 'bob' });
    });
    afterEach(() => { clearCtx(); clock.now = () => Date.now(); vi.restoreAllMocks(); });

    it('provides no handler at all while nothing is armed (the combo is not consumed)', () => {
        const h = buildAnnotationKeybindHandlers(NONE, { isAppFocused: () => true, confirmInBackground: vi.fn() });
        expect(h).toEqual({});
    });

    it('approve handler answers the oldest request through store.grant, like a click', () => {
        clock.now = () => T - 2000; store.addRequest(SCREEN, 'bob');
        clock.now = () => T - 9000; store.addRequest(SCREEN, 'alice');
        clock.now = () => T;
        const grant = vi.spyOn(store, 'grant');
        const h = buildAnnotationKeybindHandlers(new Set([APPROVE]), { isAppFocused: () => true, confirmInBackground: vi.fn() });
        expect(h[DECLINE]).toBeUndefined();
        h[APPROVE]!();
        expect(grant).toHaveBeenCalledWith(SCREEN, 'alice');
        expect(store.getState().requests[SCREEN]).toEqual(['bob']);
    });

    it('confirms in the background only when the app is not focused and something was approved', () => {
        store.addRequest(SCREEN, 'alice');
        const confirm = vi.fn();
        const focused = buildAnnotationKeybindHandlers(new Set([APPROVE]), { isAppFocused: () => true, confirmInBackground: confirm });
        focused[APPROVE]!();
        expect(confirm).not.toHaveBeenCalled();

        store.addRequest(SCREEN, 'bob');
        const background = buildAnnotationKeybindHandlers(new Set([APPROVE]), { isAppFocused: () => false, confirmInBackground: confirm });
        background[APPROVE]!();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0][0]).toMatchObject({ track: SCREEN, id: 'bob' });

        // Nothing left: a press approves nothing and confirms nothing.
        background[APPROVE]!();
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(hasAnswerableAnnotationRequest()).toBe(false);
    });

    it('decline handler declines the oldest', () => {
        store.addRequest(SCREEN, 'alice');
        const deny = vi.spyOn(store, 'denyRequest');
        const h = buildAnnotationKeybindHandlers(new Set([DECLINE]), { isAppFocused: () => true, confirmInBackground: vi.fn() });
        h[DECLINE]!();
        expect(deny).toHaveBeenCalledWith(SCREEN, 'alice');
    });

    it('hints advertise only keys that would actually be armed', () => {
        const nav = (globalThis as { navigator?: { platform?: unknown } }).navigator;
        if (!nav || typeof nav.platform !== 'string') vi.stubGlobal('navigator', { platform: 'Win32' });
        const hints = annotationKeyHintsFor(DEFAULTS, null);
        expect(hints.approve).toMatch(/Shift\+Y$/);
        expect(hints.decline).toBeNull();
        expect(annotationKeyHintsFor(DEFAULTS, 'ctrl+shift+y').approve).toBeNull();
        vi.unstubAllGlobals();
    });
});
