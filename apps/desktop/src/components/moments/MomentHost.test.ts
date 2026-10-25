// @vitest-environment jsdom
/**
 * The full-screen moment layer, mounted for real: portal + z-layer, the live
 * announcement, every way to skip (Escape — without also closing the dialog
 * underneath — any key without swallowing it, a click), focus taken and handed
 * back (and never pulled out of a text field), the overlay gone when the
 * animation ends, the rate limit, one-at-a-time, reduced motion, a hidden
 * window pausing the clock, and the eggs-found hook.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const kv = vi.hoisted(() => new Map<string, string>());
vi.mock('../../utils/secureLocalStore', () => {
    const api = {
        getItem: (k: string) => kv.get(k) ?? null,
        setItem: (k: string, v: string) => { kv.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let reduced = false;
window.matchMedia = ((q: string) => ({
    matches: reduced && /reduced-motion/.test(q), media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { MomentHost } = await import('./MomentHost');
const { requestMoment, MOMENTS, stillMs, PENDING_POLL_MS, announcement, momentStays } = await import('../../utils/moments');
const { pushEscapeLayer } = await import('../../utils/escapeStack');
const { EGG_FOUND_EVENT, bindEggAccount, unbindEggAccount } = await import('../../utils/eggProgress');
const { setHasActiveCall } = await import('../../utils/activeCallRegistry');

const DUR = MOMENTS['self-friend'].durationMs;
let root: Root;
let host: HTMLDivElement;
let visibility: DocumentVisibilityState = 'visible';
/** The rarity die's value (0 = every roll plays). */
let rnd = 0;
const DAY = 86_400_000;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-20T12:00:00'));
    kv.clear();
    reduced = false;
    visibility = 'visible';
    rnd = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(MomentHost, { random: () => rnd })));
});
afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.useRealTimers();
});

const moment = () => document.querySelector<HTMLElement>('[data-testid="moment"]');
const live = () => document.querySelector('[data-testid="moment-live"]')?.textContent ?? '';
const play = (id: Parameters<typeof requestMoment>[0] = 'self-friend') => act(() => { requestMoment(id); });
const key = (k: string, target: EventTarget = document.activeElement ?? document.body) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    act(() => { target.dispatchEvent(e); });
    return e;
};

describe('MomentHost', () => {
    it('plays into a portal on <body>, announces the line, and is gone when the animation ends', () => {
        play();
        const m = moment();
        expect(m).not.toBeNull();
        expect(m!.parentElement).toBe(document.body);
        expect(host.contains(m)).toBe(false);
        expect(m!.className).toContain('mo-root');
        expect(m!.getAttribute('data-moment')).toBe('self-friend');
        expect(live()).toBe(announcement('self-friend'));
        act(() => { vi.advanceTimersByTime(DUR - 10); });
        expect(moment()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(20); });
        expect(moment()).toBeNull();
    });

    it('Escape skips it — and ONLY it: the dialog underneath keeps its Escape layer', () => {
        const dialogClose = vi.fn();
        const pop = pushEscapeLayer(() => dialogClose());
        play();
        const e = key('Escape', window);
        expect(moment()).toBeNull();
        expect(dialogClose).not.toHaveBeenCalled();
        expect(e.defaultPrevented).toBe(true);
        key('Escape', window);
        expect(dialogClose).toHaveBeenCalledTimes(1);
        pop();
    });

    it('any other key skips without swallowing it (typed text is never lost)', () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        play();
        const e = key('h', input);
        expect(moment()).toBeNull();
        expect(e.defaultPrevented).toBe(false);
    });

    it('a bare modifier does not skip', () => {
        play();
        key('Shift');
        expect(moment()).not.toBeNull();
    });

    it('a click skips a stage moment', () => {
        play();
        act(() => { moment()!.click(); });
        expect(moment()).toBeNull();
    });

    it('takes focus from a button and hands it back afterwards', () => {
        const btn = document.createElement('button');
        document.body.appendChild(btn);
        btn.focus();
        play();
        expect(document.activeElement).toBe(moment());
        act(() => { vi.advanceTimersByTime(DUR + 10); });
        expect(document.activeElement).toBe(btn);
    });

    it('never pulls focus out of a text field', () => {
        const ta = document.createElement('textarea');
        document.body.appendChild(ta);
        ta.focus();
        play();
        expect(moment()).not.toBeNull();
        expect(document.activeElement).toBe(ta);
    });

    it('is rate-limited through the ledger (cooldown)', () => {
        play();
        act(() => { vi.advanceTimersByTime(DUR + 10); });
        play();
        expect(moment()).toBeNull();
        vi.setSystemTime(Date.now() + 7 * DAY);
        play();
        expect(moment()).not.toBeNull();
    });

    it('rolls the rarity die once per trigger: a miss plays nothing and starts no cooldown', () => {
        rnd = 0.99;
        play('self-ping');                      // 1 in 3: this roll misses
        expect(moment()).toBeNull();
        rnd = 0;
        play('self-ping');                      // the very next trigger may still play
        expect(moment()?.getAttribute('data-moment')).toBe('self-ping');
    });

    it('self-friend: the first time always plays, whatever the die says', () => {
        rnd = 0.99;
        play('self-friend');
        expect(moment()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(DUR + 10); });
        vi.setSystemTime(Date.now() + 8 * DAY);
        play('self-friend');                    // second time: 1 in 4, and this roll misses
        expect(moment()).toBeNull();
    });

    it('publishes its phase times as CSS variables on the root', () => {
        play();
        const st = moment()!.style;
        expect(st.getPropertyValue('--mo-exit')).toBe(`${DUR - MOMENTS['self-friend'].timeline.exit}ms`);
        expect(st.getPropertyValue('--mo-exit-dur')).toBe(`${MOMENTS['self-friend'].timeline.exit}ms`);
    });

    it('a click on the settled final frame dismisses it', () => {
        play();
        act(() => { vi.advanceTimersByTime(DUR - 800); });   // in the hold
        expect(moment()).not.toBeNull();
        act(() => { moment()!.click(); });
        expect(moment()).toBeNull();
    });

    it('one at a time: a second request while one plays is dropped, not stacked', () => {
        play();
        vi.setSystemTime(Date.now() + 8 * DAY); // past the cooldown, so only "busy" can refuse it
        play();
        expect(document.querySelectorAll('[data-testid="moment"]').length).toBe(1);
        act(() => { vi.advanceTimersByTime(DUR + 10); });
        expect(moment()).toBeNull();
        act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 2); });
        expect(moment()).toBeNull(); // a user-action moment does not queue
    });

    it('reduced motion → a still card with the punchline, long enough to read it', () => {
        reduced = true;
        play();
        const still = document.querySelector('[data-testid="moment-still"]');
        expect(still?.textContent).toContain(MOMENTS['self-friend'].line);
        expect(document.querySelector('.mo-sf')).toBeNull();
        act(() => { vi.advanceTimersByTime(stillMs('self-friend') - 10); });
        expect(moment()).not.toBeNull();
        act(() => { vi.advanceTimersByTime(20); });
        expect(moment()).toBeNull();
    });

    it('a hidden window pauses the clock; it resumes when visible', () => {
        play();
        act(() => { vi.advanceTimersByTime(1000); });
        visibility = 'hidden';
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        act(() => { vi.advanceTimersByTime(DUR * 3); });
        expect(moment()).not.toBeNull();
        visibility = 'visible';
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        act(() => { vi.advanceTimersByTime(DUR - 1000 + 10); });
        expect(moment()).toBeNull();
    });

    it('counts towards the Egg hunter tally under its bare registry id (not the ledger\'s moment: prefix)', () => {
        const seen: string[] = [];
        const on = (e: Event) => seen.push((e as CustomEvent<{ id: string }>).detail.id);
        // Earlier tests played moments with no account bound, which the egg
        // singleton buffers for whoever signs in next: drain that into a
        // throwaway account first, so this account starts from zero.
        bindEggAccount('u-drain', async () => null);
        unbindEggAccount();
        bindEggAccount('u-1', async () => null);
        window.addEventListener(EGG_FOUND_EVENT, on);
        try {
            play();
        } finally {
            window.removeEventListener(EGG_FOUND_EVENT, on);
            unbindEggAccount();
        }
        expect(seen).toEqual(['self-friend']);
        expect(JSON.parse(kv.get('cipherline_egg_progress_u-1')!).found).toEqual(['self-friend']);
    });

    it('New Year\'s call fireworks play DURING a call, never block it, and spend the underwater ones for the day', () => {
        vi.setSystemTime(new Date('2027-01-01T00:00:03'));
        setHasActiveCall(true);
        try {
            play('nye-call');
            expect(moment()?.dataset.moment).toBe('nye-call');
            expect(moment()?.className).toContain('mo-passive');             // clicks go straight through to the call
            expect(document.activeElement).toBe(document.body);                // focus untouched
            act(() => { vi.advanceTimersByTime(MOMENTS['nye-call'].durationMs + 10); });
            expect(moment()).toBeNull();
            // the ambient new-year moment is spent for the day (it would otherwise play once the call ends)
            setHasActiveCall(false);
            play('new-year');
            act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 8); });
            expect(moment()).toBeNull();
        } finally { setHasActiveCall(false); }
    });
    it('without the call fireworks, the underwater ones still play on January 1st', () => {
        vi.setSystemTime(new Date('2027-01-01T09:00:00'));
        play('new-year');                                    // ambient, and a fresh host is quiet
        expect(moment()?.dataset.moment).toBe('new-year');
    });
    it('a once-ever milestone plays once and never again', () => {
        play('first-server');
        expect(moment()?.dataset.moment).toBe('first-server');
        act(() => { vi.advanceTimersByTime(MOMENTS['first-server'].durationMs + 10); });
        expect(moment()).toBeNull();
        play('first-server');
        expect(moment()).toBeNull();
    });

    it('ignores an unknown id', () => {
        act(() => { window.dispatchEvent(new CustomEvent('cipherline:moment', { detail: { id: 'nope' } })); });
        expect(moment()).toBeNull();
    });

    describe('a moment with a real button (the @everyone echo → Invite friends)', () => {
        const ECHO = MOMENTS['echo-everyone'];
        const btn = () => document.querySelector<HTMLButtonElement>('[data-testid="moment-action"]');
        it('shows the button; Tab moves to it instead of skipping', () => {
            play('echo-everyone');
            expect(btn()?.textContent).toBe('Invite friends');
            const e = key('Tab', window);
            expect(e.defaultPrevented).toBe(true);
            expect(moment()).not.toBeNull();
            expect(document.activeElement).toBe(btn());
        });
        it('Enter on the focused button is not a skip', () => {
            play('echo-everyone');
            key('Tab', window);
            key('Enter', btn()!);
            expect(moment()).not.toBeNull();
        });
        it('pressing it fires the invite event once, for the server it was asked from, and ends the moment', () => {
            const fired: unknown[] = [];
            const on = (e: Event) => fired.push((e as CustomEvent).detail);
            window.addEventListener('cipherline:moment-invite', on);
            act(() => { requestMoment('echo-everyone', { serverId: 'srv-reef' }); });
            act(() => { btn()!.click(); });
            window.removeEventListener('cipherline:moment-invite', on);
            expect(fired).toEqual([{ serverId: 'srv-reef' }]);
            expect(moment()).toBeNull();
        });
        it('with no server given, the invite asks for the open server (serverId null)', () => {
            const fired: unknown[] = [];
            const on = (e: Event) => fired.push((e as CustomEvent).detail);
            window.addEventListener('cipherline:moment-invite', on);
            play('echo-everyone');
            act(() => { btn()!.click(); });
            window.removeEventListener('cipherline:moment-invite', on);
            expect(fired).toEqual([{ serverId: null }]);
        });
        it('never times out while the button is up (owner: "stay there unless they click away")', () => {
            play('echo-everyone');
            act(() => { vi.advanceTimersByTime(ECHO.durationMs * 20); });
            expect(moment()).not.toBeNull();
            expect(btn()).not.toBeNull();
            expect(moment()!.style.getPropertyValue('--mo-exit')).toBe('86400s');
        });
        it('a hidden window and back changes nothing; Escape still dismisses it', () => {
            play('echo-everyone');
            visibility = 'hidden';
            act(() => { document.dispatchEvent(new Event('visibilitychange')); });
            act(() => { vi.advanceTimersByTime(60_000); });
            visibility = 'visible';
            act(() => { document.dispatchEvent(new Event('visibilitychange')); });
            act(() => { vi.advanceTimersByTime(60_000); });
            expect(moment()).not.toBeNull();
            key('Escape', window);
            expect(moment()).toBeNull();
        });
        it('typing dismisses it too (the key is not swallowed)', () => {
            const input = document.createElement('input');
            document.body.appendChild(input);
            input.focus();
            play('echo-everyone');
            act(() => { vi.advanceTimersByTime(30_000); });
            const e = key('x', input);
            expect(moment()).toBeNull();
            expect(e.defaultPrevented).toBe(false);
        });
        it('under reduced motion the card and the button also stay', () => {
            reduced = true;
            play('echo-everyone');
            act(() => { vi.advanceTimersByTime(60_000); });
            expect(btn()).not.toBeNull();
        });
        it('a click elsewhere on the stage skips without inviting', () => {
            const fired = vi.fn();
            window.addEventListener('cipherline:moment-invite', fired);
            play('echo-everyone');
            act(() => { moment()!.click(); });
            window.removeEventListener('cipherline:moment-invite', fired);
            expect(fired).not.toHaveBeenCalled();
            expect(moment()).toBeNull();
        });
    });

    describe('ambient moments wait for a quiet moment (friends-100)', () => {
        afterEach(() => setHasActiveCall(false));
        it('during a call: waits, then plays once the call is over', () => {
            setHasActiveCall(true);
            play('friends-100');
            expect(moment()).toBeNull();
            act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 3); });
            expect(moment()).toBeNull();
            setHasActiveCall(false);
            act(() => { vi.advanceTimersByTime(PENDING_POLL_MS + 10); });
            expect(moment()?.getAttribute('data-moment')).toBe('friends-100');
        });
        it('while someone is typing: waits for 8 s of no keys', () => {
            key('a', window);
            play('friends-100');
            expect(moment()).toBeNull();
            act(() => { vi.advanceTimersByTime(8_000 + PENDING_POLL_MS); });
            expect(moment()).not.toBeNull();
        });
        it('hidden window: waits until visible', () => {
            visibility = 'hidden';
            play('friends-100');
            act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 3); });
            expect(moment()).toBeNull();
            visibility = 'visible';
            act(() => { vi.advanceTimersByTime(PENDING_POLL_MS + 10); });
            expect(moment()).not.toBeNull();
        });
        it('gives up after 15 minutes of never being quiet (and is not marked seen)', () => {
            setHasActiveCall(true);
            play('friends-100');
            act(() => { vi.advanceTimersByTime(16 * 60_000); });
            setHasActiveCall(false);
            act(() => { vi.advanceTimersByTime(PENDING_POLL_MS * 2); });
            expect(moment()).toBeNull();
            play('friends-100'); // still due: it never played
            expect(moment()).not.toBeNull();
        });
        it('passive: no focus taken, clicks pass through and skip', () => {
            const btn = document.createElement('button');
            document.body.appendChild(btn);
            btn.focus();
            play('friends-100');
            expect(document.activeElement).toBe(btn);
            expect(moment()!.getAttribute('aria-hidden')).toBe('true');
            act(() => { btn.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
            expect(moment()).toBeNull();
        });
    });

    describe('every registered moment', () => {
        const IDS = Object.keys(MOMENTS) as Array<keyof typeof MOMENTS>;
        it.each(IDS)('%s renders, announces its line, keeps its art aria-hidden, and is gone after durationMs (unless its button stays)', (id) => {
            play(id);
            const m = moment();
            expect(m?.getAttribute('data-moment')).toBe(id);
            expect(live()).toBe(announcement(id));
            const art = m!.firstElementChild!;
            expect(art.getAttribute('aria-hidden') ?? m!.getAttribute('aria-hidden')).toBe('true');
            act(() => { vi.advanceTimersByTime(MOMENTS[id].durationMs - 10); });
            expect(moment()).not.toBeNull();
            act(() => { vi.advanceTimersByTime(20); });
            expect(moment() === null).toBe(!momentStays(id));
        });
        it.each(IDS)('%s: the words marked data-read are exactly the `shown` punchline its reading time is sized for', (id) => {
            play(id);
            const read = [...moment()!.querySelectorAll('[data-read]')].map(e => e.textContent?.trim()).join(' ');
            expect(read).toBe(MOMENTS[id].shown);
        });
        it.each(IDS)('%s under reduced motion: the still card carries its punchline', (id) => {
            reduced = true;
            play(id);
            expect(document.querySelector('[data-testid="moment-still"]')?.textContent).toContain(MOMENTS[id].line);
        });
    });
});
