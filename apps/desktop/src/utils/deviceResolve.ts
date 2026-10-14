/**
 * Finding the device a stored selection refers to, when its id no longer
 * matches anything.
 *
 * A picked mic or speaker is persisted as its `deviceId`. Chromium derives that
 * id from the OS endpoint id, salted per origin, and on Windows the endpoint id
 * itself can change under a device that is still plugged in (a driver update,
 * the same USB headset in a different port, a Bluetooth re-pair). The stored id
 * then points at nothing, and every consumer quietly fell back to the system
 * default — for the mic that was CallPane's `{exact:id}` failing and
 * livekit-client retrying with `{ideal:id}` (which Chromium ignores, see
 * deviceSwitch.ts), for the Settings pane an outright reset of the setting to
 * "Default".
 *
 * So the label and groupId are stored alongside the id at selection time, and
 * a stale id resolves to the device that still carries them:
 *
 *   1. the stored id itself, when it is listed;
 *   2. else the device with the same groupId AND label (the same physical
 *      device under a new id);
 *   3. else the one device with that label, if exactly one has it — two
 *      identical headsets share a label, so an ambiguous label matches nothing.
 *
 * Chromium's synthetic `default` / `communications` rows are never a match:
 * they carry the label of whatever device the OS currently prefers.
 *
 * Labels can contain a person's name ("Dawson's AirPods"): they are stored only
 * inside the encrypted voice settings and never logged.
 */

export interface DeviceHint {
    label?: string;
    groupId?: string;
}

export type DeviceMatch = 'exact' | 'group_label' | 'label' | 'none';

const SYNTHETIC_IDS = new Set(['default', 'communications']);

/** The label/groupId worth remembering for a picked device ('' when unknown). */
export function deviceHintOf(device: Pick<MediaDeviceInfo, 'label' | 'groupId'> | null | undefined): Required<DeviceHint> {
    return { label: device?.label ?? '', groupId: device?.groupId ?? '' };
}

/**
 * The listed device a stored selection refers to, or null. `storedId` '' (follow
 * the system default) is never resolved here — that is the caller's default.
 */
export function findStoredDevice(
    storedId: string,
    hint: DeviceHint | null | undefined,
    available: readonly MediaDeviceInfo[],
): { device: MediaDeviceInfo | null; match: DeviceMatch } {
    if (!storedId) return { device: null, match: 'none' };
    const exact = available.find(d => d.deviceId === storedId);
    if (exact) return { device: exact, match: 'exact' };
    const label = hint?.label;
    if (!label) return { device: null, match: 'none' };
    const sameLabel = available.filter(d => !SYNTHETIC_IDS.has(d.deviceId) && d.deviceId !== '' && d.label === label);
    if (hint?.groupId) {
        const sameGroup = sameLabel.filter(d => d.groupId === hint.groupId);
        if (sameGroup.length === 1) return { device: sameGroup[0], match: 'group_label' };
    }
    if (sameLabel.length === 1) return { device: sameLabel[0], match: 'label' };
    return { device: null, match: 'none' };
}
