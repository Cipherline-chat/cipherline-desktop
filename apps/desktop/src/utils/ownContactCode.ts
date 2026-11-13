/**
 * The user's OWN contact verification code, and the one rule for when it may
 * leave this device.
 *
 * Both ways of sharing it read from here: the Safety verification modal, and
 * "Share mine back" on a received safety-code card. Keeping them on one path is
 * the point. The ghost-device check (docs/ghost-device.md) must run on the exact
 * listing the code hashes, so a second copy of this sequence would be a second
 * place for a code to go out without it.
 */
import axios from 'axios';
import { apiUrl } from './apiPath';
import { computeContactCode } from './verificationCode';
import {
    observeOwnDevices,
    loadOwnLedger,
    assessOwnDeviceSet,
    codeMayBeShown,
    type ListedDevice,
    type OwnSetVerdict,
} from './ownDeviceLedger';

export interface OwnContactCode {
    /** The directory's listing of this account's devices, as hashed into `code`. */
    rows: ListedDevice[];
    /** `null` while the account's local store is not ready, so nothing is judged yet. */
    verdict: OwnSetVerdict | null;
    /** `null` when the account lists no devices. */
    code: string | null;
}

/** Fetch this account's device listing, judge it, and hash that same listing. */
export async function loadOwnContactCode(args: {
    myUserId: string;
    myDeviceId: string | null;
    localPub: string;
    token: string | null;
}): Promise<OwnContactCode> {
    const { myUserId, myDeviceId, localPub, token } = args;
    const res = await axios.get(
        apiUrl`/keys/identity_keys?user_id=${myUserId}`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    const bundles: { device_id: string; identity_key_pub_b64: string }[] = res.data ?? [];
    const rows: ListedDevice[] = bundles.map(b => ({ device_id: b.device_id, pub: b.identity_key_pub_b64 }));
    const self = { deviceId: myDeviceId ?? '', pub: localPub };
    observeOwnDevices(myUserId, self, rows, true);
    const ledger = loadOwnLedger(myUserId);
    return {
        rows,
        verdict: ledger === undefined ? null : assessOwnDeviceSet(ledger, rows, self),
        code: rows.length ? await computeContactCode(myUserId, rows.map(r => r.pub)) : null,
    };
}

/**
 * - `sent`: the code went out.
 * - `needs_review`: this account's device list has something the user has not
 *   vouched for, so the code was withheld. Only the Safety verification modal
 *   can resolve that; the caller opens it.
 */
export type ShareOwnCodeOutcome = 'sent' | 'needs_review';

/**
 * Send the user's own code through `send`, under the same rule the modal applies
 * to its Send button. Throws when the answer is not known yet (no local identity,
 * cold store, directory unreachable), which the caller offers as a retry.
 */
export async function shareOwnContactCode(args: {
    myUserId: string;
    myDeviceId: string | null;
    token: string | null;
    getLocalIdentity: () => Promise<string | null | undefined>;
    send: (code: string, deviceCount: number) => Promise<void>;
}): Promise<ShareOwnCodeOutcome> {
    const localPub = await args.getLocalIdentity();
    if (!localPub) throw new Error('Local identity key not found');
    const own = await loadOwnContactCode({
        myUserId: args.myUserId, myDeviceId: args.myDeviceId, localPub, token: args.token,
    });
    if (!own.verdict) throw new Error('Account store not ready');
    if (!own.code || !codeMayBeShown(own.verdict)) return 'needs_review';
    await args.send(own.code, own.rows.length);
    return 'sent';
}
