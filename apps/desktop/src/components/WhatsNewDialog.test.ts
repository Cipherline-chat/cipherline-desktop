// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});

vi.mock('./mascot/Keys', () => ({ Keys: () => React.createElement('span', { 'data-testid': 'keys' }) }));

// The baked-in notes: 1.0.23 (stable), a staging build with its own section, and a draft.
vi.mock('virtual:whats-new', () => {
    const n = (version: string, text: string, date: string | null = '2026-10-14') =>
        ({ version, date, groups: [{ title: null, items: [{ title: 'Calls', text }, { title: null, text: 'A second thing.' }] }] });
    return { default: { releases: { '1.0.23': n('1.0.23', 'Moving someone is not a kick.'), '1.0.24-staging.3': n('1.0.24-staging.3', 'Staging notes.', null) }, unreleased: n('Unreleased', 'Draft.', null) } };
});

const store = new Map<string, string>();
const whenAccountReady = vi.fn(() => Promise.resolve());
vi.mock('../utils/secureLocalStore', () => ({
    default: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        whenAccountReady: () => whenAccountReady(),
    },
}));
const openExternalLink = vi.fn((_url: string) => ({ ok: true }));
vi.mock('../utils/openExternalLink', () => ({ openExternalLink: (u: string) => openExternalLink(u) }));

import { WhatsNewHost, WHATS_NEW_DELAY_MS } from './WhatsNewDialog';
import { CHANGELOG_URL, OPEN_WHATS_NEW_EVENT, WHATS_NEW_SEEN_KEY } from '../utils/whatsNew';

let root: Root;
let host: HTMLDivElement;

const mount = (props: { enabled?: boolean; version?: string }) =>
    act(() => { root.render(React.createElement(WhatsNewHost, { enabled: props.enabled ?? true, version: props.version ?? '1.0.23' })); });
const flush = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const dialog = () => document.querySelector('.wn-card');

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store.clear();
    openExternalLink.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('WhatsNewHost: when it shows', () => {
    it('first install: records the version, shows nothing, ever', async () => {
        mount({});
        await flush(WHATS_NEW_DELAY_MS + 500);
        expect(dialog()).toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.23');
    });

    it('first launch after an update with notes: shows once the beat has passed, and records at open', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({});
        await flush(WHATS_NEW_DELAY_MS - 100);
        expect(dialog()).toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.22');   // not recorded before it is on screen
        await flush(200);
        expect(dialog()).not.toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.23');   // recorded the moment it opens
        expect(document.body.textContent).toContain('What’s new in 1.0.23');
        expect(document.body.textContent).toContain('Released October 14, 2026');
        expect(document.body.textContent).toContain('Moving someone is not a kick.');
        expect(document.body.textContent).toContain('A second thing.');
    });

    it('never twice for the same version: a relaunch shows nothing', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({});
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(dialog()).not.toBeNull();
        act(() => { root.unmount(); });
        root = createRoot(host);
        mount({});
        await flush(WHATS_NEW_DELAY_MS + 500);
        expect(dialog()).toBeNull();
    });

    it('a crash before the user closes it still counts as seen', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({});
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.23');
    });

    it('an update with no notes: records, shows nothing', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.23');
        mount({ version: '1.0.25' });
        await flush(WHATS_NEW_DELAY_MS + 500);
        expect(dialog()).toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.25');
    });

    it('a staging pre-release shows only with notes for that exact build', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.23');
        mount({ version: '1.0.24-staging.4' });
        await flush(WHATS_NEW_DELAY_MS + 500);
        expect(dialog()).toBeNull();

        store.set(WHATS_NEW_SEEN_KEY, '1.0.23');
        act(() => { root.unmount(); });
        root = createRoot(host);
        mount({ version: '1.0.24-staging.3' });
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(dialog()).not.toBeNull();
        expect(document.body.textContent).toContain('Staging notes.');
    });

    it('waits for a calm moment: not while disabled, then shows when enabled', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({ enabled: false });
        await flush(WHATS_NEW_DELAY_MS * 3);
        expect(dialog()).toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.22');
        mount({ enabled: true });
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(dialog()).not.toBeNull();
    });

    it('does not show if the moment stops being calm during the beat, and retries when it is calm again', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({ enabled: true });
        await flush(WHATS_NEW_DELAY_MS / 2);
        mount({ enabled: false });          // a call starts
        await flush(WHATS_NEW_DELAY_MS * 2);
        expect(dialog()).toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.22');
        mount({ enabled: true });           // the call ended
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(dialog()).not.toBeNull();
    });

    it('waits for the account\'s store before it reads the recorded version', async () => {
        let release!: () => void;
        whenAccountReady.mockImplementationOnce(() => new Promise<void>(r => { release = r; }));
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({});
        await flush(WHATS_NEW_DELAY_MS * 2);
        expect(dialog()).toBeNull();
        release();
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(dialog()).not.toBeNull();
    });
});

describe('WhatsNewHost: the dialog', () => {
    const open = async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.22');
        mount({});
        await flush(WHATS_NEW_DELAY_MS + 100);
    };

    it('is labelled, and Keys is in it', async () => {
        await open();
        expect(document.querySelector('[aria-label="What’s new in 1.0.23"]')).not.toBeNull();
        expect(document.querySelector('[data-testid="keys"]')).not.toBeNull();
        expect(document.querySelector('.wn-art')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('Escape closes it', async () => {
        await open();
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        await flush(400);
        expect(dialog()).toBeNull();
    });

    it('Got it closes it, and focus starts on it', async () => {
        await open();
        const got = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Got it')!;
        expect(got).toBeTruthy();
        act(() => { got.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await flush(400);
        expect(dialog()).toBeNull();
    });

    it('"See all release notes" opens the public changelog', async () => {
        await open();
        const link = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'See all release notes')!;
        act(() => { link.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(openExternalLink).toHaveBeenCalledWith(CHANGELOG_URL);
        expect(CHANGELOG_URL).toBe('https://cipherline.chat/changelog');
    });

    it('renders notes as text: markup in a note is not interpreted', async () => {
        const mod = await import('virtual:whats-new');
        (mod.default.releases['1.0.23'].groups[0].items[1] as { text: string }).text = '<img src=x onerror=alert(1)>';
        await open();
        expect(document.querySelector('.wn-card img')).toBeNull();
        expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('reduced motion: the art is still (no animation classes at work)', async () => {
        window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
        await open();
        expect(document.querySelector('.wn-art')!.classList.contains('is-still')).toBe(true);
    });
});

describe('WhatsNewHost: on demand', () => {
    it('opens this version\'s notes from the Settings button without touching the seen record', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.23');
        mount({});
        await flush(WHATS_NEW_DELAY_MS + 100);
        expect(dialog()).toBeNull();
        act(() => { window.dispatchEvent(new CustomEvent(OPEN_WHATS_NEW_EVENT, { detail: { version: '1.0.23' } })); });
        expect(dialog()).not.toBeNull();
        expect(store.get(WHATS_NEW_SEEN_KEY)).toBe('1.0.23');
    });

    it('does nothing when there are no notes to show', async () => {
        store.set(WHATS_NEW_SEEN_KEY, '1.0.99');
        mount({ version: '1.0.99' });
        await flush(WHATS_NEW_DELAY_MS + 100);
        // a dev build falls back to the draft; the mocked data has one, so this opens "(draft)"
        act(() => { window.dispatchEvent(new CustomEvent(OPEN_WHATS_NEW_EVENT, { detail: { version: '1.0.99' } })); });
        expect(document.body.textContent).toContain('What’s new (draft)');
    });
});
