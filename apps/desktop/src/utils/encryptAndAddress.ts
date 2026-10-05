/**
 * Encrypt a message for a set of recipient devices AND address it correctly.
 *
 * Every DM/group send site used to do these as two independent steps: call
 * `encryptMessage` (which silently drops any device it can't wrap — missing
 * SPK, invalid signature, etc.), then separately build `recipient_device_ids`
 * from the ORIGINAL, unfiltered device list. The server stored an envelope
 * for every id in that list regardless of whether it was ever actually
 * encrypted to — permanently undecryptable by construction, and the
 * dominant cause of one-way DM/group delivery (RC-2).
 *
 * This wraps `encryptMessageV2` (which reports back which devices actually
 * got wrapped) so every call site addresses exactly that set, with no
 * separate bookkeeping to get wrong.
 */

export interface AddressableDevice {
    device_id: string;
    spk_pub_b64: string;
    sig_b64?: string;
    identity_pub_b64?: string;
}

export interface EncryptAndAddressResult {
    ciphertext_b64: string;
    /** Exactly the devices whose entry made it into the envelope. Safe to
     *  send as-is for `recipient_device_ids` — never the input `devices` list. */
    recipient_device_ids: string[];
    /** Devices from the input list that did NOT get wrapped (and therefore
     *  must not receive this message at all). Empty in the common case. */
    skipped: string[];
}

/** Split `devices` into (addressable, skipped) given the wrapped-id set encryptForDevices reported. */
export function selectAddressableDevices<T extends { device_id: string }>(
    devices: T[],
    wrappedDeviceIds: string[],
): { addressable: T[]; skipped: T[] } {
    const wrapped = new Set(wrappedDeviceIds);
    const addressable: T[] = [];
    const skipped: T[] = [];
    for (const d of devices) (wrapped.has(d.device_id) ? addressable : skipped).push(d);
    return { addressable, skipped };
}

export async function encryptAndAddress(
    contentJson: string,
    senderUserId: string,
    devices: AddressableDevice[],
    senderDeviceId?: string,
): Promise<EncryptAndAddressResult> {
    if (!window.electronAPI) throw new Error('[E2EE] electronAPI unavailable');
    const { envelope_b64, wrapped_device_ids } = await window.electronAPI.encryptMessageV2(contentJson, senderUserId, devices, senderDeviceId);
    const { skipped } = selectAddressableDevices(devices, wrapped_device_ids);
    return {
        ciphertext_b64: envelope_b64,
        recipient_device_ids: wrapped_device_ids,
        skipped: skipped.map(d => d.device_id),
    };
}
