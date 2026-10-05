/**
 * The device list every contact trust badge is derived from: the pin store,
 * plus any device the directory currently publishes for the contact that the
 * pins have never recorded (counted as unverified). See `addUnpinnedPublished`
 * in contactTrust.ts and docs/ghost-device.md §2.4.
 *
 * One helper so the chat-header shield and the incoming-call badge cannot
 * disagree about which devices a contact has.
 */
import { getKnownDevices } from './keyVerification';
import { addUnpinnedPublished, pinsToTrustDevices, type DeviceTrust } from './contactTrust';
import { publishedDevicesFor } from './publishedDeviceSets';

export function contactTrustDevices(myUserId: string, theirUserId: string): DeviceTrust[] {
    const known = getKnownDevices(myUserId, theirUserId);
    return addUnpinnedPublished(
        pinsToTrustDevices(known),
        Object.values(known).map(r => r.pub),
        publishedDevicesFor(theirUserId),
    );
}
