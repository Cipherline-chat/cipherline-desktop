import { useEffect, useRef, useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';
import { getScreenShareSession, subscribeScreenShareSession } from './screenShareDiagnostics';

/**
 * "Screen sharing on Linux is new" — a one-time card shown the first time this device shares its screen on Linux
 * (components/diagnostics/LinuxShareIntroCard.tsx).
 *
 * Owner, 2026-11-10: be honest that AMD and Intel are less tested than NVIDIA, ask for test data, and show (a short
 * video) how to send a quality report. Every Linux device sees it ONCE, whatever its GPU — an NVIDIA share is new too.
 *
 * Flow: SidebarConference calls useLinuxShareIntroTrigger(sharing, encoder) -> the first time `sharing` turns true on
 * Linux the card becomes PENDING -> the card shows when the window is next visible and focused (never over a game the
 * user is sharing, never delaying the share: nothing here is awaited by the share path) -> only at that moment is the
 * device flag written. A card that never got on screen (app quit while unfocused) is offered again on the next share.
 *
 * GPU variant (2026-11-16, owner): Windows and macOS devices whose primary GPU is AMD or Intel get the SAME card with
 * different copy ("Help us make screen sharing smoother") the first time their share goes live — NVIDIA is where share
 * tuning has the most data, AMD/Intel need more. It reuses this module's state machine, the card and the how-to clip;
 * only the trigger (useGpuShareIntroTrigger, reads the share session's GPU list), the decision (shouldOfferGpuShareIntro)
 * and the flag (GPU_SHARE_INTRO_KEY) are its own. Linux never gets it (Linux has its own card, above).
 *
 * The flag is device-global (no user id in the key — any account on this computer has now been told) and is NOT in
 * backups (backupRegistry.ts): it is about THIS machine's first share, a new machine should say it again.
 */
export const LINUX_SHARE_INTRO_KEY = 'cipherline_linux_share_intro_seen';
/** Own flag for the Windows/macOS AMD/Intel card — never the Linux key (backupRegistry.ts: excluded, per machine). */
export const GPU_SHARE_INTRO_KEY = 'cipherline_gpu_share_intro_seen';

/** Which copy the card wears. 'gpu' = Windows/macOS on AMD or Intel graphics. */
export type ShareIntroVariant = 'linux' | 'gpu';
/** The only vendors the GPU card is for. */
export type GpuShareVendor = 'AMD' | 'Intel';

/** Which share path actually engaged: the native helper's NVENC / VA-API encoder, or the normal (Chromium) share. */
export type ShareBackendKind = 'nvenc' | 'vaapi' | 'normal';

export interface LinuxShareIntroState {
    backend: ShareBackendKind;
    /** On screen now (the flag is written at the moment this turns true). */
    shown: boolean;
    /** Set ONLY for the GPU card (Windows/macOS, AMD or Intel); absent = the Linux card. */
    gpuVendor?: GpuShareVendor;
}

export function shareIntroVariant(s: Pick<LinuxShareIntroState, 'gpuVendor'>): ShareIntroVariant {
    return s.gpuVendor ? 'gpu' : 'linux';
}

/** The native pipeline's encoder name ('nvenc' / 'vaapi', native/share-encoder ClEncoderOps.name) -> backend. */
export function backendFromEncoder(encoder: string | null | undefined): ShareBackendKind {
    return encoder === 'nvenc' ? 'nvenc' : encoder === 'vaapi' ? 'vaapi' : 'normal';
}

/** Pure decision: offer the card for a share that just started? */
export function shouldOfferLinuxShareIntro(platform: string | undefined, seen: boolean, alreadyOffered: boolean): boolean {
    return platform === 'linux' && !seen && !alreadyOffered;
}

/** PCI vendor ids of software / virtual adapters, never "a real GPU": WARP / Basic Render, SwiftShader (Google), VMware, VirtualBox, Parallels, virtio (Red Hat / QEMU). */
const SOFTWARE_OR_VIRTUAL_VENDOR_IDS: ReadonlySet<number> = new Set([0x1414, 0x1ae0, 0x15ad, 0x80ee, 0x1ab8, 0x1af4, 0x1b36]);
const AMD_VENDOR_IDS: ReadonlySet<number> = new Set([0x1002, 0x1022]);
const INTEL_VENDOR_ID = 0x8086;
const NVIDIA_VENDOR_ID = 0x10de;

/** What the renderer receives per GPU (electron/capture-flags.ts summarizeGpuDevices -> MainShareDiagnostics.gpus). */
export interface ShareGpuInfo { vendor?: string; vendorId?: number; active?: boolean }

/**
 * The vendor of the REAL GPU Chromium renders on, when it is AMD or Intel; null in every other case, so "can't tell"
 * never shows the card. Reads, per GPU: `vendorId` (the identity, never the display string), `active` (the adapter in
 * use); and once main's `videoEncode` (Chromium's video-encode feature status).
 *
 *  1. No GPU list / empty -> null. `videoEncode` present and not 'enabled*' (disabled_software, disabled_off,
 *     unavailable_*: hardware acceleration is off) -> null. A missing videoEncode is "can't see", not a block.
 *  2. Software / virtual adapters (SOFTWARE_OR_VIRTUAL_VENDOR_IDS) and Microsoft-named ones are dropped; nothing real left -> null.
 *  3. NVIDIA among the real GPUs: the card needs positive proof it is NOT the one in use: some real GPU is `active`
 *     and no NVIDIA one is. NVIDIA active, or an Intel+NVIDIA pair with no active flag (can't tell) -> null.
 *  4. Otherwise the candidate is the ACTIVE real GPU, else the FIRST real one (nvidiaIsPrimary's rule: Chromium's primary
 *     adapter, gpuDevice[0]). Its vendorId must be AMD (0x1002 / 0x1022) or Intel (0x8086); anything else (Apple,
 *     Qualcomm, unknown ids) -> null. Integrated Intel on a real machine counts as Intel.
 */
export function gpuShareVendor(
    gpus: readonly ShareGpuInfo[] | null | undefined,
    videoEncode?: string | null,
): GpuShareVendor | null {
    if (!gpus || gpus.length === 0) return null;
    if (typeof videoEncode === 'string' && !videoEncode.startsWith('enabled')) return null;
    const real = gpus.filter(g => typeof g.vendorId === 'number' && g.vendorId !== 0
        && !SOFTWARE_OR_VIRTUAL_VENDOR_IDS.has(g.vendorId) && !/^Microsoft/i.test(g.vendor ?? ''));
    if (real.length === 0) return null;
    const active = real.filter(g => g.active === true);
    if (real.some(g => g.vendorId === NVIDIA_VENDOR_ID)) {
        if (active.length === 0 || active.some(g => g.vendorId === NVIDIA_VENDOR_ID)) return null;
    }
    const pick = active[0] ?? real[0];
    if (pick.vendorId === INTEL_VENDOR_ID) return 'Intel';
    if (pick.vendorId !== undefined && AMD_VENDOR_IDS.has(pick.vendorId)) return 'AMD';
    return null;
}

/** Pure decision: offer the GPU card for a share that just went live? Windows/macOS only (electronAPI.platform is 'windows' | 'mac' | 'linux', not process.platform), AMD/Intel primary only. */
export function shouldOfferGpuShareIntro(platform: string | undefined, vendor: GpuShareVendor | null, seen: boolean, alreadyOffered: boolean): boolean {
    return (platform === 'windows' || platform === 'mac') && vendor !== null && !seen && !alreadyOffered;
}

export function hasSeenGpuShareIntro(): boolean {
    try { return secureLocalStore.getItem(GPU_SHARE_INTRO_KEY) === '1'; } catch { return false; }
}

export function hasSeenLinuxShareIntro(): boolean {
    try { return secureLocalStore.getItem(LINUX_SHARE_INTRO_KEY) === '1'; } catch { return false; }
}

let state: LinuxShareIntroState | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of [...listeners]) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => state;

/** The card's state now (null = nothing to show). */
export function getLinuxShareIntroState(): LinuxShareIntroState | null { return state; }

/** A share just went live. Makes the card pending when this is Linux and the device has never shown it. */
export function noteScreenShareStarted(backend: ShareBackendKind, platform: string | undefined = window.electronAPI?.platform): void {
    if (!shouldOfferLinuxShareIntro(platform, hasSeenLinuxShareIntro(), state !== null)) return;
    state = { backend, shown: false };
    emit();
}

/** A share just went live on Windows/macOS with this primary GPU. Makes the GPU card pending when it applies. */
export function noteGpuScreenShareStarted(vendor: GpuShareVendor | null, platform: string | undefined = window.electronAPI?.platform): void {
    if (!shouldOfferGpuShareIntro(platform, vendor, hasSeenGpuShareIntro(), state !== null)) return;
    state = { backend: 'normal', shown: false, gpuVendor: vendor! };
    emit();
}

/** The card is on screen: latch it and write the device flag (once). */
export function revealLinuxShareIntro(): void {
    if (!state || state.shown) return;
    state = { ...state, shown: true };
    try { secureLocalStore.setItem(state.gpuVendor ? GPU_SHARE_INTRO_KEY : LINUX_SHARE_INTRO_KEY, '1'); } catch { /* locked store: in-memory only, it may say it again next launch */ }
    emit();
}

export function dismissLinuxShareIntro(): void {
    if (!state) return;
    state = null;
    emit();
}

export function useLinuxShareIntro(): LinuxShareIntroState | null {
    return useSyncExternalStore(subscribe, snapshot, () => null);
}

/**
 * The one line in SidebarConference: `sharing` = our own screen share is published; `encoder` reads the native pipeline's
 * encoder name at that moment (null/undefined = the normal share). Re-fires per share; noteScreenShareStarted keeps it once.
 */
export function useLinuxShareIntroTrigger(sharing: boolean, encoder: () => string | null | undefined): void {
    const encoderRef = useRef(encoder);
    useEffect(() => { encoderRef.current = encoder; });
    useEffect(() => {
        if (!sharing) return;
        let backend: ShareBackendKind = 'normal';
        try { backend = backendFromEncoder(encoderRef.current()); } catch { /* the copy falls back to the general line */ }
        noteScreenShareStarted(backend);
    }, [sharing]);
}

/**
 * The second line in SidebarConference: `sharing` = our own screen share is published. The GPU list comes from the share
 * session SidebarConference already filled while deciding the codec (main's `gpus`) — nothing is awaited or fetched here.
 * If main answered after the codec decision's 750 ms cut-off the list is patched in later, so while the share lasts we
 * re-check on every session update; no list / no AMD-or-Intel primary = no card.
 */
export function useGpuShareIntroTrigger(sharing: boolean): void {
    useEffect(() => {
        if (!sharing) return;
        const platform = window.electronAPI?.platform;
        if (platform !== 'windows' && platform !== 'mac') return;
        let done = false;
        let unsubscribe: (() => void) | null = null;
        const attempt = () => {
            if (done) return;
            const gpus = getScreenShareSession()?.main?.gpus;
            if (!gpus || gpus.length === 0) return;   // not known (yet)
            done = true;
            unsubscribe?.();
            noteGpuScreenShareStarted(gpuShareVendor(gpus, getScreenShareSession()?.main?.videoEncode), platform);
        };
        attempt();
        if (!done) unsubscribe = subscribeScreenShareSession(attempt);
        return () => { done = true; unsubscribe?.(); };
    }, [sharing]);
}

export function __resetLinuxShareIntroForTests(): void {
    state = null;
    emit();
}
