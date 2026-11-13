// @vitest-environment jsdom
/**
 * The one-time "Show what you're listening to?": who is asked, when, and that
 * nothing keeps looking afterwards. The real prefs module on an in-memory store
 * whose cold-namespace window can be staged. listeningAsk.realStore.test.ts does
 * the persistence part against the real encrypted store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => {
    // jsdom has no matchMedia, and the kit's physics read it on import.
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const store = new Map<string, string>();
    const state = { ready: new Set<string>(), gate: Promise.resolve() as Promise<void>, flushGate: Promise.resolve() as Promise<void> };
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: vi.fn((k: string, v: string) => { store.set(k, v); }),
        removeItem: (k: string) => { store.delete(k); },
        isAccountReady: (uid: string) => state.ready.has(uid),
        whenAccountReady: () => state.gate,
        flushNow: vi.fn(() => state.flushGate),
    };
    return { store, state, api };
});
vi.mock('../../utils/secureLocalStore', () => ({ default: h.api, secureLocalStore: h.api }));

import { ListeningAskHost } from './ListeningAskHost';
import { getListeningPrefs, resetListeningPrefsCache, setListeningPrefs } from '../../utils/integrations/listeningPrefs';
import { LISTENING_ASK_AUTO_HIDE_MS, LISTENING_ASK_CHECK_MS, LISTENING_ASK_COPY, LISTENING_ASK_GRACE_MS, listeningAskGate } from '../../utils/integrations/listeningAsk';
import { classifyKvKey } from '../../services/backupRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const asked = (u: string) => `cipherline_listening_asked_${u}`;
const share = (u: string) => `cipherline_listening_share_${u}`;

type Props = Partial<React.ComponentProps<typeof ListeningAskHost>>;
let root: Root | null = null;
let host: HTMLDivElement;
let looks: ReturnType<typeof vi.fn>;

const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const element = (p: Props) => React.createElement(ListeningAskHost, { userId: A, busy: false, uiBusy: false, isDnd: () => false, ...p });
const render = async (p: Props = {}) => { act(() => root!.render(element(p))); await settle(); };
/** A fresh mount, as after a restart: only the store survives. */
const boot = async (p: Props = {}) => {
    act(() => root?.unmount());
    root = createRoot(host);
    resetListeningPrefsCache();
    await render(p);
};
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await settle(); };
const click = async () => { act(() => { document.dispatchEvent(new Event('pointerdown')); }); await settle(); };
const card = () => document.querySelector('[data-testid="listening-ask"]');
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
const press = async (label: string) => { act(() => button(label).click()); await settle(); };
/** Past the boot grace, then a click with the person here. */
const reachFirstLook = async () => { await advance(LISTENING_ASK_GRACE_MS); await click(); };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-31T12:00:00Z'));
    h.store.clear();
    h.state.ready = new Set([A, B]);
    h.state.gate = Promise.resolve();
    h.state.flushGate = Promise.resolve();
    h.api.setItem.mockClear();
    h.api.flushNow.mockClear();
    resetListeningPrefsCache();
    looks = vi.fn(async () => true);
    (window as unknown as { electronAPI: unknown }).electronAPI = { isMusicPlaying: looks, platform: 'windows' };
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    document.body.innerHTML = '';
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('asked once, ever', () => {
    it('positive control: never set, music playing, person here: the card appears with the question and Enable', async () => {
        await render();
        expect(card()).toBeNull();
        await reachFirstLook();
        expect(looks).toHaveBeenCalledTimes(1);
        expect(card()?.textContent).toContain(LISTENING_ASK_COPY.title);
        expect(button(LISTENING_ASK_COPY.enable)).toBeTruthy();
        expect(button(LISTENING_ASK_COPY.decline)).toBeTruthy();
    });

    it('the record is on disk before the card exists, so a crash cannot ask twice', async () => {
        let onDisk = () => {};
        h.state.flushGate = new Promise<void>((r) => { onDisk = r; });
        await render();
        await reachFirstLook();
        expect(h.store.get(asked(A))).toBe('1');
        expect(h.api.flushNow).toHaveBeenCalledTimes(1);
        expect(card()).toBeNull(); // still waiting for the disk
        onDisk();
        await settle();
        expect(card()).not.toBeNull();
    });

    it('a crash with the card up: the restart does not ask, and does not look', async () => {
        await render();
        await reachFirstLook();
        expect(card()).not.toBeNull();
        await boot();
        await advance(LISTENING_ASK_GRACE_MS + LISTENING_ASK_CHECK_MS);
        await click();
        expect(card()).toBeNull();
        expect(looks).toHaveBeenCalledTimes(1);
    });

    it('declining: gone, the setting untouched (not a deliberate off), and never asked across restarts', async () => {
        await render();
        await reachFirstLook();
        await press(LISTENING_ASK_COPY.decline);
        expect(card()).toBeNull();
        expect(h.store.has(share(A))).toBe(false);
        expect(getListeningPrefs(A).share).toBe(false);
        for (let i = 0; i < 3; i++) {
            await boot();
            await advance(LISTENING_ASK_GRACE_MS + LISTENING_ASK_CHECK_MS);
            await click();
        }
        expect(card()).toBeNull();
        expect(looks).toHaveBeenCalledTimes(1);
    });

    it('ignoring: the card leaves on its own and that is the answer', async () => {
        await render();
        await reachFirstLook();
        await advance(LISTENING_ASK_AUTO_HIDE_MS - 1);
        expect(card()).not.toBeNull();
        await advance(1);
        expect(card()).toBeNull();
        expect(h.store.has(share(A))).toBe(false);
        await advance(LISTENING_ASK_CHECK_MS);
        await click();
        expect(card()).toBeNull();
        expect(looks).toHaveBeenCalledTimes(1);
    });
});

describe('Enable', () => {
    it('turns on the real setting, the one Settings controls, and nothing else', async () => {
        await render();
        await reachFirstLook();
        await press(LISTENING_ASK_COPY.enable);
        expect(card()).toBeNull();
        expect(h.store.get(share(A))).toBe('1');
        resetListeningPrefsCache();
        expect(getListeningPrefs(A)).toEqual({ share: true, includeBrowser: false, includeWatching: false });
        // Watching and browsers stay their own opt-ins: not even written as off.
        expect(h.store.has(`cipherline_listening_watching_${A}`)).toBe(false);
        expect(h.store.has(`cipherline_listening_browser_${A}`)).toBe(false);
        await advance(LISTENING_ASK_CHECK_MS);
        await click();
        expect(looks).toHaveBeenCalledTimes(1);
    });
});

describe('never asked when the setting has an answer', () => {
    it.each([['on', '1', 'setting_on'], ['deliberately off', '0', 'setting_off']])('%s: no look, no card, no write, nothing even listening', async (_n, value, gate) => {
        h.store.set(share(A), value);
        expect(listeningAskGate(A)).toBe(gate);
        const add = vi.spyOn(document, 'addEventListener');
        await render();
        await reachFirstLook();
        expect(looks).not.toHaveBeenCalled();
        expect(add.mock.calls.filter((c) => c[0] === 'pointerdown' && (c[2] as { passive?: boolean })?.passive === true)).toHaveLength(0);
        expect(card()).toBeNull();
        expect(h.api.setItem).not.toHaveBeenCalled();
    });

    it('flipping the switch in Settings while eligible is an answer: looking stops at once', async () => {
        await render();
        act(() => setListeningPrefs(A, { share: true }));
        await settle();
        act(() => setListeningPrefs(A, { share: false }));
        await settle();
        await reachFirstLook();
        expect(h.store.get(share(A))).toBe('0');
        expect(looks).not.toHaveBeenCalled();
        expect(card()).toBeNull();
    });
});

describe('a cold account store', () => {
    it('never prompts, looks or writes, though every key reads null', async () => {
        h.state.ready = new Set();
        let release = () => {};
        h.state.gate = new Promise<void>((r) => { release = r; });
        expect(listeningAskGate(A)).toBe('store_cold');
        await render();
        await reachFirstLook();
        await advance(LISTENING_ASK_CHECK_MS);
        await click();
        expect(looks).not.toHaveBeenCalled();
        expect(card()).toBeNull();
        expect(h.api.setItem).not.toHaveBeenCalled();
        expect(h.store.size).toBe(0);
        // Still cold after the store's promise settles (a switch moved on): still nothing.
        release();
        await settle();
        await advance(LISTENING_ASK_GRACE_MS);
        await click();
        expect(looks).not.toHaveBeenCalled();
    });

    it('once the records load, the account that was already asked is not asked', async () => {
        h.state.ready = new Set();
        let release = () => {};
        h.state.gate = new Promise<void>((r) => { release = r; });
        await render();
        h.store.set(asked(A), '1'); // what the decrypt brings in
        h.state.ready = new Set([A]);
        release();
        await settle();
        await reachFirstLook();
        expect(looks).not.toHaveBeenCalled();
        expect(card()).toBeNull();
    });
});

describe('account switching', () => {
    it('asked is per account, and a card up for A leaves with A', async () => {
        await render();
        await reachFirstLook();
        expect(card()).not.toBeNull();
        await render({ userId: B });
        expect(card()).toBeNull();
        await reachFirstLook();
        expect(looks).toHaveBeenCalledTimes(2);
        expect(card()).not.toBeNull();
        expect(h.store.get(asked(B))).toBe('1');
    });
});

describe('it waits for a calm moment', () => {
    const blocked: Array<[string, Props, (() => void)?]> = [
        ['loading, locked or in a call', { busy: true }],
        ['onboarding, Settings or a first-run prompt', { uiBusy: true }],
        ['Do Not Disturb', { isDnd: () => true }],
        ['the window is not focused', {}, () => { vi.spyOn(document, 'hasFocus').mockReturnValue(false); }],
        ['the window is hidden', {}, () => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(true); }],
        ['fullscreen', {}, () => { Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.body }); }],
        ['a modal is open', {}, () => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); document.body.appendChild(d); }],
        ['a nudge is in the corner', {}, () => { const d = document.createElement('div'); d.setAttribute('data-corner-card', ''); document.body.appendChild(d); }],
    ];
    it.each(blocked)('%s: no look at all', async (_n, props, stage) => {
        stage?.();
        await render(props);
        await reachFirstLook();
        expect(looks).not.toHaveBeenCalled();
        expect(card()).toBeNull();
        expect(h.api.setItem).not.toHaveBeenCalled();
    });

    it('nothing looks during the boot grace, and input is what starts a look: no input, no look', async () => {
        await render();
        await advance(LISTENING_ASK_GRACE_MS - 1);
        await click();
        expect(looks).not.toHaveBeenCalled();
        await advance(24 * 3600_000);
        expect(looks).not.toHaveBeenCalled();
    });

    it('mid-sentence, the answer waits for the next look and nothing is recorded', async () => {
        let answer = (_v: boolean) => {};
        looks.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
        await render();
        await reachFirstLook();
        act(() => { document.dispatchEvent(new Event('keydown')); });
        await act(async () => { answer(true); });
        await settle();
        expect(card()).toBeNull();
        expect(h.store.has(asked(A))).toBe(false);
        await advance(LISTENING_ASK_CHECK_MS);
        await click();
        expect(card()).not.toBeNull();
    });

    it('a call starting during a look: no card and no record; a call arriving with the card up takes it down, the record stays', async () => {
        let answer = (_v: boolean) => {};
        looks.mockImplementationOnce(() => new Promise<boolean>((r) => { answer = r; }));
        await render();
        await reachFirstLook();
        await render({ busy: true });
        await act(async () => { answer(true); });
        await settle();
        expect(card()).toBeNull();
        expect(h.store.has(asked(A))).toBe(false);

        await render();
        await advance(LISTENING_ASK_CHECK_MS);
        await click();
        expect(card()).not.toBeNull();
        await render({ busy: true });
        expect(card()).toBeNull();
        expect(h.store.get(asked(A))).toBe('1');
    });

    it('music stopped: nothing happens, and the next look is not sooner than the interval', async () => {
        looks.mockResolvedValueOnce(false);
        await render();
        await reachFirstLook();
        expect(card()).toBeNull();
        expect(h.store.has(asked(A))).toBe(false);
        await advance(LISTENING_ASK_CHECK_MS - 1);
        await click();
        expect(looks).toHaveBeenCalledTimes(1);
        await advance(1);
        await click();
        expect(looks).toHaveBeenCalledTimes(2);
        expect(card()).not.toBeNull();
    });
});

describe('looking stops afterwards', () => {
    it('after the card is shown nothing looks again, and every listener is gone', async () => {
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        await render();
        await reachFirstLook();
        const types = ['keydown', 'pointerdown', 'wheel'];
        const count = (spy: typeof add | typeof remove) => spy.mock.calls.filter((c) => types.includes(c[0] as string) && (c[2] as { capture?: boolean })?.capture === true).length;
        expect(count(add)).toBeGreaterThan(0);
        expect(count(remove)).toBe(count(add));
        await press(LISTENING_ASK_COPY.decline);
        for (let i = 0; i < 20; i++) {
            await advance(LISTENING_ASK_CHECK_MS);
            await click();
        }
        expect(looks).toHaveBeenCalledTimes(1);
    });
});

describe('what the renderer can learn', () => {
    it('only a literal true counts: a string, an object or a throw is no', async () => {
        for (const v of ['Teardrop', { title: 'Teardrop' }, 1, null]) {
            looks.mockResolvedValueOnce(v);
            await render();
            await reachFirstLook();
            expect(card()).toBeNull();
            await advance(LISTENING_ASK_CHECK_MS);
        }
        looks.mockRejectedValueOnce(new Error('boom'));
        await click();
        expect(card()).toBeNull();
        expect(h.store.has(asked(A))).toBe(false);
    });

    it('the card shows the fixed copy and nothing else, whatever is playing', async () => {
        await render();
        await reachFirstLook();
        expect(card()?.textContent).toBe(`${LISTENING_ASK_COPY.title}${LISTENING_ASK_COPY.body}${LISTENING_ASK_COPY.note}${LISTENING_ASK_COPY.enable}${LISTENING_ASK_COPY.decline}`);
    });
});

describe('where it is not offered', () => {
    it.each([
        ['macOS', { isMusicPlaying: () => Promise.resolve(true), platform: 'mac' }],
        ['a main process without the check', { platform: 'windows' }],
        ['no bridge at all', undefined],
    ])('%s: nothing armed, nothing shown', async (_n, api) => {
        const spy = vi.fn(async () => true);
        (window as unknown as { electronAPI: unknown }).electronAPI = api && 'isMusicPlaying' in api ? { ...api, isMusicPlaying: spy } : api;
        const add = vi.spyOn(document, 'addEventListener');
        await render();
        await reachFirstLook();
        expect(spy).not.toHaveBeenCalled();
        expect(card()).toBeNull();
        expect(add.mock.calls.filter((c) => c[0] === 'pointerdown' && (c[2] as { passive?: boolean })?.passive === true)).toHaveLength(0);
    });
});

describe('backups', () => {
    it('the record is classified and restored, with the switch it asks about', () => {
        expect(classifyKvKey(asked(A), A)).toBe('include');
        expect(classifyKvKey(share(A), A)).toBe('include');
    });
});
