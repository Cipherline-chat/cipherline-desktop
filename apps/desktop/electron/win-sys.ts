/**
 * What the app asks Windows about itself and its neighbours, behind one seam. On Windows the answer comes from the signed
 * win-helper.exe (electron/win-helper.ts) which calls Windows APIs directly: the app starts NO PowerShell, cmd, tasklist,
 * wmic or reg.exe (those read as malware to behavioural security engines). Every method FAILS SOFT with the same default the
 * old PowerShell code used when it errored, so a missing or crashed helper means "nothing detected", never an exception.
 *
 * No electron import and no src/ import (the rootDir rule): main.ts installs the real implementation.
 */

/** A process name as detection compares it: lowercase, no `.exe`. */
export function normalizeProcessName(raw: string): string {
    return raw.trim().toLowerCase().replace(/\.exe$/, '');
}

export interface WinSys {
    /** Names of every running program (normalised). [] when unavailable. */
    processNames(): Promise<string[]>;
    /** Every thread of every process with this name is suspended (a frozen UWP ghost). false when unknown (fails open). */
    isSuspended(name: string): Promise<boolean>;
    /** A process with this name owns a visible top-level window. true when unknown (fails open) or when it is not running. */
    hasVisibleWindow(name: string): Promise<boolean>;
    /** A javaw/java process owns a visible window titled "Minecraft...". false when unknown. */
    minecraftWindowOpen(): Promise<boolean>;
    /** Full path of the first process with this name whose path can be read, else null. */
    exePath(name: string): Promise<string | null>;
    /** Executable name (normalised) behind a pid, else null. */
    pidName(pid: number): Promise<string | null>;
    /** Is there already a per-app GPU preference for this executable? null when unknown. */
    gpuPreferenceExists(exe: string): Promise<boolean | null>;
    /** Prefer the high-performance GPU for this executable. false when it could not be written. */
    setHighPerformanceGpu(exe: string): Promise<boolean>;
}

/** What a build without the helper answers: nothing detected, nothing changed. */
export const NO_WIN_SYS: WinSys = {
    processNames: async () => [],
    isSuspended: async () => false,
    hasVisibleWindow: async () => true,
    minecraftWindowOpen: async () => false,
    exePath: async () => null,
    pidName: async () => null,
    gpuPreferenceExists: async () => null,
    setHighPerformanceGpu: async () => false,
};

let current: WinSys = NO_WIN_SYS;

export function setWinSys(s: WinSys | null): void {
    current = s ?? NO_WIN_SYS;
}

export function winSys(): WinSys {
    return current;
}

// ── Where the helper binary is (set once by main.ts) ─────────────────────────────────────────────────────────────────────
// The one-shot users (update-signature check, music probe) and the long-lived readers (media session) start the same signed
// win-helper.exe; none of them picks the path itself.
let helperBinary: () => string | null = () => null;

export function setWinHelperBinary(resolve: (() => string | null) | null): void {
    helperBinary = resolve ?? (() => null);
}

/** Absolute path of win-helper.exe, or null (not Windows / not shipped / not built). */
export function winHelperBinary(): string | null {
    try { return helperBinary(); } catch { return null; }
}
