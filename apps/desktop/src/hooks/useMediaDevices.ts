import { useCallback, useEffect, useState } from 'react';
import { hasRealDeviceInfo } from '../utils/audioInput';

/**
 * useMediaDevices — deduped, labelled input/output/camera lists for UI
 * pickers (the settings pane, and the call-control right-click menus).
 *
 * Extracted out of VoiceVideoSettings.tsx, which had this enumeration
 * privately — the only place in the app that deduped the raw device list and
 * gave it real labels. SidebarConference.tsx has its OWN, separate raw
 * enumerations that feed live device-switching logic; those stay where they
 * are and stay undeduped on purpose (switching logic needs to see 'default'/
 * 'communications' rows, UI pickers don't want to show them twice).
 *
 * Convention, shared with utils/audioInput.ts: an empty string `''` means
 * "follow the system default" and is what gets persisted. Never store the
 * literal device id `'default'` — that's audioInput.ts's
 * DEFAULT_AUDIO_INPUT_ID, used only when actually opening a capture.
 */

/** Drop the two synthetic "meta" rows Chromium exposes (`default`,
 *  `communications`) and collapse duplicate labels — some hardware reports
 *  the same physical device more than once under different ids. */
export function dedupeDevices(devices: readonly MediaDeviceInfo[]): MediaDeviceInfo[] {
    const seen = new Set<string>();
    return devices.filter(d => {
        if (d.deviceId === 'default' || d.deviceId === 'communications') return false;
        const key = d.label || d.deviceId;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/** Partition a raw enumerateDevices() result into the three deduped lists a
 *  UI picker wants. Pure — the DOM call happens at the caller, this just
 *  shapes the result, which is what makes it unit-testable (vitest here has
 *  no DOM). */
export function partitionMediaDevices(devices: readonly MediaDeviceInfo[]): {
    inputDevices: MediaDeviceInfo[];
    outputDevices: MediaDeviceInfo[];
    videoDevices: MediaDeviceInfo[];
} {
    return {
        inputDevices: dedupeDevices(devices.filter(d => d.kind === 'audioinput')),
        outputDevices: dedupeDevices(devices.filter(d => d.kind === 'audiooutput')),
        videoDevices: dedupeDevices(devices.filter(d => d.kind === 'videoinput')),
    };
}

/** A device's display label, with the same fallback everywhere a device
 *  shows up in UI: some platforms/permissions states still hand back a real
 *  id with an empty label. */
export function deviceLabel(d: MediaDeviceInfo): string {
    return d.label || `Device ${d.deviceId.slice(0, 8)}`;
}

/** One row of a device-picker menu. `id` uses the same `''` = "follow the
 *  system default" convention as everything else here. */
export interface DeviceRowModel {
    id: string;
    label: string;
    checked: boolean;
}

/**
 * The row model behind every device-picker menu (settings pane + the
 * control-bar right-click menus): a "follow the system default" row, then one
 * row per real device.
 *
 * Pure and UI-framework-free on purpose. Vitest runs in a `node` environment
 * in this app and only collects `*.test.ts`, so decision logic that lives
 * inside a `.tsx` component is effectively untestable — this is the part worth
 * testing, and the caller only has to map rows onto its own menu item type.
 *
 * The `hasRealDeviceInfo` gate lives here rather than at each call site: before
 * media permission is granted Chromium returns one blank placeholder per kind,
 * and rendering that as a selectable device shows the user a garbage row. When
 * the list is placeholders (or empty) the menu is still meaningful — it just
 * degrades to the single "default" row, which correctly reads as "you're on the
 * system default and there's nothing else to choose."
 */
export function buildDeviceRowModel(
    devices: readonly MediaDeviceInfo[],
    currentId: string,
    defaultLabel: string,
): DeviceRowModel[] {
    const rows: DeviceRowModel[] = [
        { id: '', label: defaultLabel, checked: currentId === '' },
    ];
    if (!hasRealDeviceInfo(devices)) return rows;
    for (const d of devices) {
        rows.push({ id: d.deviceId, label: deviceLabel(d), checked: currentId === d.deviceId });
    }
    return rows;
}

export function useMediaDevices() {
    const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
    const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
    const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([]);

    const refresh = useCallback(async () => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const next = partitionMediaDevices(devices);
            setInputDevices(next.inputDevices);
            setOutputDevices(next.outputDevices);
            setVideoDevices(next.videoDevices);
        } catch { /* enumeration can throw pre-permission on some platforms */ }
    }, []);

    useEffect(() => {
        refresh();
        navigator.mediaDevices.addEventListener('devicechange', refresh);
        return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
    }, [refresh]);

    return { inputDevices, outputDevices, videoDevices, refresh };
}
