// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * HomePinsGrid rendered for real (dnd-kit included): keyboard reorder +
 * announcement, focus retention, click-vs-drag threshold, Esc cancel, and a
 * pointer drop across a wrapping row. The ordering maths has its own suite
 * (utils/homePins.reorder.test.ts); this pins the wiring.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
    (window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
});

const { HomePinsGrid } = await import('./HomePinsGrid');
const { pinKey } = await import('../utils/homePins');
type PinDnd = import('./HomePinsGrid').PinDnd;
type PinnedHomeItem = import('../utils/homePins').PinnedHomeItem;

type TestPin = { item: PinnedHomeItem; name: string };
const PINS: TestPin[] = [
    { item: { type: 'conversation', id: 'a' }, name: 'Mira' },
    { item: { type: 'channel', channelId: 'b', serverId: 'S1' }, name: 'general' },
    { item: { type: 'server', serverId: 'c' }, name: 'Neon Guild' },
    { item: { type: 'conversation', id: 'd' }, name: 'Weekend crew' },
    { item: { type: 'server', serverId: 'e' }, name: 'Design Team' },
];

// Fake layout: a 3-wide wrapping grid of 100x40 cards with 10px gaps, by DOM
// order among [data-pin-key] siblings. jsdom has no layout, and both the
// keyboard (offsetTop → columns) and dnd-kit (getBoundingClientRect) read it.
const COLS = 3, W = 100, H = 40, GAP = 10;
function slotOf(el: Element): number {
    const parent = el.parentElement;
    if (!parent) return -1;
    return Array.from(parent.querySelectorAll(':scope > [data-pin-key]')).indexOf(el);
}
const origRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const i = this.dataset.pinKey ? slotOf(this) : -1;
        if (i < 0) return origRect.call(this);
        const x = (i % COLS) * (W + GAP), y = Math.floor(i / COLS) * (H + GAP);
        return { x, y, left: x, top: y, width: W, height: H, right: x + W, bottom: y + H, toJSON() { return this; } } as DOMRect;
    };
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
        configurable: true,
        get(this: HTMLElement) {
            const i = this.dataset.pinKey ? slotOf(this) : -1;
            return i < 0 ? 0 : Math.floor(i / COLS) * (H + GAP);
        },
    });
});
afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = origRect;
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetTop;
});

/** Mirrors PinCard's use of the dnd props (HomePanel.tsx) — a source check
 *  below keeps the two in step. */
const Card: React.FC<{ pin: TestPin; dnd: PinDnd; onOpen: (name: string) => void }> = ({ pin, dnd, onOpen }) =>
    React.createElement('div', {
        role: 'button',
        tabIndex: dnd.state === 'overlay' ? -1 : 0,
        ref: dnd.setNodeRef,
        'data-pin-key': dnd.state === 'overlay' ? undefined : dnd.pinKey,
        'data-dnd': dnd.state,
        'aria-describedby': dnd.describedBy,
        ...dnd.listeners,
        style: dnd.style,
        onClick: () => onOpen(pin.name),
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if (dnd.onReorderKeyDown?.(e)) return;
            if (e.key === 'Enter') onOpen(pin.name);
        },
    }, pin.name);

let host: HTMLDivElement;
let root: Root;
let order: TestPin[];
let opened: string[];
let moves: [string, number, string[]][];

function Harness({ reorder }: { reorder: boolean }) {
    const [pins, setPins] = React.useState(order);
    const onMove = (key: string, to: number, visible: string[]) => {
        moves.push([key, to, visible]);
        setPins(prev => {
            const next = prev.slice();
            const from = next.findIndex(p => pinKey(p.item) === key);
            next.splice(to, 0, next.splice(from, 1)[0]);
            return next;
        });
    };
    return React.createElement(HomePinsGrid<TestPin>, {
        pins,
        nameOf: (p: TestPin) => p.name,
        onMove: reorder ? onMove : undefined,
        renderPin: (p: TestPin, dnd: PinDnd) => React.createElement(Card, { pin: p, dnd, onOpen: n => opened.push(n) }),
    });
}

function mount(reorder = true) {
    act(() => { root.render(React.createElement(Harness, { reorder })); });
}
const cards = () => Array.from(host.querySelectorAll<HTMLElement>('.hd-cards > [data-pin-key]'));
const names = () => cards().map(c => c.textContent);
const card = (name: string) => cards().find(c => c.textContent === name)!;
const live = () => Array.from(host.querySelectorAll('[aria-live="polite"]')).map(n => n.textContent).join('|');

function key(el: HTMLElement, k: string, mods: Partial<KeyboardEventInit> = {}) {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods })); });
}
function pointer(type: string, target: EventTarget, x: number, y: number) {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(e, 'isPrimary', { value: true });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    act(() => { target.dispatchEvent(e); });
}
function click(el: HTMLElement) {
    act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
}

beforeEach(() => {
    order = PINS.slice();
    opened = [];
    moves = [];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});

describe('keyboard reorder', () => {
    it('Alt+ArrowRight moves the focused pin one place and announces it', () => {
        mount();
        card('Mira').focus();
        key(card('Mira'), 'ArrowRight', { altKey: true });
        expect(names()).toEqual(['general', 'Mira', 'Neon Guild', 'Weekend crew', 'Design Team']);
        expect(moves[0]).toEqual(['c:a', 1, ['c:a', 'ch:b', 's:c', 'c:d', 's:e']]);
        expect(live()).toContain('Moved Mira to position 2 of 5.');
    });

    it('Alt+ArrowDown jumps a row in the 3-wide grid; focus stays on the moved pin', () => {
        mount();
        card('general').focus();
        key(card('general'), 'ArrowDown', { altKey: true });
        expect(names()).toEqual(['Mira', 'Neon Guild', 'Weekend crew', 'Design Team', 'general']);
        expect(live()).toContain('Moved general to position 5 of 5.');
        expect(document.activeElement).toBe(card('general'));
    });

    it('Ctrl+ArrowLeft works too; at the start it says so instead of moving', () => {
        mount();
        card('Neon Guild').focus();
        key(card('Neon Guild'), 'ArrowLeft', { ctrlKey: true });
        expect(names()[1]).toBe('Neon Guild');
        key(card('Mira'), 'ArrowLeft', { altKey: true });
        expect(moves).toHaveLength(1);
        expect(live()).toMatch(/Mira can't move back any further\. Position 1 of 5\./);
    });

    it('a plain Enter still opens the pin, a plain arrow does nothing', () => {
        mount();
        key(card('Mira'), 'Enter');
        key(card('Mira'), 'ArrowRight');
        expect(opened).toEqual(['Mira']);
        expect(moves).toHaveLength(0);
    });

    it('POSITIVE CONTROL: with reordering off, Alt+Arrow neither moves nor announces', () => {
        mount(false);
        key(card('Mira'), 'ArrowRight', { altKey: true });
        expect(names()[0]).toBe('Mira');
        expect(moves).toHaveLength(0);
        expect(live()).toBe('');
        expect(card('Mira').getAttribute('aria-describedby')).toBeNull();
    });
});

describe('pointer: click vs drag', () => {
    it('a short press (under the 8px threshold) still opens the pin', () => {
        mount();
        const el = card('Neon Guild');
        pointer('pointerdown', el, 230, 20);
        pointer('pointermove', document, 233, 22);
        pointer('pointerup', document, 233, 22);
        click(el);
        expect(opened).toEqual(['Neon Guild']);
        expect(moves).toHaveLength(0);
    });

    it('POSITIVE CONTROL: a real drag does NOT also open the pin', () => {
        mount();
        const el = card('Neon Guild');
        pointer('pointerdown', el, 230, 20);
        pointer('pointermove', document, 250, 24);
        expect(el.getAttribute('data-dnd')).toBe('source');
        pointer('pointerup', document, 250, 24);
        click(el);
        expect(opened).toEqual([]);
    });

    it('dragging across a row wrap drops into the new row', () => {
        mount();
        // Mira (slot 0, centre 50,20) → over slot 4 (centre 160,70).
        const el = card('Mira');
        pointer('pointerdown', el, 50, 20);
        pointer('pointermove', document, 70, 30);
        pointer('pointermove', document, 160, 70);
        pointer('pointerup', document, 160, 70);
        expect(moves[0]?.slice(0, 2)).toEqual(['c:a', 4]);
        expect(names()).toEqual(['general', 'Neon Guild', 'Weekend crew', 'Design Team', 'Mira']);
    });

    it('Esc mid-drag cancels: no move, slot restored', () => {
        mount();
        const el = card('Mira');
        pointer('pointerdown', el, 50, 20);
        pointer('pointermove', document, 160, 70);
        expect(el.getAttribute('data-dnd')).toBe('source');
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); });
        pointer('pointerup', document, 160, 70);
        expect(moves).toHaveLength(0);
        expect(names()[0]).toBe('Mira');
        expect(card('Mira').getAttribute('data-dnd')).toBeNull();
    });
});

describe('PinCard uses the same dnd wiring as the test card', () => {
    const src = readFileSync(join(__dirname, 'HomePanel.tsx'), 'utf8');
    const pinCard = src.slice(src.indexOf('const PinCard: React.FC'), src.indexOf('const AddPinCard: React.FC'));
    it('ref, key, listeners, state and the reorder key handler are all applied', () => {
        expect(pinCard).toContain('ref={dnd?.setNodeRef}');
        expect(pinCard).toContain('data-pin-key=');
        expect(pinCard).toContain('{...dnd?.listeners}');
        expect(pinCard).toContain('data-dnd={dnd?.state}');
        expect(pinCard).toMatch(/if \(dnd\?\.onReorderKeyDown\?\.\(e\)\) return;\s*if \(e\.key === 'Enter'/);
        expect(pinCard).toContain('...dnd?.style');
    });
    it('HomePanel renders pins through HomePinsGrid with onReorderPins', () => {
        expect(src).toMatch(/<HomePinsGrid[\s\S]*?onMove=\{onReorderPins\}/);
    });
});

describe('Dashboard persists the order through the existing pins path', () => {
    const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
    it('reorder goes through setPinnedHomeItems + moveVisiblePin (the persisted key)', () => {
        expect(dash).toMatch(/const handleReorderHomePins = useCallback\(\(key: string, toIndex: number, visibleKeys: string\[\]\) => \{\s*setPinnedHomeItems\(prev => moveVisiblePin\(prev, visibleKeys, key, toIndex\) \?\? prev\);/);
        expect(dash).toContain('onReorderPins={handleReorderHomePins}');
        // Same single storage key as pin/unpin — no new order key to classify.
        expect(dash.match(/cipherline_home_pins_\$\{userId\}/g)).toHaveLength(2);
        expect(dash).not.toMatch(/home_pins_order|home_pin_order/);
    });
    it('new pins still append at the end', () => {
        expect(dash).toMatch(/prev\.some\(p => pinKey\(p\) === pinKey\(item\)\) \? prev : \[\.\.\.prev, item\]/);
    });
});
