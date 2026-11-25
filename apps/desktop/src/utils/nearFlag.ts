/**
 * Gates for the proximity screens.
 *
 *   - `VITE_NEAR_SIGNIN=1`  proximity SIGN-IN (new-device screens, Add a device, recovery). Build flag, DEFAULT OFF.
 *   - LOCAL HISTORY TRANSFER between this account's own devices (the sign-in "bring your history over" step, Settings, Storage,
 *     "Move your history", the holder's sheet, the transfer banner) and the routing of the three own-device control messages to the
 *     helper. ALWAYS ON since the server-relayed history sync was removed (2026-11-24): it is the only way to move history between
 *     devices. The old `VITE_NEAR_TRANSFER` build flag is retired. The one remaining condition is that the bridge says the feature
 *     exists: `nearProbe()` -> `{ available: true }`. A build with no helper (or one that does not start) answers "not available",
 *     and the screens then say so plainly (`SignInHistoryPrompt`) instead of offering a transfer that cannot run.
 */
import type { NearCapabilities } from '../types/near';

export const NEAR_SIGNIN_FLAG = 'VITE_NEAR_SIGNIN';

function buildFlag(name: string): boolean {
    try {
        const v = (import.meta.env as Record<string, unknown>)[name];
        return v === '1' || v === 'true' || v === true;
    } catch { return false; }
}

export function nearSignInBuildFlag(): boolean { return buildFlag(NEAR_SIGNIN_FLAG); }

export interface NearProbeApi { nearProbe?: () => Promise<NearCapabilities> }

async function probe(api: NearProbeApi | undefined | null, flag: boolean): Promise<NearCapabilities | null> {
    if (!flag || !api?.nearProbe) return null;
    try {
        const caps = await api.nearProbe();
        return caps && caps.available === true ? caps : null;
    } catch { return null; }
}

/** `null` = use today's screens. Never throws. */
export async function probeNearSignIn(api: NearProbeApi | undefined | null = typeof window !== 'undefined' ? window.electronAPI : undefined, flag: boolean = nearSignInBuildFlag()): Promise<NearCapabilities | null> {
    return probe(api, flag);
}

/** `null` = this build cannot run the transfer (no helper, or it does not start). Never throws. */
export async function probeNearTransfer(api: NearProbeApi | undefined | null = typeof window !== 'undefined' ? window.electronAPI : undefined): Promise<NearCapabilities | null> {
    return probe(api, true);
}
