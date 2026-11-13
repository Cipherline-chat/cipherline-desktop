import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    isActivationClick, mousedownIsActivationClick, installWindowActivationTracking,
    ACTIVATION_WINDOW_MS, __resetWindowActivationForTests,
} from './windowActivationClick';

describe('a click that only focuses the window never saves a message (owner, 2026-11-11)', () => {
    beforeEach(() => __resetWindowActivationForTests());

    it('window not focused at mousedown -> activation click', () => {
        expect(isActivationClick({ docHasFocus: false, nowMs: 5000, lastFocusAtMs: 0 })).toBe(true);
    });
    it('focus arrived just before the mousedown (Windows order) -> activation click', () => {
        expect(isActivationClick({ docHasFocus: true, nowMs: 1010, lastFocusAtMs: 1000 })).toBe(true);
    });
    it('window already focused for a while -> a normal click (saves)', () => {
        expect(isActivationClick({ docHasFocus: true, nowMs: 1000 + ACTIVATION_WINDOW_MS + 1, lastFocusAtMs: 1000 })).toBe(false);
        expect(isActivationClick({ docHasFocus: true, nowMs: 9000, lastFocusAtMs: 0 })).toBe(false);
    });
    it('tracking records the focus time from the window focus event', () => {
        let t = 2000;
        const listeners: Record<string, () => void> = {};
        installWindowActivationTracking({ addEventListener: ((ev: string, cb: () => void) => { listeners[ev] = cb; }) as Window['addEventListener'] }, () => t);
        listeners.focus();
        t = 2050;
        expect(mousedownIsActivationClick({ hasFocus: () => true }, () => t)).toBe(true);
        t = 2600;
        expect(mousedownIsActivationClick({ hasFocus: () => true }, () => t)).toBe(false);
    });
    it('wiring: the message row records it at mousedown and the click handler bails out before saving', () => {
        const cp = readFileSync(join(__dirname, '..', 'components', 'ChatPane.tsx'), 'utf8');
        expect(cp).toContain('rowMouseDownRef.current = { x: e.clientX, y: e.clientY, activation: mousedownIsActivationClick() };');
        const guard = cp.indexOf('if (activationClick) return;');
        expect(guard).toBeGreaterThan(0);
        expect(guard).toBeLessThan(cp.indexOf('retention.saveMessage(msg.id);', guard));
    });
});
