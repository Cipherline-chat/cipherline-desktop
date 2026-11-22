// @vitest-environment jsdom
/**
 * The in-chat invite card, mounted for real against a faked preview endpoint.
 * Owner reports 2026-11-21:
 *   1. "someone sent a server invite, I see it and so do other people, but the
 *      message straight up isn't there for him, and he's resent it again" —
 *      a message that is ONLY an invite link has no text of its own (the bare
 *      link is hidden when the card renders; a `server_invite` message carries
 *      none), so whatever the card shows IS the message. It must always show
 *      the link, whatever the lookup did.
 *   2. "scrolling a long list of invite cards eventually turns them all
 *      expired/unavailable" — only a definite 404/410/400 may say expired; a
 *      429 or an outage says "couldn't load" with a Retry, and remounts reuse
 *      the shared answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const axiosMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), isAxiosError: (e: unknown) => !!(e as { isAxiosError?: boolean })?.isAxiosError }));
vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));
vi.mock('../../hooks/useEncryptedAvatar', () => ({ useEncryptedAvatar: () => null, avatarUrlMime: () => null }));

const { ServerInviteEmbed } = await import('./ServerInviteEmbed');
const { clearInvitePreviews } = await import('../../utils/invitePreviewCache');

const PREVIEW = {
    server_id: 'S9', server_name: 'Pixel Garden', server_description: 'Pixel art.', server_icon: null,
    server_icon_key_b64: null, server_icon_nonce_b64: null, member_count: 214, expires_at: null, uses: 0, max_uses: null,
};
const httpError = (status: number, headers: Record<string, string> = {}) =>
    Object.assign(new Error(`status ${status}`), { isAxiosError: true, response: { status, headers, data: {} } });

/** The fake server: what GET /invites/:code/preview answers, per code. */
let answer: (code: string) => Promise<unknown>;
const previewCalls = () => axiosMock.get.mock.calls.filter(c => /\/invites\/[^/]+\/preview/.test(String(c[0]))).length;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(2_000_000);
    clearInvitePreviews();
    axiosMock.get.mockReset().mockImplementation((url: string) => {
        const code = decodeURIComponent(String(url).match(/\/invites\/([^/]+)\/preview/)?.[1] ?? '');
        return answer(code).then(data => ({ data, status: 200 }));
    });
    answer = async () => PREVIEW;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
});

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); await flush(); };
const text = () => host.textContent ?? '';
/** Each card's state, read from what it SAYS (not from an attribute), so the
 *  same assertions run against the code before this fix. */
const states = () => Array.from(host.querySelectorAll('div.mt-1.select-none')).map(e => {
    const t = e.textContent ?? '';
    if (/Invite expired/.test(t)) return 'invalid';
    if (/Couldn’t load|Invite unavailable/.test(t)) return 'error';
    if (/Go to Server/.test(t)) return 'joined';
    if (/Join Server/.test(t)) return 'valid';
    return 'loading';
});

type Card = { code: string; servers?: { server_id: string }[] };
const mount = async (cards: Card[]) => {
    act(() => root.render(React.createElement(React.Fragment, null, ...cards.map((c, i) => React.createElement(ServerInviteEmbed, {
        key: `${c.code}-${i}`, code: c.code, token: 'tok', servers: (c.servers ?? []) as never, onJoin: () => {},
    })))));
    await flush();
};

describe('a message that is only an invite link always shows something of what was sent', () => {
    it('while loading: "Loading invite…" and the link itself (not an empty skeleton)', async () => {
        answer = () => new Promise(() => {});
        await mount([{ code: 'abcd1234' }]);
        expect(states()).toEqual(['loading']);
        expect(text()).toContain('Loading invite');
        expect(text()).toContain('cipherline.chat/invite/abcd1234');
    });

    it('the lookup keeps failing (5xx / offline): "Couldn\'t load", the link and Retry — never "expired"', async () => {
        answer = async () => { throw httpError(500); };
        await mount([{ code: 'abcd1234' }]);
        await advance(30_000); // the quiet retries
        expect(states()).toEqual(['error']);
        expect(text()).toContain('Couldn’t load this invite');
        expect(text()).toContain('cipherline.chat/invite/abcd1234');
        expect(text()).not.toMatch(/expired/i);
        const retry = Array.from(host.querySelectorAll('button')).find(b => /Retry/.test(b.textContent ?? ''));
        expect(retry).toBeDefined();
        answer = async () => PREVIEW;
        await act(async () => { retry!.click(); });
        await flush();
        expect(states()).toEqual(['valid']);
        expect(text()).toContain('Pixel Garden');
    });

    it('the sender is a member of (or owns) the server: the card says so, with Go to Server', async () => {
        await mount([{ code: 'abcd1234', servers: [{ server_id: 'S9' }] }]);
        expect(states()).toEqual(['joined']);
        expect(text()).toContain('Pixel Garden');
        expect(text()).toContain('Go to Server');
    });

    it('a dead invite shows "Invite expired" and still the link', async () => {
        answer = async () => { throw httpError(404); };
        await mount([{ code: 'gone1' }]);
        expect(states()).toEqual(['invalid']);
        expect(text()).toContain('Invite expired');
        expect(text()).toContain('cipherline.chat/invite/gone1');
    });
});

describe('rate limiting never turns a card "expired"', () => {
    it('a 429 keeps the card loading, waits Retry-After, then shows the invite', async () => {
        let n = 0;
        answer = async () => { if (n++ === 0) throw httpError(429, { 'retry-after': '20' }); return PREVIEW; };
        await mount([{ code: 'abcd1234' }]);
        expect(states()).toEqual(['loading']);
        await advance(19_000);
        expect(states()).toEqual(['loading']);
        await advance(1_500);
        expect(states()).toEqual(['valid']);
    });

    it('a 429 that never ends: "Couldn\'t load" with Retry, not "expired"', async () => {
        answer = async () => { throw httpError(429, { 'retry-after': '5' }); };
        await mount([{ code: 'abcd1234' }]);
        await advance(120_000);
        expect(states()).toEqual(['error']);
        expect(text()).not.toMatch(/expired/i);
    });

    it('400 (the API\'s "expired"/"exhausted") is the only other thing that says expired', async () => {
        answer = async () => { throw httpError(400); };
        await mount([{ code: 'old1' }]);
        expect(states()).toEqual(['invalid']);
    });

    it('a long list: 80 cards behind a 60-a-minute server budget all end up valid, none expired', async () => {
        const hits: number[] = [];
        answer = async () => {
            const now = Date.now();
            while (hits.length && now - hits[0] >= 60_000) hits.shift();
            if (hits.length >= 60) throw httpError(429, { 'retry-after': String(Math.ceil((60_000 - (now - hits[0])) / 1000)) });
            hits.push(now);
            return PREVIEW;
        };
        await mount(Array.from({ length: 80 }, (_, i) => ({ code: `L${i}` })));
        await advance(65_000);
        await advance(10_000);
        const s = states();
        expect(s.filter(x => x === 'valid')).toHaveLength(80);
        expect(s).not.toContain('invalid');
        // Every code asked once, plus at most a handful of 429s (one pause, not 20 cards x 3 retries).
        expect(previewCalls()).toBeLessThanOrEqual(80 + 8);
    });

    it('a channel with more invites than four windows of budget: no card ever shows "expired" or gives up', async () => {
        const hits: number[] = [];
        answer = async () => {
            const now = Date.now();
            while (hits.length && now - hits[0] >= 60_000) hits.shift();
            if (hits.length >= 60) throw httpError(429, { 'retry-after': String(Math.ceil((60_000 - (now - hits[0])) / 1000)) });
            hits.push(now);
            return PREVIEW;
        };
        await mount(Array.from({ length: 260 }, (_, i) => ({ code: `M${i}` })));
        const seen = new Set<string>();
        for (let t = 0; t < 300; t += 10) { await advance(10_000); for (const x of states()) seen.add(x); }
        expect(seen.has('invalid')).toBe(false);
        expect(seen.has('error')).toBe(false);
        expect(states().filter(x => x === 'valid')).toHaveLength(260);
    });

    it('a card that remounts (scrolling, switching channels and back) does not ask again', async () => {
        await mount([{ code: 'abcd1234' }, { code: 'abcd1234' }, { code: 'efgh5678' }]);
        expect(previewCalls()).toBe(2);
        act(() => root.render(null));
        await mount([{ code: 'abcd1234' }, { code: 'efgh5678' }]);
        expect(states()).toEqual(['valid', 'valid']); // straight from the shared answer, no loading flash
        expect(previewCalls()).toBe(2);
    });
});
