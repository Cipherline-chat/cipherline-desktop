// @vitest-environment jsdom
/**
 * The modal half of the ghost-device fix (docs/ghost-device.md §2.2-2.3):
 * "your code" is WITHHELD unless the own-device ledger accepts every device
 * the code commits to, and the covered-device count is on screen.
 *
 * Every withheld case has a twin that differs in one row and shows the code,
 * so "the code never renders at all" cannot pass these tests.
 */
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
const MY_DEV = 'bob-laptop';
const MY_PUB = b64(7);
const PHONE = { device_id: 'bob-phone', identity_key_pub_b64: b64(8) };
const GHOST = { device_id: 'ghost-dev', identity_key_pub_b64: b64(66) };

let directories: Record<string, { device_id: string; identity_key_pub_b64: string }[]> = {};
const posts: string[] = [];

vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url: string) => {
            if (/\/devices$/.test(url.split('?')[0]) && !url.includes('identity_keys')) {
                return { data: [
                    { device_id: MY_DEV, device_name: 'Laptop', platform: 'windows' },
                    { device_id: PHONE.device_id, device_name: 'Pixel', platform: 'android' },
                    { device_id: GHOST.device_id, device_name: 'Laptop', platform: 'windows' },
                ] };
            }
            const m = /user_id=([^&]+)/.exec(url);
            return { data: directories[m?.[1] ?? ''] ?? [] };
        }),
        post: vi.fn(async (url: string) => { posts.push(url); return { data: {} }; }),
    },
}));

const mem = new Map<string, string>();
vi.mock('../utils/secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        isAccountReady: (uid: string) => !!uid,
    },
}));

vi.mock('../utils/keyVerification', () => ({
    getDeviceVerification: () => ({ state: 'unverified', legacy: false }),
    markVerified: vi.fn(),
    acknowledgeKeyChange: vi.fn(),
    getKnownDevices: () => ({}),
}));

vi.mock('../utils/safetyNumber', async () => {
    const actual = await vi.importActual<typeof import('../utils/safetyNumber')>('../utils/safetyNumber');
    return { ...actual, computeSafetyNumber: async () => '00000 '.repeat(12).trim() };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SafetyVerificationModal: any;
let ledger: typeof import('../utils/ownDeviceLedger');
let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ SafetyVerificationModal } = await import('./SafetyVerificationModal'));
    ledger = await import('../utils/ownDeviceLedger');
}, 60000);

const SELF = () => ({ deviceId: MY_DEV, pub: MY_PUB });
const mine = (...extra: { device_id: string; identity_key_pub_b64: string }[]) =>
    [{ device_id: MY_DEV, identity_key_pub_b64: MY_PUB }, PHONE, ...extra];

/** Bob's install, before the attack: it has already seen {laptop, phone}. */
function baselineLedger() {
    ledger.observeOwnDevices(ME, SELF(), mine().map(r => ({ device_id: r.device_id, pub: r.identity_key_pub_b64 })), true);
}

beforeEach(() => {
    mem.clear();
    posts.length = 0;
    ledger._resetSession();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    directories = { [ALICE]: [{ device_id: 'alice-1', identity_key_pub_b64: b64(1) }] };
    (window as unknown as { electronAPI: unknown }).electronAPI = { getLocalIdentity: async () => MY_PUB };
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
});

function render(props: Record<string, unknown> = {}) {
    act(() => {
        root!.render(React.createElement(SafetyVerificationModal, {
            isOpen: true, onClose: () => {}, myUserId: ME, myDeviceId: MY_DEV,
            remoteUserId: ALICE, remoteUsername: 'Alice', token: 't', onSendCode: async () => {},
            ...props,
        }));
    });
}
const q = (sel: string) => document.body.querySelector(sel);
const qa = (sel: string) => Array.from(document.body.querySelectorAll(sel));
const text = () => document.body.textContent ?? '';
async function settle() {
    for (let i = 0; i < 60; i++) await act(async () => { await new Promise(r => setTimeout(r, 5)); });
}
function click(label: string, within?: Element | null) {
    const scope = within ?? document.body;
    const btn = Array.from(scope.querySelectorAll('button')).find(b => (b.textContent ?? '').includes(label));
    if (!btn) throw new Error(`no button "${label}"`);
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('your code: shown for a known device set', () => {
    it('control: no ghost → the code, the count and the Send button are shown', async () => {
        baselineLedger();
        directories[ME] = mine();
        render();
        await settle();
        expect(q('[data-testid="my-code"]')).not.toBeNull();
        expect(q('[data-testid="own-coverage"]')?.getAttribute('data-verdict')).toBe('ok');
        expect(q('[data-testid="my-code-count"]')?.textContent).toContain('Your code covers 2 devices');
        expect(q('[data-testid="my-code-count"]')?.textContent).toContain('This device');
        expect(q('[data-testid="my-code-count"]')?.textContent).toContain('Pixel (android)');
        expect(text()).toContain('Send my code to Alice');
        expect(q('[data-testid="their-code-count"]')?.textContent).toContain('Their code covers 1 device');
    });
});

describe('your code: the ghost-device attack', () => {
    it('a ghost in the listing withholds the code and names the device', async () => {
        baselineLedger();
        directories[ME] = mine(GHOST);
        render();
        await settle();
        expect(q('[data-testid="my-code"]')).toBeNull();
        expect(text()).not.toContain('Send my code to Alice');
        expect(q('[data-testid="own-coverage"]')?.getAttribute('data-verdict')).toBe('unconfirmed');
        const rows = qa('[data-testid="own-unconfirmed-row"]');
        expect(rows).toHaveLength(1);
        expect(q('[data-testid="my-code-count"]')?.textContent).toContain('Your code covers 3 devices');
        expect(q('[data-testid="my-code-count"]')?.textContent).toContain('plus 1 you have not confirmed');
    });

    it('"This is mine" (the legitimate new device) releases the code', async () => {
        baselineLedger();
        directories[ME] = mine(GHOST);
        render();
        await settle();
        click('This is mine', q('[data-testid="own-unconfirmed-row"]'));
        await settle();
        expect(q('[data-testid="my-code"]')).not.toBeNull();
        expect(ledger.loadOwnLedger(ME)?.devices[GHOST.device_id]?.status).toBe('confirmed');
    });

    it('"Not mine" keeps the code withheld, records the rejection and asks the server to revoke', async () => {
        baselineLedger();
        directories[ME] = mine(GHOST);
        render();
        await settle();
        click('Not mine', q('[data-testid="own-unconfirmed-row"]'));
        await settle();
        expect(q('[data-testid="my-code"]')).toBeNull();
        expect(ledger.loadOwnLedger(ME)?.devices[GHOST.device_id]?.status).toBe('rejected');
        expect(posts.some(u => u.includes(`/devices/${GHOST.device_id}/revoke`))).toBe(true);
    });

    it("a different key under THIS device's id withholds the code with the substitution warning", async () => {
        baselineLedger();
        directories[ME] = [{ device_id: MY_DEV, identity_key_pub_b64: b64(99) }, PHONE];
        render();
        await settle();
        expect(q('[data-testid="my-code"]')).toBeNull();
        expect(q('[data-testid="own-coverage"]')?.getAttribute('data-verdict')).toBe('self_key_mismatch');
        expect(text()).toContain('publishing a key for this device that this device does not hold');
    });

    it('no device id passed → fail closed (code withheld)', async () => {
        baselineLedger();
        directories[ME] = mine();
        render({ myDeviceId: null });
        await settle();
        expect(q('[data-testid="my-code"]')).toBeNull();
    });
});

describe('migration: first open after upgrade', () => {
    it('no ledger yet → the listing is baselined and the code is shown (trust on first use)', async () => {
        directories[ME] = mine();
        render();
        await settle();
        expect(q('[data-testid="my-code"]')).not.toBeNull();
        expect(ledger.loadOwnLedger(ME)?.devices[PHONE.device_id]?.status).toBe('baseline');
    });
});
