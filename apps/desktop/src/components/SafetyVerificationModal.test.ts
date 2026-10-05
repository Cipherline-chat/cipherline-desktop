// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * ── What these tests are about ──────────────────────────────────────────────
 *
 * Reported: "if you've already verified all the keys I don't think we should
 * have it show the 'quick verify' thing — just have it show a nice animation
 * indicating that everything is verified and secure."
 *
 * So the narrow claim under test is: the all-clear appears EXACTLY when
 * `deriveContactTrust` says `verified`, and in no other case. Green is the
 * narrow case — partial verification, a device the pin store has never seen,
 * and a changed key must all still land on the existing quick-verify flow,
 * because each of those is precisely the situation safety numbers exist to
 * surface and a celebration there would invert the feature.
 *
 * Every positive assertion below has a negative twin that differs in ONE bit,
 * so a test passing for the wrong reason (the component rendering nothing at
 * all, say) shows up as the control failing.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// clPhysics (pulled in by ClButton) calls matchMedia at module load.
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));

const ME    = 'bob-user-id';
const ALICE = 'alice-user-id';
const MY_PUB = b64(7);

/** What `GET /keys/identity_keys` is currently serving, per user id. */
let directories: Record<string, { device_id: string; identity_key_pub_b64: string }[]> = {};
/** Set to simulate being offline / the directory refusing to answer. */
let directoryDown = false;

vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url: string) => {
            if (directoryDown) throw new Error('Network Error');
            const m = /user_id=([^&]+)/.exec(url);
            return { data: directories[m?.[1] ?? ''] ?? [] };
        }),
    },
}));

/**
 * The real pin store is IndexedDB + WebCrypto backed. These tests only need to
 * stand in a chosen set of pins and observe that reading them never writes.
 * The fake reproduces the two behaviours the modal actually depends on:
 * an unknown device id is 'unverified', and a known device id whose pub has
 * moved is 'key_changed'.
 */
const markVerified = vi.fn();
const acknowledgeKeyChange = vi.fn();
let pinStore: Record<string, { pub: string; verified: boolean; sv?: number }> = {};
/** A pin as written today: a verified one carries the v2 provenance stamp. */
const pin = (pub: string, verified: boolean) => (verified ? { pub, verified, sv: 2 } : { pub, verified });
/** A verification written before safety-number v2 (no `sv`). */
const legacyPin = (pub: string) => ({ pub, verified: true });

vi.mock('../utils/keyVerification', () => ({
    getDeviceVerification: (_my: string, _their: string, pub?: string, deviceId?: string) => {
        const rec = deviceId ? pinStore[deviceId] : undefined;
        if (!rec) return { state: 'unverified', legacy: false };
        if (pub && pub !== rec.pub) return { state: 'key_changed', legacy: false };
        return rec.verified
            ? { state: 'verified', legacy: !(typeof rec.sv === 'number' && rec.sv >= 2) }
            : { state: 'unverified', legacy: false };
    },
    markVerified: (...a: unknown[]) => markVerified(...a),
    acknowledgeKeyChange: (...a: unknown[]) => acknowledgeKeyChange(...a),
    getKnownDevices: () => Object.fromEntries(
        Object.entries(pinStore).map(([k, v]) => [k, { ...v, first_seen: 1, last_seen: 1 }]),
    ),
}));

/**
 * The v2 safety number is a 5200-iteration PBKDF2 per half. That is real work
 * this UI suite has no business waiting on under `settle()`'s fixed budget on a
 * loaded box. The derivation has its own suite (`utils/safetyNumber.test.ts`).
 * Here it is a stub that still depends on BOTH inputs, so a grid for the wrong
 * pair would be visible.
 */
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
let computeContactCode: (uid: string, pubs: string[]) => Promise<string>;

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(async () => {
    ({ SafetyVerificationModal } = await import('./SafetyVerificationModal'));
    ({ computeContactCode } = await import('../utils/verificationCode'));
}, 60000);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    markVerified.mockClear();
    acknowledgeKeyChange.mockClear();
    pinStore = {};
    directoryDown = false;
    directories = {
        [ME]: [{ device_id: 'my-dev', identity_key_pub_b64: MY_PUB }],
    };
    (window as unknown as { electronAPI: unknown }).electronAPI = {
        getLocalIdentity: async () => MY_PUB,
    };
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function render(props: any = {}) {
    act(() => {
        root!.render(React.createElement(SafetyVerificationModal, {
            isOpen: true,
            onClose: () => {},
            myUserId: ME,
            remoteUserId: ALICE,
            remoteUsername: 'Alice',
            token: 't',
            ...props,
        }));
    });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * `ClModal` portals to `document.body`, so the rendered dialog is NOT inside
 * `host`. Read the document, not the mount point — an assertion against
 * `host.textContent` would be vacuously empty for every case at once, which is
 * the failure mode the positive controls below exist to catch.
 */
const text = () => document.body.textContent ?? '';
const q = (sel: string) => document.body.querySelector(sel);

/**
 * Let the load effect settle.
 *
 * Unconditional rather than predicate-driven, because half of these assertions
 * are about something NOT appearing and you cannot poll on an absence. The work
 * being waited on is a handful of `crypto.subtle.digest` calls over ~100 bytes
 * against a mocked directory, so this is far more slack than it needs —
 * deliberately, since this box runs several agents at once.
 */
async function settle() {
    for (let i = 0; i < 60; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
}

function clickButtonContaining(t: string) {
    const btn = Array.from(document.body.querySelectorAll('button'))
        .find(b => (b.textContent ?? '').toLowerCase().includes(t.toLowerCase()));
    if (!btn) throw new Error(`no button containing "${t}" — buttons: ${
        Array.from(document.body.querySelectorAll('button')).map(b => b.textContent).join(' | ')}`);
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** The quick-verify card is identified by its code field, not by its prose. */
const quickVerifyShown = () => !!q('#cl-verify-code-input');

describe('SafetyVerificationModal — a fully verified contact is congratulated, not re-asked', () => {
    it('every device verified: the all-clear replaces the Quick verify card', async () => {
        directories[ALICE] = [
            { device_id: 'dev-a1', identity_key_pub_b64: b64(1) },
            { device_id: 'dev-a2', identity_key_pub_b64: b64(2) },
        ];
        pinStore = { 'dev-a1': pin(b64(1), true), 'dev-a2': pin(b64(2), true) };

        render();
        await settle();

        expect(q('.cl-allclear')).not.toBeNull();
        expect(text()).toContain('Identity verified');
        expect(text()).toContain('All 2 of their devices are verified');
        // The actual ask: no code field to paste into, no "Quick verify" card.
        expect(quickVerifyShown()).toBe(false);
        expect(text()).not.toContain('Quick verify');
        // Reading persisted trust is not a new way to become verified.
        expect(markVerified).not.toHaveBeenCalled();
    }, 30_000);

    it('positive control: the SAME two devices with one unverified keep the existing flow', async () => {
        // Identical in every respect except the single bit under test.
        directories[ALICE] = [
            { device_id: 'dev-a1', identity_key_pub_b64: b64(1) },
            { device_id: 'dev-a2', identity_key_pub_b64: b64(2) },
        ];
        pinStore = { 'dev-a1': pin(b64(1), true), 'dev-a2': pin(b64(2), false) };

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(text()).not.toContain('Identity verified');
        expect(quickVerifyShown()).toBe(true);
        expect(text()).toContain('Quick verify');
    }, 30_000);

    it('a device the pin store has never seen blocks the all-clear', async () => {
        // The event safety numbers exist to surface: the contact added a device
        // since the user attested. Everything already vouched for is still
        // vouched for, and that must not add up to "you are done here".
        directories[ALICE] = [
            { device_id: 'dev-a1', identity_key_pub_b64: b64(1) },
            { device_id: 'dev-a2', identity_key_pub_b64: b64(2) },
        ];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(quickVerifyShown()).toBe(true);
    }, 30_000);

    it('a device whose key CHANGED is an alert, never the all-clear', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(9) }];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(text()).toContain('Security Alert');
        expect(quickVerifyShown()).toBe(true);
    }, 30_000);

    it('a single verified device gets the singular wording', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        expect(text()).toContain('Their device is verified');
        expect(text()).not.toContain('All 1 of their devices');
    }, 30_000);
});

describe('SafetyVerificationModal — G1 migration: a pre-v2 verification is refreshed, not celebrated and not alarmed', () => {
    /** React tracks the input's value via the prototype setter. */
    function typeCode(value: string) {
        const input = q('#cl-verify-code-input') as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    it('a fully but LEGACY-verified contact gets the refresh prompt, not the all-clear', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
        pinStore = { 'dev-a1': legacyPin(b64(1)) };

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(text()).not.toContain('Identity verified');
        expect(quickVerifyShown()).toBe(true);
        expect(text()).toContain('before safety numbers were strengthened');
        // Calm: no alarm wording anywhere on the screen.
        expect(text()).not.toContain('Security Alert');
        expect(text()).not.toContain('Key changed');
        // Opening the modal changes nothing on disk, in either direction.
        expect(markVerified).not.toHaveBeenCalled();
    }, 30_000);

    it('control: the identical contact verified at v2 strength IS the all-clear', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        expect(q('.cl-allclear')).not.toBeNull();
        expect(text()).not.toContain('before safety numbers were strengthened');
    }, 30_000);

    it('a matching code re-marks the legacy device, which is what refreshes it', async () => {
        directories[ALICE] = [
            { device_id: 'dev-a1', identity_key_pub_b64: b64(1) },
            { device_id: 'dev-a2', identity_key_pub_b64: b64(2) },
        ];
        pinStore = { 'dev-a1': legacyPin(b64(1)), 'dev-a2': pin(b64(2), true) };

        render();
        await settle();

        typeCode(await computeContactCode(ALICE, [b64(1), b64(2)]));
        clickButtonContaining('Check');

        // Exactly the legacy device: the v2-verified one needs no rewrite.
        expect(markVerified).toHaveBeenCalledTimes(1);
        expect(markVerified).toHaveBeenCalledWith(ME, ALICE, b64(1), 'dev-a1');
    }, 30_000);

    it('the by-eye digits are labelled v2 with a pointer for contacts still on 6 groups', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];

        render();
        await settle();
        clickButtonContaining('Compare numbers by eye');

        const note = q('[data-testid="sn-version-note"]');
        expect(note?.textContent).toContain('Safety number v2');
        expect(note?.textContent).toContain('12 groups');
        expect(note?.textContent).toContain('only 6 groups');
    }, 30_000);

    it('offline, a legacy-verified contact still gets the calm view from its pins, not an error', async () => {
        directoryDown = true;
        pinStore = { 'dev-a1': legacyPin(b64(1)) };

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(quickVerifyShown()).toBe(true);
        expect(text()).toContain('before safety numbers were strengthened');
    }, 30_000);
});

describe('SafetyVerificationModal — remembering a verification never costs the ability to redo it', () => {
    it('the re-check affordance brings the live comparison back', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        expect(quickVerifyShown()).toBe(false);
        clickButtonContaining('Check their code again');

        expect(quickVerifyShown()).toBe(true);
        expect(text()).toContain('Quick verify');
        // The celebration stays put rather than being traded away for the card.
        expect(q('.cl-allclear')).not.toBeNull();
    }, 30_000);

    it('the by-eye comparison is reachable without leaving the all-clear', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        // The second, independent re-verification path — never hidden by the
        // all-clear, because a user who wants to read digits aloud again is
        // exactly the user who has stopped trusting the remembered verdict.
        expect(text()).toContain('Compare numbers by eye instead');
    }, 30_000);
});

describe('SafetyVerificationModal — offline, a verified contact still reads as verified', () => {
    it('the directory being down falls back to the pin store rather than erroring', async () => {
        directoryDown = true;
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        await settle();

        expect(q('.cl-allclear')).not.toBeNull();
        expect(text()).toContain('Their device is verified');
        // And it says WHY it cannot see any newer device.
        expect(text()).toContain('from the records on this device');
        expect(text()).not.toContain('Failed to compute safety number');
    }, 30_000);

    it('positive control: offline with an UNVERIFIED pin store still shows the error', async () => {
        // Only the fully-verified case changes. Everything else keeps the
        // existing behaviour, including the honest "we could not look".
        directoryDown = true;
        pinStore = { 'dev-a1': pin(b64(1), false) };

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(text()).toContain('Network Error');
    }, 30_000);

    it('positive control: offline with NOTHING pinned still shows the error', async () => {
        directoryDown = true;
        pinStore = {};

        render();
        await settle();

        expect(q('.cl-allclear')).toBeNull();
        expect(text()).toContain('Network Error');
    }, 30_000);
});

describe('SafetyVerificationModal — the all-clear animation', () => {
    it('plays once on open and then drops its class, so it cannot loop on re-render', async () => {
        directories[ALICE] = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
        pinStore = { 'dev-a1': pin(b64(1), true) };

        render();
        // Settle only the load, not the animation window.
        for (let i = 0; i < 12; i++) {
            await act(async () => { await new Promise(r => setTimeout(r, 5)); });
        }
        expect(q('.cl-allclear.cl-allclear--seal')).not.toBeNull();
        expect(q('.cl-allclear-crest.cl-allclear--seal')).not.toBeNull();

        // Past ALLCLEAR_ANIM_MS the transient class is gone; the card itself
        // stays, so "verified" is a resting state and only the flourish is
        // one-shot. This is also what keeps the reduced-motion path honest —
        // the resting styles ARE the finished frame.
        await act(async () => { await new Promise(r => setTimeout(r, 1600)); });
        expect(q('.cl-allclear')).not.toBeNull();
        expect(q('.cl-allclear--seal')).toBeNull();
    }, 30_000);
});
