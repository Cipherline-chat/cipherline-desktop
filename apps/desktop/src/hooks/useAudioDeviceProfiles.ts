/**
 * Per-device audio settings, live (see utils/audioDeviceProfiles.ts for what is
 * remembered per device and how a device is recognised).
 *
 * Lives inside useVoiceSettings, i.e. for the whole signed-in session, in a
 * call or not. Whenever the device in use may have changed — a devicechange
 * (headset plugged in, Windows default moved; debounced, a plug-in fires
 * several), a device pick from Settings or the call's right-click menu, the
 * window regaining focus, or a capture having just been granted — it resolves
 * the microphone and speakers actually in use (a "follow the default" choice
 * resolves to the real device behind Chromium's "default" row) and:
 *   - a device seen for the first time gets a profile that INHERITS the current
 *     settings (nothing changes abruptly);
 *   - a known device that just became the one in use has its settings applied
 *     to the live settings. In a call that is the same settings → processor
 *     path as moving a slider: volumes, gate, noise suppression, auto gain and
 *     EQ update the running voice chain; echo cancellation re-opens the capture
 *     on the same sender (restartTrack — no unpublish, the call never drops);
 *     output volume moves the master gain.
 * And a setting the user changes is saved into the profile of the device it
 * applies to (recordUserChange, called from useVoiceSettings' setters — never
 * for an applied profile, so a switch can never copy one device's values onto
 * another).
 *
 * Storage: secureLocalStore `cipherline_audio_device_profiles_<uid>` (per-account
 * subkey). Written only once the account's records are loaded
 * (isAccountReady) and only when something actually changed — the loaded value
 * is never written back on mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import type { VoiceSettings } from './useVoiceSettings';
import {
    audioDeviceProfilesKey, connectedProfileKeys, findDeviceProfile, forgetDeviceProfile, kindsTouched,
    normalizeDeviceLabel, parseDeviceProfiles, profileDiff, recordProfileChange, rememberActiveDevice,
    resolveActiveDevice, seedDeviceProfiles,
    type AudioDeviceKind, type DeviceProfiles,
} from '../utils/audioDeviceProfiles';

/** Fire to make the store look at the devices again (e.g. right after a capture
 *  was granted, when labels first become readable). */
export const AUDIO_DEVICES_RESYNC_EVENT = 'cipherline:audio-devices-resync';
export function requestAudioDeviceResync(): void {
    try { window.dispatchEvent(new Event(AUDIO_DEVICES_RESYNC_EVENT)); } catch { /* no window (tests) */ }
}

const DEVICECHANGE_DEBOUNCE_MS = 400;
/** lastUsedAt of the device in use is refreshed at most this often. */
const TOUCH_EVERY_MS = 10 * 60 * 1000;

export interface ActiveAudioDevice {
    key: string;
    label: string;
    /** In use because it is the system default. */
    viaDefault: boolean;
}

export interface AudioDeviceProfilesApi {
    /** Profiles loaded for the signed-in account. */
    ready: boolean;
    profiles: DeviceProfiles | null;
    activeInput: ActiveAudioDevice | null;
    activeOutput: ActiveAudioDevice | null;
    /** Profile keys of the devices plugged in right now. */
    connected: { input: ReadonlySet<string>; output: ReadonlySet<string> };
    /** Edit one device's settings (the in-use device's change also applies live). */
    updateProfile: (kind: AudioDeviceKind, key: string, partial: Partial<VoiceSettings>) => void;
    /** Forget a device that is not in use. */
    forget: (kind: AudioDeviceKind, key: string) => void;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function useAudioDeviceProfiles(
    userId: string | null | undefined,
    settings: VoiceSettings,
    /** Merge into the live settings WITHOUT recording it as a user change. */
    applySettings: (partial: Partial<VoiceSettings>) => void,
): { api: AudioDeviceProfilesApi; recordUserChange: (partial: Partial<VoiceSettings>) => void } {
    const [profiles, setProfiles] = useState<DeviceProfiles | null>(null);
    const [active, setActive] = useState<{ input: ActiveAudioDevice | null; output: ActiveAudioDevice | null }>({ input: null, output: null });
    const [connected, setConnected] = useState<{ input: ReadonlySet<string>; output: ReadonlySet<string> }>({ input: EMPTY_SET, output: EMPTY_SET });

    const uid = userId || null;
    const uidRef = useRef(uid);
    const settingsRef = useRef(settings);
    const applyRef = useRef(applySettings);
    // Latest values for the async resync / callbacks. Declared before every
    // effect below, so they are current by the time any of those run.
    useEffect(() => {
        uidRef.current = uid;
        settingsRef.current = settings;
        applyRef.current = applySettings;
    });
    const profilesRef = useRef<DeviceProfiles | null>(null);
    const activeRef = useRef(active);
    const seqRef = useRef(0);

    const commit = useCallback((next: DeviceProfiles, persist: boolean) => {
        profilesRef.current = next;
        setProfiles(next);
        const u = uidRef.current;
        if (!persist || !u || !secureLocalStore.isAccountReady(u)) return;
        try { secureLocalStore.setItem(`cipherline_audio_device_profiles_${u}`, JSON.stringify(next)); } catch { /* locked store: best-effort */ }
    }, []);

    const resync = useCallback(async () => {
        const u = uidRef.current;
        if (!u || !profilesRef.current || !secureLocalStore.isAccountReady(u)) return;
        const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
        if (!md?.enumerateDevices) return;
        const seq = ++seqRef.current;
        let raw: MediaDeviceInfo[];
        try { raw = await md.enumerateDevices(); } catch { return; }
        if (seq !== seqRef.current || u !== uidRef.current || !profilesRef.current) return;

        const s = settingsRef.current;
        const now = Date.now();
        let next = profilesRef.current;
        let changed = false;
        const apply: Partial<VoiceSettings> = {};
        const nextActive = { ...activeRef.current };
        for (const kind of ['input', 'output'] as const) {
            const device = kind === 'input'
                ? resolveActiveDevice(raw, 'input', s.micDeviceId, { label: s.micDeviceLabel, groupId: s.micDeviceGroupId })
                : resolveActiveDevice(raw, 'output', s.speakerDeviceId, { label: s.speakerDeviceLabel, groupId: s.speakerDeviceGroupId });
            if (!device) continue; // no labels yet (pre-permission): keep what we had
            const prevKey = activeRef.current[kind]?.key ?? null;
            const found = findDeviceProfile(next, kind, device);
            // "Last used" moves when the device takes over from another one, or
            // when it is stale; re-seeing the same device at boot writes nothing.
            const switched = prevKey !== null && normalizeDeviceLabel(device.label) !== prevKey;
            const touch = switched || !found || now - next[kind][found.key].lastUsedAt > TOUCH_EVERY_MS;
            const r = rememberActiveDevice(next, kind, device, s, now, touch);
            next = r.profiles;
            changed = changed || r.changed;
            if (!r.created && r.key !== prevKey) {
                const stored = next[kind][r.key]?.settings;
                if (stored) Object.assign(apply, profileDiff(kind, s, stored));
            }
            nextActive[kind] = { key: r.key, label: device.label, viaDefault: device.viaDefault };
        }
        activeRef.current = nextActive;
        setActive(prev =>
            prev.input?.key === nextActive.input?.key && prev.input?.label === nextActive.input?.label && prev.input?.viaDefault === nextActive.input?.viaDefault
            && prev.output?.key === nextActive.output?.key && prev.output?.label === nextActive.output?.label && prev.output?.viaDefault === nextActive.output?.viaDefault
                ? prev : nextActive);
        if (changed) commit(next, true);
        setConnected(connectedProfileKeys(next, raw));
        if (Object.keys(apply).length) applyRef.current(apply);
    }, [commit]);

    // Load (and, the first time, seed) the account's profiles once its records are in memory.
    useEffect(() => {
        profilesRef.current = null;
        activeRef.current = { input: null, output: null };
        setProfiles(null);
        setActive({ input: null, output: null });
        setConnected({ input: EMPTY_SET, output: EMPTY_SET });
        if (!uid) return;
        let cancelled = false;
        const load = () => {
            if (cancelled || uidRef.current !== uid || !secureLocalStore.isAccountReady(uid)) return;
            let loaded: DeviceProfiles | null = null;
            try { loaded = parseDeviceProfiles(secureLocalStore.getItem(audioDeviceProfilesKey(uid)), settingsRef.current); } catch { loaded = null; }
            if (loaded) commit(loaded, false);
            else commit(seedDeviceProfiles(settingsRef.current, Date.now()), true); // migration: first run
            void resync();
        };
        if (secureLocalStore.isAccountReady(uid)) load();
        else secureLocalStore.whenAccountReady().then(load, () => {});
        return () => { cancelled = true; };
    }, [uid, commit, resync]);

    // Hardware changed / app regained focus / a capture was just granted.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = null; void resync(); }, DEVICECHANGE_DEBOUNCE_MS);
        };
        const now = () => { void resync(); };
        const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
        md?.addEventListener?.('devicechange', schedule);
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', schedule);
            window.addEventListener(AUDIO_DEVICES_RESYNC_EVENT, now);
        }
        return () => {
            if (timer) clearTimeout(timer);
            md?.removeEventListener?.('devicechange', schedule);
            if (typeof window !== 'undefined') {
                window.removeEventListener('focus', schedule);
                window.removeEventListener(AUDIO_DEVICES_RESYNC_EVENT, now);
            }
        };
    }, [resync]);

    // A different device was picked (Settings or the call menu): its settings come back.
    const { micDeviceId, micDeviceLabel, speakerDeviceId, speakerDeviceLabel } = settings;
    useEffect(() => { void resync(); }, [micDeviceId, micDeviceLabel, speakerDeviceId, speakerDeviceLabel, resync]);

    const recordUserChange = useCallback((partial: Partial<VoiceSettings>) => {
        let next = profilesRef.current;
        if (!next) return;
        const now = Date.now();
        for (const kind of kindsTouched(partial)) {
            const key = activeRef.current[kind]?.key;
            if (key) next = recordProfileChange(next, kind, key, partial, now);
        }
        if (next !== profilesRef.current) commit(next, true);
    }, [commit]);

    const updateProfile = useCallback((kind: AudioDeviceKind, key: string, partial: Partial<VoiceSettings>) => {
        const cur = profilesRef.current;
        if (!cur) return;
        const next = recordProfileChange(cur, kind, key, partial, Date.now());
        if (next !== cur) commit(next, true);
        if (activeRef.current[kind]?.key === key) {
            const stored = next[kind][key]?.settings;
            if (stored) {
                const diff = profileDiff(kind, settingsRef.current, stored);
                if (Object.keys(diff).length) applyRef.current(diff);
            }
        }
    }, [commit]);

    const forget = useCallback((kind: AudioDeviceKind, key: string) => {
        const cur = profilesRef.current;
        if (!cur || activeRef.current[kind]?.key === key) return; // the one in use would be re-learnt at once
        const next = forgetDeviceProfile(cur, kind, key);
        if (next !== cur) commit(next, true);
    }, [commit]);

    const api = useMemo<AudioDeviceProfilesApi>(() => ({
        ready: profiles !== null,
        profiles,
        activeInput: active.input,
        activeOutput: active.output,
        connected,
        updateProfile,
        forget,
    }), [profiles, active, connected, updateProfile, forget]);

    return { api, recordUserChange };
}
