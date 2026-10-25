// @vitest-environment jsdom
/**
 * The one-time "make sure it's really them" callout, mounted for real: when it shows and when it
 * does not, both buttons, Escape, the "seen" record, verifying elsewhere, the quiet first minute,
 * and that it never comes back once finished.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    return {
        map,
        readyUserId: null as string | null,
        getItem: vi.fn((k: string) => map.get(k) ?? null),
        setItem: vi.fn((k: string, v: string) => { map.set(k, v); }),
        keysWithPrefix: vi.fn((p: string) => [...map.keys()].filter(k => k.startsWith(p))),
        isAccountReady: vi.fn((uid: string) => !!uid && store.readyUserId === uid),
    };
});
vi.mock('../utils/secureLocalStore', () => ({ secureLocalStore: store, default: store }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = (() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof window.matchMedia;

const { default: SafetyVerifyHint } = await import('./SafetyVerifyHint');
const { markVerified } = await import('../utils/keyVerification');
const { HINT_SEEN_MS, HINT_QUIET_START_MS, SAFETY_HINT_DONE_PREFIX, isHintDone, markHintDone } = await import('../utils/safetyVerifyHint');

const ME = 'me-user';
const THEM = 'them-user';
type Msg = { id: string; sender_user_id: string; content: { type: string } };
const thread = (mine: number, theirs: number, type = 'text'): Msg[] => [
    ...Array.from({ length: mine }, (_, i) => ({ id: `m${i}`, sender_user_id: ME, content: { type } })),
    ...Array.from({ length: theirs }, (_, i) => ({ id: `t${i}`, sender_user_id: THEM, content: { type } })),
];
const isMine = (m: Msg) => m.sender_user_id === ME;

interface Over { [k: string]: unknown }
let root: Root;
let host: HTMLDivElement;
let onCompare: ReturnType<typeof vi.fn>;
let nowMs: number;

const props = (over: Over = {}) => ({
    userId: ME, peerUserId: THEM, peerName: 'Mara', isOneToOneDm: true, isSelfChat: false, warningActive: false,
    messages: thread(5, 5), isMine: isMine as (m: never) => boolean, callActiveHere: false, onCompare, ...over,
});
const render = (over: Over = {}) => act(() => { root.render(React.createElement(SafetyVerifyHint, props(over) as never)); });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    store.map.clear();
    store.readyUserId = ME;
    // Five messages each way means the contact's device has been seen and pinned, not yet verified.
    store.map.set(`kv_verify_v2_${ME}_${THEM}`, JSON.stringify({ v: 2, devices: { 'dev-t': { pub: 'pubT', verified: false, first_seen: 1, last_seen: 1 } } }));
    onCompare = vi.fn();
    nowMs = HINT_QUIET_START_MS + 5_000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const card = () => document.querySelector<HTMLElement>('[data-testid="safety-verify-hint"]');
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const press = (label: string) => act(() => { button(label)!.click(); });
const escape = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });

describe('it shows, once everything holds', () => {
    it('renders the card with the owner’s words, on a non-modal dialog, and takes no focus', () => {
        const typing = document.createElement('input');
        document.body.appendChild(typing);
        typing.focus();
        render();
        const c = card()!;
        expect(c).not.toBeNull();
        expect(c.getAttribute('role')).toBe('dialog');
        expect(c.getAttribute('aria-modal')).toBe('false');
        expect(c.textContent).toContain('Make sure it’s really them');
        expect(c.textContent).toContain('Compare safety numbers with Mara once, in person or on a call. If they match, nobody is sitting in the middle.');
        expect(button('Compare now')).toBeTruthy();
        expect(button('Not now')).toBeTruthy();
        expect(c.textContent).not.toMatch(/!/);
        expect(document.activeElement).toBe(typing);                            // never steals focus from the composer
        // labelled and described by its own title and body
        expect(document.getElementById(c.getAttribute('aria-labelledby')!)!.textContent).toContain('Make sure');
        expect(document.getElementById(c.getAttribute('aria-describedby')!)!.textContent).toContain('safety numbers');
        // announced politely, once, with the way out
        const status = document.querySelector('[role="status"]')!;
        expect(status.textContent).toMatch(/Make sure it’s really them\. Press Escape to dismiss\./);
    });

    it('its buttons are real, reachable buttons after the shield in the DOM (keyboard path)', () => {
        render();
        const c = card()!;
        const buttons = [...c.querySelectorAll('button')];
        expect(buttons.map(b => b.textContent?.trim())).toEqual(['Compare now', 'Not now']);
        for (const b of buttons) { expect(b.tabIndex).toBeGreaterThanOrEqual(0); expect(b.disabled).toBe(false); }
    });

    it('enters with the app’s own entrance class, which index.css already turns off under reduced motion', () => {
        render();
        expect(card()!.className).toContain('fade-rise-enter');
        const css = readFileSync(join(__dirname, '..', 'index.css'), 'utf8');
        const reduced = css.slice(css.indexOf('prefers-reduced-motion: reduce'));
        expect(reduced).toMatch(/\.fade-rise-enter[^}]*animation:\s*none/);
    });
});

describe('it stays away', () => {
    const cases: Array<[string, Over, () => void]> = [
        ['a group or channel', { isOneToOneDm: false }, () => {}],
        ['your own notes chat', { isSelfChat: true }, () => {}],
        ['one message short on my side', { messages: thread(4, 5) }, () => {}],
        ['one message short on their side', { messages: thread(5, 4) }, () => {}],
        ['a thread of reactions and system rows, no real messages', { messages: thread(9, 9, 'system') }, () => {}],
        ['a call live in this DM', { callActiveHere: true }, () => {}],
        ['a key-change warning for this contact', { warningActive: true }, () => {}],
        ['the first minute after app start', {}, () => { nowMs = HINT_QUIET_START_MS - 1; }],
        ['no account', { userId: null }, () => {}],
        ['no contact', { peerUserId: null }, () => {}],
        ['someone already verified (any contact)', {}, () => {
            store.map.set(`kv_verify_v2_${ME}_somebody-else`, JSON.stringify({ v: 2, devices: { d: { pub: 'p', verified: true, first_seen: 1, last_seen: 1 } } }));
        }],
        ['this contact is already verified', {}, () => {
            store.map.set(`kv_verify_v2_${ME}_${THEM}`, JSON.stringify({ v: 2, devices: { d: { pub: 'p', verified: true, first_seen: 1, last_seen: 1 } } }));
        }],
        ['no key of theirs is known yet (nothing to compare)', {}, () => { store.map.delete(`kv_verify_v2_${ME}_${THEM}`); }],
        ['already finished with', {}, () => { markHintDone(ME); }],
        ['tips switched off', {}, () => { store.map.set(`cipherline_first_week_nudges_${ME}`, JSON.stringify({ v: 1, off: true })); }],
        ['the account records not loaded yet', {}, () => { store.readyUserId = null; }],
    ];
    it.each(cases)('%s', (_name, over, setup) => {
        setup();
        render(over);
        expect(card()).toBeNull();
    });

    it('a positive control: the same mount with none of those is a card', () => {
        render();
        expect(card()).not.toBeNull();
    });
});

describe('every way out finishes it for good', () => {
    it('"Compare now" opens the safety-number dialog for this contact, and the hint is done', () => {
        render();
        press('Compare now');
        expect(onCompare).toHaveBeenCalledTimes(1);
        expect(card()).toBeNull();
        expect(isHintDone(ME)).toBe(true);
        expect(store.map.get(SAFETY_HINT_DONE_PREFIX + ME)).toBe('1');
    });
    it('"Not now" just closes it, and the hint is done', () => {
        render();
        press('Not now');
        expect(onCompare).not.toHaveBeenCalled();
        expect(card()).toBeNull();
        expect(isHintDone(ME)).toBe(true);
    });
    it('Escape closes it, and the hint is done', () => {
        render();
        escape();
        expect(card()).toBeNull();
        expect(onCompare).not.toHaveBeenCalled();
        expect(isHintDone(ME)).toBe(true);
    });
    it('Escape belongs to the card only while it is up (nothing to take when it is not)', () => {
        render({ messages: thread(1, 1) });
        expect(() => escape()).not.toThrow();
        expect(isHintDone(ME)).toBe(false);
    });
    it('verifying ANYONE by any route takes it down and finishes it', () => {
        render();
        expect(card()).not.toBeNull();
        act(() => { markVerified(ME, 'a-different-contact', 'pubZ', 'dev-z', 'Jin'); });
        expect(card()).toBeNull();
        expect(isHintDone(ME)).toBe(true);
    });
    it('verifying THIS contact (the dialog’s own flow) takes it down too', () => {
        render();
        act(() => { markVerified(ME, THEM, 'pubA', 'dev-a', 'Mara'); });
        expect(card()).toBeNull();
        expect(isHintDone(ME)).toBe(true);
    });
    it('once finished it never comes back: not on a re-render, not in another DM, not after a remount', () => {
        render();
        press('Not now');
        render({ messages: thread(6, 6) });
        expect(card()).toBeNull();
        render({ peerUserId: 'another', peerName: 'Jin', messages: thread(20, 20) });
        expect(card()).toBeNull();
        act(() => root.unmount());
        root = createRoot(host);
        render();
        expect(card()).toBeNull();
    });
});

describe('seen = on screen long enough', () => {
    it('records the hint as done after a few seconds, but leaves the card up until it is dismissed', () => {
        render();
        expect(isHintDone(ME)).toBe(false);
        act(() => { vi.advanceTimersByTime(HINT_SEEN_MS - 10); });
        expect(isHintDone(ME)).toBe(false);
        act(() => { vi.advanceTimersByTime(20); });
        expect(isHintDone(ME)).toBe(true);
        expect(card()).not.toBeNull();                      // done, but not yanked from under the reader
        press('Not now');
        expect(card()).toBeNull();
    });
    it('a chat switch before it has been seen leaves it for the next eligible DM; after, never', () => {
        render();
        act(() => { vi.advanceTimersByTime(1000); });
        render({ isOneToOneDm: false });                    // switched to a group: gone, but not spent
        expect(card()).toBeNull();
        expect(isHintDone(ME)).toBe(false);
        render();                                           // back in a qualifying DM
        expect(card()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(HINT_SEEN_MS + 10); });
        render({ isOneToOneDm: false });
        render();
        expect(card()).toBeNull();                          // seen once: done for good
    });
});

describe('the quiet first minute', () => {
    it('waits out the start-up, then appears by itself', () => {
        nowMs = 20_000;
        render();
        expect(card()).toBeNull();
        nowMs = HINT_QUIET_START_MS + 100;
        act(() => { vi.advanceTimersByTime(HINT_QUIET_START_MS - 20_000 + 100); });
        expect(card()).not.toBeNull();
    });
    it('a call starting in the meantime keeps it away', () => {
        nowMs = 20_000;
        render();
        nowMs = HINT_QUIET_START_MS + 100;
        render({ callActiveHere: true });
        act(() => { vi.advanceTimersByTime(HINT_QUIET_START_MS); });
        expect(card()).toBeNull();
    });
});

describe('while it is up, the conversation can stop qualifying', () => {
    it('a call starting in this DM takes it down', () => {
        render();
        expect(card()).not.toBeNull();
        render({ callActiveHere: true });
        expect(card()).toBeNull();
    });
    it('a key-change warning appearing takes it down', () => {
        render();
        render({ warningActive: true });
        expect(card()).toBeNull();
    });
});

describe('wiring', () => {
    const src = (f: string) => readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    it('ChatPane mounts it on the shield, for a real 1:1 DM only, and "Compare now" opens the existing dialog', () => {
        const chat = src('ChatPane.tsx');
        expect(chat).toContain("import SafetyVerifyHint from './SafetyVerifyHint';");
        const at = chat.indexOf('<SafetyVerifyHint');
        expect(at).toBeGreaterThan(-1);
        const mount = chat.slice(at, chat.indexOf('/>', at));
        expect(mount).toMatch(/isOneToOneDm=\{!activeChannel && activeChat\.type === 'dm' && !isSelfChat\}/);
        expect(mount).toMatch(/onCompare=\{\(\) => setSafetyModalOpen\(true\)\}/);
        expect(mount).toMatch(/callActiveHere=\{!!activeCall && activeCall\.conversation_id === activeChat\.id\}/);
        // sits inside the same relative wrapper as the shield it hangs off
        const wrapper = chat.lastIndexOf('<span className="relative inline-flex">', at);
        expect(wrapper).toBeGreaterThan(chat.lastIndexOf('<TrustBadge', at) - 400);
        expect(chat.indexOf('<TrustBadge', wrapper)).toBeLessThan(at);
    });
    it('uses secureLocalStore (never raw localStorage) and no network', () => {
        for (const f of ['../utils/safetyVerifyHint.ts', '../utils/firstVerification.ts', 'SafetyVerifyHint.tsx']) {
            const t = src(f);
            expect(t, f).not.toMatch(/\blocalStorage\b|\bsessionStorage\b/);
            expect(t, f).not.toMatch(/\baxios\b|\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|electronAPI/);
        }
    });
    it('touches nothing in the design-system primitives the website imports (components/cl)', () => {
        expect(src('SafetyVerifyHint.tsx')).toMatch(/import \{ ClButton \} from '\.\/cl';/);
    });
});
