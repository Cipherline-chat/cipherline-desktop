// @vitest-environment jsdom
/**
 * Owner report 2026-11-25: "he called me on his iphone and the encryption keys
 * for the call never came so I couldn't connect." The keys DID come — three
 * times — and were refused by the sender-trust gate (a verified contact's
 * unverified new device). The request schedule ran its 5 sends and stopped, so
 * even after the user reviewed the device nothing asked for the key again.
 *
 * Drives the real hook (jsdom, mocked axios + encryptAndAddress): a bumped
 * `rerequestNonce` must start a fresh schedule for a call that is still keyless.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { sent } = vi.hoisted(() => ({ sent: { requests: 0, devicesGets: [] as string[] } }));
vi.mock('axios', () => ({
    default: {
        get: vi.fn(async (url: string) => {
            if (/\/calls\/[^/]+\/status$/.test(url)) return { data: { active: true, participant_ids: ['u-caller'] } };
            if (/\/conversations\/[^/]+\/devices/.test(url)) {
                sent.devicesGets.push(url);
                return { data: [{ device_id: 'd-caller-phone', spk_pub_b64: 'spk', user_id: 'u-caller' }, { device_id: 'd-other', spk_pub_b64: 'spk', user_id: 'u-bystander' }] };
            }
            return { data: [] };
        }),
        post: vi.fn(async () => ({ data: {} })),
    },
}));
vi.mock('../utils/encryptAndAddress', () => ({
    encryptAndAddress: vi.fn(async (json: string, _me: string, devices: { device_id: string }[]) => {
        if (JSON.parse(json).type === 'call_key_request') sent.requests++;
        return { ciphertext_b64: 'ct', recipient_device_ids: devices.map(d => d.device_id) };
    }),
}));
vi.mock('../utils/crypto', () => ({ generateCallKey: vi.fn(async () => 'A'.repeat(43) + '=') }));
vi.mock('../constants', async (orig) => ({ ...(await orig<typeof import('../constants')>()), API_BASE: 'http://api/v1' }));

const { useCallKeySharing } = await import('./useCallKeySharing');
const { CallKeyStore } = await import('../utils/callKeyStore');
const { encryptAndAddress } = await import('../utils/encryptAndAddress');
type Args = Parameters<typeof useCallKeySharing>[0];

const CALL = { id: 'call-1', conversation_id: 'conv-1' };

function Probe(props: { args: Args }) {
    useCallKeySharing(props.args);
    return null;
}

let root: Root;
let host: HTMLElement;
const storeRef = { current: new CallKeyStore() };
const args = (nonce: number): Args => ({
    token: 't', deviceId: 'd-me', userId: 'u-me', bundleReady: true,
    activeCall: CALL,
    roomConnectedCallId: null,
    storeRef,
    keyEpoch: 0,
    // Keyless (no ACCEPTED key), but "any" so the lone-joiner MINT path stays out of the count.
    readKeyState: () => ({ accepted: false, any: true }),
    recordGeneratedKey: () => 'stored',
    isConversationMember: () => true,
    rerequestNonce: nonce,
});

async function advance(ms: number) {
    for (let t = 0; t < ms; t += 500) {
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    sent.requests = 0;
    sent.devicesGets = [];
    storeRef.current = new CallKeyStore();
    host = document.createElement('div');
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
});

describe('useCallKeySharing: re-request after the refusal is resolved', () => {
    it('a keyless call stops asking after 5 requests (control)', async () => {
        await act(async () => root.render(React.createElement(Probe, { args: args(0) })));
        await advance(30_000);
        expect(sent.requests).toBe(5);
    });

    it('a bumped rerequestNonce starts a fresh schedule, addressed only to the call participant', async () => {
        await act(async () => root.render(React.createElement(Probe, { args: args(0) })));
        await advance(30_000);
        expect(sent.requests).toBe(5);
        await act(async () => root.render(React.createElement(Probe, { args: args(1) })));
        await advance(1_500);
        expect(sent.requests).toBe(6);
        // A key request carries no secret: it does not burn one-time prekeys, and goes to the participant's devices only.
        expect(sent.devicesGets.at(-1)).not.toContain('claim_otp');
        const lastCall = vi.mocked(encryptAndAddress).mock.calls.at(-1)!;
        expect(lastCall[2].map(d => d.device_id)).toEqual(['d-caller-phone']);
    });

    it('re-rendering with the same nonce sends nothing more', async () => {
        await act(async () => root.render(React.createElement(Probe, { args: args(0) })));
        await advance(30_000);
        await act(async () => root.render(React.createElement(Probe, { args: args(0) })));
        await advance(10_000);
        expect(sent.requests).toBe(5);
    });
});
