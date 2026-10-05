// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * End-to-end check of the property `safetyNumberEmbed.test.ts` proves in
 * isolation: that it survives the trip through the actual UI.
 *
 * The unit test shows `evaluateSafetyNumberEmbed` cannot be talked into a
 * match. This one shows the COMPONENT has no other route to a green state
 * either — no prop, no payload field, no early return — and, separately, that
 * even a genuine match does not touch the trust store until the user attests
 * to an out-of-band comparison.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// clPhysics (pulled in by ClButton) calls matchMedia at module load.
window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

/** Whatever the key directory is currently pretending to serve. */
let directoryKeys: { device_id: string; identity_key_pub_b64: string }[] = [];
vi.mock('axios', () => ({
    default: { get: vi.fn(async () => ({ data: directoryKeys })) },
}));

// The real pin store is IndexedDB+WebCrypto backed; all these tests need is to
// observe whether the component writes to it and when, and to stand in a chosen
// set of pins so the resting-state derivation has something to read.
const markVerified = vi.fn();
/** Whatever this device has pinned for the sender, keyed by device id. */
let pinStore: Record<string, { pub: string; verified: boolean; first_seen: number; last_seen: number; sv?: number }> = {};
/** A pin as written today: a verified one carries the v2 provenance stamp. */
const pin = (pub: string, verified: boolean) =>
    (verified ? { pub, verified, first_seen: 1, last_seen: 1, sv: 2 } : { pub, verified, first_seen: 1, last_seen: 1 });
/** A verification written before safety-number v2 (no `sv`). */
const legacyPin = (pub: string) => ({ pub, verified: true, first_seen: 1, last_seen: 1 });
vi.mock('../utils/keyVerification', () => ({
    markVerified: (...a: unknown[]) => markVerified(...a),
    getKnownDevices: () => pinStore,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let SafetyNumberEmbed: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let computeContactCode: any;

let root: Root | null = null;
let host: HTMLDivElement;

const ALICE = 'alice-user-id';
const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const ALICE_REAL = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(1) }];
const ATTACKER   = [{ device_id: 'dev-x1', identity_key_pub_b64: b64(9) }];

beforeAll(async () => {
    ({ SafetyNumberEmbed } = await import('./SafetyNumberEmbed'));
    ({ computeContactCode } = await import('../utils/verificationCode'));
}, 60000);

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    markVerified.mockClear();
    // Default: nothing pinned. Every pre-existing test below was written
    // against that world and must keep behaving identically in it.
    pinStore = {};
});

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function render(props: any) {
    act(() => {
        root!.render(React.createElement(SafetyNumberEmbed, {
            claimedUserId: ALICE,
            senderUserId: ALICE,
            myUserId: 'bob-user-id',
            senderName: 'Alice',
            token: 't',
            ...props,
        }));
    });
}

function clickButtonContaining(text: string) {
    const btn = Array.from(host.querySelectorAll('button'))
        .find(b => (b.textContent ?? '').toLowerCase().includes(text.toLowerCase()));
    if (!btn) throw new Error(`no button containing "${text}" — buttons: ${
        Array.from(host.querySelectorAll('button')).map(b => b.textContent).join(' | ')}`);
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/**
 * Runs the check and waits for it to actually settle.
 *
 * Microtask flushes are NOT enough here: `computeContactCode` awaits a real
 * `crypto.subtle.digest`, which resolves off the microtask queue, so a
 * `await Promise.resolve()` loop leaves the component parked in its
 * `checking` phase — rendering a loading ClButton whose textContent is empty,
 * which then reads in a failure message as "no buttons at all". Poll on real
 * timers until the verdict lands instead.
 */
async function runCheck() {
    clickButtonContaining('Check this code');
    for (let i = 0; i < 50; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
        if (!host.querySelector('.cl-sn-foot .clb.load')) return;
    }
    throw new Error(`check never settled; DOM: ${host.textContent}`);
}

/**
 * Let the resting-state effect settle.
 *
 * Unconditional rather than predicate-driven, because half of these assertions
 * are about something NOT appearing and you cannot poll on an absence. The work
 * being waited on is one `crypto.subtle.digest` over ~100 bytes and no network
 * at all, so this is orders of magnitude more slack than it needs — deliberately,
 * since this box runs several agents at once (see CLAUDE.md on load artifacts).
 */
async function settleResting() {
    for (let i = 0; i < 40; i++) {
        await act(async () => { await new Promise(r => setTimeout(r, 5)); });
    }
}

describe('SafetyNumberEmbed — a forged embed cannot reach a verified state', () => {
    it('a payload asserting verified/result/expected still renders MISMATCH', async () => {
        // Bob's directory view is Alice's real key; the embed carries a code
        // for the attacker's key set, dressed up with every outcome-shaped
        // field an attacker might hope the client honours.
        directoryKeys = ALICE_REAL;
        render({
            code: await computeContactCode(ALICE, [b64(9)]),
            deviceCount: 1,
            // These are not in the component's props interface at all — passed
            // anyway, because "the type forbids it" is only a compile-time
            // claim and this asserts the runtime one.
            verified: true,
            result: 'match',
            expected: await computeContactCode(ALICE, [b64(1)]),
        });

        await runCheck();

        expect(host.textContent).toContain('does not match');
        expect(host.textContent).not.toContain('This code matches');
        // The decisive assertion: nothing was pinned.
        expect(markVerified).not.toHaveBeenCalled();
    });

    it('positive control: the SAME component renders a match when the keys genuinely agree', async () => {
        // Identical setup, only the code changes. Proves the assertion above
        // discriminates rather than the component simply never saying "match".
        directoryKeys = ALICE_REAL;
        render({ code: await computeContactCode(ALICE, [b64(1)]), deviceCount: 1 });

        await runCheck();

        expect(host.textContent).toContain('This code matches');
        expect(host.textContent).not.toContain('does not match');
    });

    it('an embed naming a different account than the sender is refused, not compared', async () => {
        directoryKeys = ALICE_REAL;
        render({
            senderUserId: 'mallory-user-id',
            claimedUserId: ALICE,
            code: await computeContactCode(ALICE, [b64(1)]),
        });

        await runCheck();

        expect(host.textContent).toContain('names a different account');
        expect(markVerified).not.toHaveBeenCalled();
    });

    it('a directory the client cannot read yields "unavailable", never an optimistic match', async () => {
        directoryKeys = [];
        render({ code: await computeContactCode(ALICE, [b64(1)]) });

        await runCheck();

        expect(host.textContent).not.toContain('This code matches');
        expect(markVerified).not.toHaveBeenCalled();
    });
});

describe('SafetyNumberEmbed — a match alone never grants trust', () => {
    it('does NOT mark verified on a match — the out-of-band attestation is still required', async () => {
        directoryKeys = ALICE_REAL;
        render({ code: await computeContactCode(ALICE, [b64(1)]) });

        await runCheck();

        expect(host.textContent).toContain('This code matches');
        // The whole security argument for shipping this feature at all: an
        // in-band match is not evidence of anything an attacker who
        // substituted the keys could not also produce.
        expect(markVerified).not.toHaveBeenCalled();
        expect(host.textContent).toContain('somewhere else');
    });

    it('marks verified only after the user attests to comparing it out of band', async () => {
        directoryKeys = ALICE_REAL;
        render({ code: await computeContactCode(ALICE, [b64(1)]) });
        await runCheck();

        clickButtonContaining('I compared this elsewhere');

        expect(markVerified).toHaveBeenCalledTimes(1);
        // Pins the pub the CLIENT fetched and compared, not anything the
        // message supplied.
        expect(markVerified).toHaveBeenCalledWith('bob-user-id', ALICE, b64(1), 'dev-a1');
        expect(host.textContent).toContain('Marked verified');
    });

    it('the attestation button is absent on a mismatch, so there is no path to pin bad keys', async () => {
        directoryKeys = ATTACKER;
        render({ code: await computeContactCode(ALICE, [b64(1)]) });
        await runCheck();

        expect(host.textContent).toContain('does not match');
        expect(() => clickButtonContaining('I compared this elsewhere')).toThrow();
        expect(markVerified).not.toHaveBeenCalled();
    });

    it('your own sent code renders as a share, with no check or verify affordance', async () => {
        directoryKeys = ALICE_REAL;
        render({
            senderUserId: 'bob-user-id',   // me
            claimedUserId: 'bob-user-id',
            code: await computeContactCode(ALICE, [b64(1)]),
        });

        expect(host.textContent).toContain('You shared your safety code');
        expect(host.querySelectorAll('button').length).toBe(0);
        expect(markVerified).not.toHaveBeenCalled();
    });
});

/**
 * ── The resting state ───────────────────────────────────────────────────────
 *
 * The reported bug: "after you verify, if you go out of the chat and back in it
 * shows up in the embedding again like you need to verify." `ChatPane` remounts
 * on every chat switch, so anything held only in `useState` is gone — while the
 * pin store has been sitting there the whole time with the answer.
 *
 * These assert the fix AND its limit. Verification is per-device and a contact
 * can add devices, so "already verified" is not a boolean about a person, and
 * the failure mode that would be worse than the bug is a green "you're good to
 * go" over a contact who has since gained a device nobody vouched for.
 */
describe('SafetyNumberEmbed — a verification already done is not asked for again', () => {
    it('a verified contact shows the verified state on a FRESH mount, with no check needed', async () => {
        // No click, no directory fetch — only what the pin store persisted.
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({ code: await computeContactCode(ALICE, [b64(1)]), deviceCount: 1 });

        await settleResting();

        expect(host.textContent).toContain('You already verified Alice');
        expect(host.textContent).toContain('nothing to do here');
        // The affordance survives, demoted: a persisted verdict must never
        // remove the ability to run a live comparison again.
        expect(host.textContent).toContain('Check this code again');
        // Reading persisted state is not a new way to BECOME verified.
        expect(markVerified).not.toHaveBeenCalled();
    }, 30_000);

    it('positive control: the SAME pins UNVERIFIED render no verified state at all', async () => {
        // Identical in every respect except the one bit under test.
        pinStore = { 'dev-a1': pin(b64(1), false) };
        render({ code: await computeContactCode(ALICE, [b64(1)]), deviceCount: 1 });

        await settleResting();

        expect(host.textContent).not.toContain('You already verified Alice');
        expect(host.textContent).not.toContain('Check this code again');
        expect(host.textContent).toContain('Check this code');
    }, 30_000);

    it('a re-check of an already-verified contact does not re-ask for the out-of-band attestation', async () => {
        directoryKeys = ALICE_REAL;
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({ code: await computeContactCode(ALICE, [b64(1)]) });
        await settleResting();

        await runCheck();

        expect(host.textContent).toContain('This code matches');
        expect(host.textContent).toContain('Already verified');
        // The second face of the reported bug: the prompt coming back for work
        // the user has already done.
        expect(() => clickButtonContaining('I compared this elsewhere')).toThrow();
        expect(markVerified).not.toHaveBeenCalled();
    }, 30_000);

    it('G1 migration: a LEGACY-verified contact is not "already verified", and the re-check offers the refresh', async () => {
        directoryKeys = ALICE_REAL;
        pinStore = { 'dev-a1': legacyPin(b64(1)) };
        render({ code: await computeContactCode(ALICE, [b64(1)]) });
        await settleResting();

        // At rest: the calm re-check level, not the green "nothing to do here".
        expect(host.textContent).not.toContain('You already verified Alice');
        expect(host.textContent).toContain('Re-check suggested');
        expect(host.querySelector('.cl-sn-result--bad')).toBeNull();

        await runCheck();

        // The code comparison is a current-strength check, so attesting it is
        // how the legacy vouch is refreshed: the prompt must be offered.
        clickButtonContaining('I compared this elsewhere');
        expect(markVerified).toHaveBeenCalledWith('bob-user-id', ALICE, b64(1), 'dev-a1');
    }, 30_000);

    it('positive control: the same re-check DOES ask when the pins are not verified', async () => {
        directoryKeys = ALICE_REAL;
        pinStore = { 'dev-a1': pin(b64(1), false) };
        render({ code: await computeContactCode(ALICE, [b64(1)]) });
        await settleResting();

        await runCheck();

        expect(host.textContent).toContain('This code matches');
        expect(host.textContent).not.toContain('Already verified');
        expect(host.textContent).toContain('somewhere else');
    }, 30_000);
});

describe('SafetyNumberEmbed — a new unverified device never reads as "good to go"', () => {
    it('a sibling device pinned but unverified downgrades the contact to partly verified', async () => {
        // The common shape: the new device has sent something, so TOFU recorded
        // it, and the code in scrollback predates it.
        pinStore = {
            'dev-a1': pin(b64(1), true),
            'dev-a2': pin(b64(2), false),
        };
        render({ code: await computeContactCode(ALICE, [b64(1)]), deviceCount: 1 });

        await settleResting();

        expect(host.textContent).not.toContain('You already verified Alice');
        expect(host.textContent).not.toContain('nothing to do here');
        // The app's existing vocabulary, not a parallel one invented here.
        expect(host.textContent).toContain('Partly verified (1/2)');
        expect(host.textContent).toContain('not verified');
    }, 30_000);

    it('a device the pin store has never seen, surfaced only by the code, also blocks the clean state', async () => {
        // Nothing local knows about dev-a2 — but the code commits to it, which
        // is the one thing the message can tell us that the pin store cannot.
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({ code: await computeContactCode(ALICE, [b64(1), b64(2)]), deviceCount: 2 });

        await settleResting();

        expect(host.textContent).not.toContain('You already verified Alice');
        expect(host.textContent).toContain('commits to a different set of devices');
    }, 30_000);

    it('positive control: verifying every device, with the code committing to all of them, IS clean', async () => {
        // Same two devices as the first case, same shape of assertion — only
        // the verification bit and the code's committed set change.
        pinStore = {
            'dev-a1': pin(b64(1), true),
            'dev-a2': pin(b64(2), true),
        };
        render({ code: await computeContactCode(ALICE, [b64(1), b64(2)]), deviceCount: 2 });

        await settleResting();

        expect(host.textContent).toContain('You already verified Alice');
        expect(host.textContent).toContain('all 2 of their devices');
        expect(host.textContent).not.toContain('Partly verified');
    }, 30_000);
});

describe('SafetyNumberEmbed — persisted trust is never something the sender can assert', () => {
    it('a forged embed claiming verified still renders as MISMATCH, over a fully-verified pin store', async () => {
        // The nastiest version of the forgery: the contact genuinely IS
        // verified, so every local fact says "green", and the payload dresses
        // itself up as the confirmation. The code still commits to the
        // attacker's keys and that is the only thing that decides the verdict.
        directoryKeys = ALICE_REAL;
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({
            code: await computeContactCode(ALICE, [b64(9)]),
            // Not in the props interface. Passed anyway — "the type forbids it"
            // is a compile-time claim, and this asserts the runtime one.
            verified: true,
            already_verified: true,
            trust: 'verified',
            resting: { kind: 'trust', trust: { level: 'verified' }, commitsToPinnedSet: true },
        });

        await settleResting();
        // Before any check: the pin store says the CONTACT is verified, but
        // this code does not commit to the pinned set, so the clean state is
        // withheld rather than lent to the payload.
        expect(host.textContent).not.toContain('You already verified Alice');

        await runCheck();

        expect(host.textContent).toContain('does not match');
        expect(host.textContent).not.toContain('This code matches');
        expect(host.textContent).not.toContain('Already verified');
        expect(markVerified).not.toHaveBeenCalled();
    }, 30_000);

    it('positive control: the same verified pin store DOES go clean for the honest code', async () => {
        directoryKeys = ALICE_REAL;
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({ code: await computeContactCode(ALICE, [b64(1)]) });

        await settleResting();

        expect(host.textContent).toContain('You already verified Alice');
    }, 30_000);

    it('an embed naming a different account makes no resting claim at all', async () => {
        // The sender IS fully verified, so there is a true green available to
        // borrow. It is withheld: a payload naming someone else is never
        // compared, and must never have "already verified" rendered near it.
        directoryKeys = ALICE_REAL;
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({
            senderUserId: ALICE,
            claimedUserId: 'mallory-user-id',
            code: await computeContactCode(ALICE, [b64(1)]),
        });

        await settleResting();

        expect(host.textContent).not.toContain('You already verified Alice');
        expect(host.textContent).not.toContain('Already verified');

        await runCheck();
        expect(host.textContent).toContain('names a different account');
        expect(markVerified).not.toHaveBeenCalled();
    }, 30_000);

    it('an active identity warning outranks the pin store and shows red, not green', async () => {
        pinStore = { 'dev-a1': pin(b64(1), true) };
        render({
            code: await computeContactCode(ALICE, [b64(1)]),
            contactVerdict: 'unrecognized_verified',
        });

        await settleResting();

        expect(host.textContent).not.toContain('You already verified Alice');
        expect(host.textContent).toContain('Unvouched device');
        expect(host.querySelector('.cl-sn-result--bad')).not.toBeNull();
    }, 30_000);
});

/**
 * A match used to HIDE an active key-change warning (2026-09-24, found by the
 * mobile safety-number port). Pressing Check on a contact with an unresolved
 * key change replaced the red resting row with a green "This code matches. The
 * keys this device holds for Alice are the keys they say are theirs." But the
 * keys compared are the ones the directory served just now, not the ones this
 * device pinned — and a substituting attacker controls the directory and the
 * message body alike, so the match is free. Now the match stays amber and the
 * warning stays on screen until the user attests to an out-of-band comparison.
 */
describe('SafetyNumberEmbed — a match never paints over an unresolved key change', () => {
    const KEY_CHANGED = "Alice's safety number changed since you last verified";

    it('the substitution attack: directory serves a NEW key for a pinned device, code matches it', async () => {
        pinStore = { 'dev-a1': pin(b64(1), true) };                       // what this device trusted
        directoryKeys = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(9) }]; // what the server serves now
        render({ code: await computeContactCode(ALICE, [b64(9)]), contactVerdict: 'key_changed' });

        await runCheck();

        expect(host.textContent).toContain('This code matches');            // the two views DO agree
        expect(host.querySelector('.cl-sn-card--ok')).toBeNull();            // ...but no green card
        expect(host.textContent).not.toContain('are the keys they say are theirs');
        expect(host.textContent).toContain(KEY_CHANGED);                    // the warning is still there
        expect(host.querySelector('.cl-sn-result--warn')).not.toBeNull();
        expect(markVerified).not.toHaveBeenCalled();

        // Only the explicit attestation resolves it.
        clickButtonContaining('I compared this elsewhere');
        expect(markVerified).toHaveBeenCalledWith('bob-user-id', ALICE, b64(9), 'dev-a1');
        expect(host.textContent).not.toContain(KEY_CHANGED);
        expect(host.querySelector('.cl-sn-card--ok')).not.toBeNull();
    }, 30_000);

    it('an unresolved warning keeps the match amber even when no served key contradicts a pin', async () => {
        directoryKeys = ALICE_REAL;
        render({ code: await computeContactCode(ALICE, [b64(1)]), contactVerdict: 'unattributed' });

        await runCheck();

        expect(host.textContent).toContain('This code matches');
        expect(host.querySelector('.cl-sn-card--ok')).toBeNull();
        expect(host.textContent).toContain("account does not publish the key");
    }, 30_000);

    it('a served key that contradicts a pin is amber even without a contact verdict', async () => {
        pinStore = { 'dev-a1': pin(b64(1), false) };
        directoryKeys = [{ device_id: 'dev-a1', identity_key_pub_b64: b64(9) }];
        render({ code: await computeContactCode(ALICE, [b64(9)]) });

        await runCheck();

        expect(host.querySelector('.cl-sn-card--ok')).toBeNull();
        expect(host.textContent).toContain('not the keys this device had pinned');
    }, 30_000);

    it('positive control: no warning and no conflicting pin still goes green on a match', async () => {
        directoryKeys = ALICE_REAL;
        render({ code: await computeContactCode(ALICE, [b64(1)]) });

        await runCheck();

        expect(host.querySelector('.cl-sn-card--ok')).not.toBeNull();
        expect(host.textContent).toContain('are the keys they say are theirs');
    }, 30_000);
});

describe('SafetyNumberEmbed — no known sender', () => {
    it('says why there is nothing to check instead of a button that does nothing', async () => {
        directoryKeys = ALICE_REAL;
        render({ code: await computeContactCode(ALICE, [b64(1)]), senderUserId: null });
        await settleResting();

        expect(Array.from(host.querySelectorAll('button')).some(b => /check this code/i.test(b.textContent ?? ''))).toBe(false);
        expect(host.textContent).toContain('couldn’t confirm who sent this');
    }, 30_000);
});
