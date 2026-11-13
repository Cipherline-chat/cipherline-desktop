// @vitest-environment jsdom
/**
 * HighFiveButton: the pressed ("High-fived today") state must come from the
 * server's flag on mount (so it survives an app restart / remount), flip on a
 * repeat press when the API answers 429 "High-fived today", and never be
 * re-enabled by a stale cached profile within the session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const post = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post } }));
const invalidate = vi.hoisted(() => vi.fn());
vi.mock('../../utils/profileCache', () => ({ invalidateProfile: invalidate }));
vi.mock('../../utils/apiPath', () => ({ apiUrl: (s: TemplateStringsArray, ...v: unknown[]) => 'http://x' + String.raw({ raw: s }, ...v) }));

import { HighFiveButton, __resetHighFiveSession } from './HighFiveButton';

const h = React.createElement as (...a: any[]) => React.ReactElement;
let host: HTMLElement; let root: Root;

const mount = async (props: Record<string, unknown> = {}) => {
    await act(async () => { root.render(h(HighFiveButton, { userId: 'u1', token: 't', count: 3, ...props })); });
};
const btn = () => host.querySelector('button') as HTMLButtonElement;
const press = async () => { await act(async () => { btn().click(); }); };
const httpErr = (status: number, data: unknown) => Object.assign(new Error('x'), { response: { status, data } });

beforeEach(() => {
    __resetHighFiveSession(); post.mockReset(); invalidate.mockReset();
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('HighFiveButton pressed state', () => {
    it('starts pressed from the profile flag (restart / remount), with the reopening time in the tooltip', async () => {
        await mount({ alreadyToday: true, againAt: new Date(Date.now() + 3 * 3600_000 - 1000).toISOString() });
        expect(btn().getAttribute('aria-pressed')).toBe('true');
        expect(btn().getAttribute('data-done')).toBe('true');
        expect(btn().title).toMatch(/high-fived them today.*about 3 hours/i);
        await press();
        expect(post).not.toHaveBeenCalled();
    });

    it('is pressable when the flag is absent or false (older server / not yet high-fived)', async () => {
        await mount();
        expect(btn().getAttribute('aria-pressed')).toBe('false');
        await act(async () => { root.unmount(); }); root = createRoot(host);
        await mount({ alreadyToday: false });
        expect(btn().getAttribute('aria-pressed')).toBe('false');
    });

    it('a successful press goes pressed, and a fresh mount with a STALE profile (flag false) stays pressed in-session', async () => {
        post.mockResolvedValue({ status: 200, data: { ok: true } });
        await mount();
        await press();
        expect(post).toHaveBeenCalledTimes(1);
        expect(btn().getAttribute('aria-pressed')).toBe('true');
        expect(invalidate).toHaveBeenCalledWith('u1');
        await act(async () => { root.unmount(); }); root = createRoot(host);
        await mount({ alreadyToday: false });
        expect(btn().getAttribute('aria-pressed')).toBe('true');
    });

    it('a repeat press answered 429 {code: HIGH_FIVED_TODAY} flips to pressed with no error, and uses retry_after for the tooltip', async () => {
        post.mockRejectedValue(httpErr(429, { statusCode: 429, message: 'High-fived today.', code: 'HIGH_FIVED_TODAY', retry_after: 2 * 3600 }));
        await mount();
        await press();
        expect(btn().getAttribute('aria-pressed')).toBe('true');
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(btn().title).toMatch(/try again in about 2 hours/i);
    });

    it('the first shipped server\'s bare-string 429 body also flips to pressed (the original "does nothing" bug)', async () => {
        post.mockRejectedValue(httpErr(429, 'High-fived today.'));
        await mount();
        await press();
        expect(btn().getAttribute('aria-pressed')).toBe('true');
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(btn().title).toMatch(/try again tomorrow/i);
    });

    it('a throttler 429 (no high-five wording) is an error, not "already"', async () => {
        post.mockRejectedValue(httpErr(429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }));
        await mount();
        await press();
        expect(btn().getAttribute('aria-pressed')).toBe('false');
        expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/could not send/i);
    });

    it('restart simulation: fresh session state + profile flag still renders pressed', async () => {
        post.mockResolvedValue({ status: 200, data: { ok: true } });
        await mount();
        await press();
        __resetHighFiveSession(); // app restarted: in-memory set is gone
        await act(async () => { root.unmount(); }); root = createRoot(host);
        await mount({ alreadyToday: false });
        expect(btn().getAttribute('aria-pressed')).toBe('false'); // old cached profile, nothing else to go on
        await act(async () => { root.unmount(); }); root = createRoot(host);
        await mount({ alreadyToday: true }); // the refetched profile says so
        expect(btn().getAttribute('aria-pressed')).toBe('true');
    });
});

describe('wiring', () => {
    it('every HighFiveButton in ProfileModal (preview + full profile) is given the profile flag', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const src = readFileSync(join(process.cwd(), 'src/components/ProfileModal.tsx'), 'utf8');
        const uses = src.match(/<HighFiveButton [^>]*\/>/g) ?? [];
        expect(uses.length).toBe(2);
        for (const u of uses) expect(u).toMatch(/alreadyToday=\{profile\.high_fived_today\}.*againAt=\{profile\.high_five_again_at\}/);
    });
});
