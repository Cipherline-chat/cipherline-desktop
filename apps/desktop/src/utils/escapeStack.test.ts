// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { pushEscapeLayer, escapeLayerCount, __resetEscapeStackForTests } from './escapeStack';

const press = (key = 'Escape', init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(ev);
    return ev;
};

afterEach(() => __resetEscapeStackForTests());

describe('escapeStack', () => {
    it('only the most recently opened layer backs out', () => {
        const below = vi.fn();
        const top = vi.fn();
        pushEscapeLayer(below);
        pushEscapeLayer(top);
        press();
        expect(top).toHaveBeenCalledTimes(1);
        expect(below).not.toHaveBeenCalled();
    });

    it('closing the top layer hands the next press to the one beneath — walking back out one step at a time', () => {
        const below = vi.fn();
        pushEscapeLayer(below);
        const popTop = pushEscapeLayer(() => popTop());
        press();
        expect(below).not.toHaveBeenCalled();
        press();
        expect(below).toHaveBeenCalledTimes(1);
    });

    it('stops the event so ad-hoc listeners and the close-panel keybind do not ALSO fire', () => {
        const legacy = vi.fn();
        window.addEventListener('keydown', legacy);
        pushEscapeLayer(() => {});
        const ev = press();
        expect(legacy).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(true);
        window.removeEventListener('keydown', legacy);
    });

    it('leaves the event alone when nothing is registered', () => {
        const legacy = vi.fn();
        window.addEventListener('keydown', legacy);
        pushEscapeLayer(() => {})(); // register then immediately unregister
        const ev = press();
        expect(legacy).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(false);
        window.removeEventListener('keydown', legacy);
    });

    it('a layer that returns false passes the press down', () => {
        const below = vi.fn();
        pushEscapeLayer(below);
        pushEscapeLayer(() => false);
        press();
        expect(below).toHaveBeenCalledTimes(1);
    });

    it('ignores other keys', () => {
        const h = vi.fn();
        pushEscapeLayer(h);
        press('Enter');
        expect(h).not.toHaveBeenCalled();
    });

    it('ignores Escape while an IME composition is open', () => {
        const h = vi.fn();
        pushEscapeLayer(h);
        press('Escape', { isComposing: true });
        expect(h).not.toHaveBeenCalled();
    });

    it('removing a layer that is not on top keeps the others in order', () => {
        const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
        pushEscapeLayer(a);
        const removeB = pushEscapeLayer(b);
        const removeC = pushEscapeLayer(c);
        removeB();
        expect(escapeLayerCount()).toBe(2);
        press();
        expect(c).toHaveBeenCalledTimes(1);
        removeC();
        press();
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).not.toHaveBeenCalled();
    });

    it('unregistering twice is harmless', () => {
        const remove = pushEscapeLayer(() => {});
        remove();
        expect(() => remove()).not.toThrow();
        expect(escapeLayerCount()).toBe(0);
    });
});
