import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The send behind "Share mine back". It must apply the same ghost-device gate as
 * the modal's Send button: every withheld case has a twin that differs by one row
 * and does send, so "it never sends" cannot pass these.
 */
const b64 = (fill: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
const ME = 'bob-user-id';
const MY_DEV = 'bob-laptop';
const MY_PUB = b64(7);
const LAPTOP = { device_id: MY_DEV, identity_key_pub_b64: MY_PUB };
const PHONE = { device_id: 'bob-phone', identity_key_pub_b64: b64(8) };
const GHOST = { device_id: 'ghost-dev', identity_key_pub_b64: b64(66) };

let listing: { device_id: string; identity_key_pub_b64: string }[] = [];
let directoryDown = false;
let accountReady = true;

vi.mock('axios', () => ({
    default: {
        get: vi.fn(async () => {
            if (directoryDown) throw new Error('Network Error');
            return { data: listing };
        }),
    },
}));

const mem = new Map<string, string>();
vi.mock('./secureLocalStore', () => ({
    secureLocalStore: {
        getItem: (k: string) => mem.get(k) ?? null,
        setItem: (k: string, v: string) => { mem.set(k, v); },
        isAccountReady: () => accountReady,
    },
}));

const { shareOwnContactCode } = await import('./ownContactCode');
const { computeContactCode } = await import('./verificationCode');
const ledger = await import('./ownDeviceLedger');

function share(overrides: { getLocalIdentity?: () => Promise<string | null | undefined> } = {}) {
    const send = vi.fn(async () => {});
    const result = shareOwnContactCode({
        myUserId: ME,
        myDeviceId: MY_DEV,
        token: 't',
        getLocalIdentity: async () => MY_PUB,
        send,
        ...overrides,
    });
    return { send, result };
}

/** This install has already seen {laptop, phone}. */
function baseline() {
    ledger.observeOwnDevices(ME, { deviceId: MY_DEV, pub: MY_PUB },
        [LAPTOP, PHONE].map(r => ({ device_id: r.device_id, pub: r.identity_key_pub_b64 })), true);
}

beforeEach(() => {
    mem.clear();
    ledger._resetSession();
    listing = [LAPTOP, PHONE];
    directoryDown = false;
    accountReady = true;
});

describe('shareOwnContactCode', () => {
    it('control: sends the code over the whole listing, with the count, and nothing else', async () => {
        baseline();
        const { send, result } = share();
        await expect(result).resolves.toBe('sent');
        const expected = await computeContactCode(ME, [MY_PUB, PHONE.identity_key_pub_b64]);
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith(expected, 2);
    });

    it('first use baselines the listing and sends, the same as the modal', async () => {
        const { send, result } = share();
        await expect(result).resolves.toBe('sent');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('a ghost device in the listing withholds the code', async () => {
        baseline();
        listing = [LAPTOP, PHONE, GHOST];
        const { send, result } = share();
        await expect(result).resolves.toBe('needs_review');
        expect(send).not.toHaveBeenCalled();
    });

    it('confirming that device releases the code', async () => {
        baseline();
        listing = [LAPTOP, PHONE, GHOST];
        await share().result;
        ledger.confirmOwnDevice(ME, GHOST.device_id, GHOST.identity_key_pub_b64);
        const { send, result } = share();
        await expect(result).resolves.toBe('sent');
        expect(send).toHaveBeenCalledTimes(1);
    });

    it("a different key under this device's id withholds the code", async () => {
        baseline();
        listing = [{ device_id: MY_DEV, identity_key_pub_b64: b64(99) }, PHONE];
        const { send, result } = share();
        await expect(result).resolves.toBe('needs_review');
        expect(send).not.toHaveBeenCalled();
    });

    it.each([
        ['no local identity', () => { /* set by the override below */ }, { getLocalIdentity: async () => null }],
        ['directory unreachable', () => { directoryDown = true; }, {}],
        ['account store not ready', () => { accountReady = false; }, {}],
    ])('%s: fails rather than sending', async (_name, arrange, overrides) => {
        arrange();
        const { send, result } = share(overrides);
        await expect(result).rejects.toThrow();
        expect(send).not.toHaveBeenCalled();
    });

    it('this device missing from the listing withholds the code', async () => {
        baseline();
        listing = [];
        const { send, result } = share();
        await expect(result).resolves.toBe('needs_review');
        expect(send).not.toHaveBeenCalled();
    });

    it('a failed send surfaces as a failure, so the card can offer a retry', async () => {
        baseline();
        await expect(shareOwnContactCode({
            myUserId: ME, myDeviceId: MY_DEV, token: 't',
            getLocalIdentity: async () => MY_PUB,
            send: async () => { throw new Error('offline'); },
        })).rejects.toThrow('offline');
    });
});
