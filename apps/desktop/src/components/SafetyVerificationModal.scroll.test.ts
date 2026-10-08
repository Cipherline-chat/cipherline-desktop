// @vitest-environment jsdom
/**
 * Layout contract for the identity-verification modal at ANY device count.
 *
 * Reported: "On the safety numbers check, if they have a lot of devices it
 * kinda breaks the UI and I cannot check their code again because the button is
 * cut off."
 *
 * Cause: the card is a `flex-col` capped by `.mcard--scroll`'s max-height. Past
 * the cap its children do not overflow, they SHRINK — and every child with
 * `overflow: hidden` (the all-clear card, the quick-verify card, each device
 * row) has an automatic min-height of 0, so it shrinks without limit and clips
 * its own content. The all-clear card collapsed to a sliver with "Check their
 * code again" cut in half and unclickable (measured in Chromium, 25 devices).
 *
 * jsdom does no layout, so this cannot measure pixels (the real-browser
 * bounding-box check lives in the PR report's harness run). What it CAN pin is
 * the structure that makes the layout correct, and every assertion below fails
 * on the previous markup, where header, list and Close were all direct,
 * shrinkable children of the card:
 *   - one dedicated scroll body (`min-h-0 flex-1 overflow-y-auto`),
 *   - header and footer outside it and `shrink-0`,
 *   - the device list and the re-check button INSIDE it,
 *   - Close INSIDE the footer, never inside the scroller,
 *   - the body's children in a height:auto column (not shrinkable by the card).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));

const ME = 'bob-user-id';
const ALICE = 'alice-user-id';
const MY_PUB = b64(7);

let directories: Record<string, { device_id: string; identity_key_pub_b64: string }[]> = {};

vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url: string) => {
            const m = /user_id=([^&]+)/.exec(url);
            return { data: directories[m?.[1] ?? ''] ?? [] };
        }),
    },
}));

let pinStore: Record<string, { pub: string; verified: boolean; sv?: number }> = {};
vi.mock('../utils/keyVerification', () => ({
    getDeviceVerification: (_my: string, _their: string, pub?: string, deviceId?: string) => {
        const rec = deviceId ? pinStore[deviceId] : undefined;
        if (!rec) return { state: 'unverified', legacy: false };
        if (pub && pub !== rec.pub) return { state: 'key_changed', legacy: false };
        return rec.verified
            ? { state: 'verified', legacy: !(typeof rec.sv === 'number' && rec.sv >= 2) }
            : { state: 'unverified', legacy: false };
    },
    markVerified: () => {},
    acknowledgeKeyChange: () => {},
    getKnownDevices: () => Object.fromEntries(
        Object.entries(pinStore).map(([k, v]) => [k, { ...v, first_seen: 1, last_seen: 1 }]),
    ),
}));

// PBKDF2 is real work this layout suite has no business waiting on.
vi.mock('../utils/safetyNumber', async () => {
    const actual = await vi.importActual<typeof import('../utils/safetyNumber')>('../utils/safetyNumber');
    return {
        ...actual,
        computeSafetyNumber: async (a: { pubB64: string }, b: { pubB64: string }) =>
            Array.from({ length: 12 }, (_, i) =>
                String((a.pubB64.charCodeAt(i % a.pubB64.length) * 31 + b.pubB64.charCodeAt(i % b.pubB64.length)) % 100000)
                    .padStart(5, '0'),
            ).join(' '),
    };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SafetyVerificationModal: any;
let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ SafetyVerificationModal } = await import('./SafetyVerificationModal'));
}, 60000);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    pinStore = {};
    directories = { [ME]: [{ device_id: 'my-dev', identity_key_pub_b64: MY_PUB }] };
    (window as unknown as { electronAPI: unknown }).electronAPI = { getLocalIdentity: async () => MY_PUB };
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
});

function render() {
    act(() => {
        root!.render(React.createElement(SafetyVerificationModal, {
            isOpen: true, onClose: () => {}, myUserId: ME, remoteUserId: ALICE,
            remoteUsername: 'Alice', token: 't',
        }));
    });
}

async function settle() {
    for (let i = 0; i < 60; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
}

function seedDevices(n: number, verified: boolean) {
    directories[ALICE] = Array.from({ length: n }, (_, i) => ({
        device_id: `dev-a${String(i + 1).padStart(2, '0')}-0123456789abcdef`,
        identity_key_pub_b64: b64(20 + i),
    }));
    pinStore = verified
        ? Object.fromEntries(directories[ALICE].map((d, i) => [d.device_id, { pub: b64(20 + i), verified: true, sv: 2 }]))
        : {};
}

function button(t: string): HTMLButtonElement {
    const b = Array.from(document.body.querySelectorAll('button'))
        .find(x => (x.textContent ?? '').trim().toLowerCase().startsWith(t.toLowerCase()));
    if (!b) throw new Error(`no button starting with "${t}"`);
    return b as HTMLButtonElement;
}

const card = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
const body = () => document.body.querySelector('[data-testid="verify-scroll-body"]') as HTMLElement | null;
const footer = () => document.body.querySelector('[data-testid="verify-footer"]') as HTMLElement | null;
const hasClass = (el: Element | null | undefined, ...c: string[]) => !!el && c.every(x => el.classList.contains(x));
/** The device rows are the by-eye list's `aria-expanded` toggles labelled "Device ...". */
const deviceRows = () => Array.from(document.body.querySelectorAll('button[aria-expanded]'))
    .filter(b => (b.textContent ?? '').includes('Device'));

async function openManual() {
    act(() => { button('Compare numbers by eye').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
}

describe('SafetyVerificationModal — scroll structure at any device count', () => {
    it.each([1, 4, 25])('%i devices: one scroll body between a fixed header and a fixed footer', async (n) => {
        seedDevices(n, false);
        render();
        await settle();
        await openManual();

        const b = body();
        const f = footer();
        expect(b).not.toBeNull();
        expect(f).not.toBeNull();

        // The scroller: told to scroll AND allowed to shrink below its content
        // (`min-h-0` is the flexbox overflow-trap fix; without it `flex-1`
        // cannot go under the content height and the card overflows instead).
        expect(hasClass(b, 'flex-1', 'min-h-0', 'overflow-y-auto')).toBe(true);
        // Keyboard-scrollable from anywhere in the dialog, and named for AT.
        expect(b!.getAttribute('tabindex')).toBe('0');
        expect(b!.getAttribute('role')).toBe('region');
        expect(b!.getAttribute('aria-label')).toBeTruthy();

        // Header (first child of the card) and footer never shrink or scroll.
        const header = card().firstElementChild as HTMLElement;
        expect(header).not.toBe(b);
        expect(b!.contains(header)).toBe(false);
        expect(hasClass(header, 'shrink-0')).toBe(true);
        expect(hasClass(f, 'shrink-0')).toBe(true);
        expect(b!.compareDocumentPosition(f!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

        // All of the devices scroll; none leak into the footer.
        expect(deviceRows()).toHaveLength(n);
        for (const row of deviceRows()) {
            expect(b!.contains(row)).toBe(true);
            expect(f!.contains(row)).toBe(false);
        }

        // Close is the footer's, and is NOT inside the scroller.
        const close = button('Close');
        expect(f!.contains(close)).toBe(true);
        expect(b!.contains(close)).toBe(false);

        // The cap itself is still opted into.
        expect(card().className).toContain('mcard--scroll');
    }, 30_000);

    it('body children sit in a height:auto column, so the card cannot flex-shrink them', async () => {
        seedDevices(25, false);
        render();
        await settle();
        await openManual();

        // The shrink trap applies to FLEX ITEMS of a height-constrained flex
        // container. The scroller is that container's item; its own children
        // must live in a second, unconstrained column (no flex-1 / h-* / max-h-*).
        const inner = body()!.firstElementChild as HTMLElement;
        expect(hasClass(inner, 'flex', 'flex-col')).toBe(true);
        expect(inner.className).not.toMatch(/\b(flex-1|h-|max-h-|min-h-0|overflow)/);
        // And the overflow:hidden cards are inside it, not direct card children.
        for (const el of Array.from(card().children)) {
            expect(el.className).not.toContain('overflow-hidden');
        }
    }, 30_000);

    it('all-clear: "Check their code again" is a body child, reachable by scrolling, and Close stays in the footer', async () => {
        seedDevices(25, true);
        render();
        await settle();
        await openManual();

        const again = button('Check their code again');
        expect(body()!.contains(again)).toBe(true);
        expect(footer()!.contains(again)).toBe(false);
        expect(footer()!.contains(button('Close'))).toBe(true);
        expect(deviceRows()).toHaveLength(25);
    }, 30_000);

    it('long own-device names truncate inside a flex row instead of widening the modal', async () => {
        // `truncate` is inert on a flex item unless it has `min-w-0`.
        const src = readFileSync(join(process.cwd(), 'src', 'components', 'SafetyVerificationModal.tsx'), 'utf8');
        const m = /<span\s+className="([^"]*truncate[^"]*)"\s+title=\{ownDeviceLabel/.exec(src);
        expect(m).not.toBeNull();
        expect(m![1]).toContain('min-w-0');
    });
});
