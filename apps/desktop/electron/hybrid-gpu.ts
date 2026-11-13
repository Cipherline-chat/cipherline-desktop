/**
 * Run on the faster GPU on a Windows laptop with two of them.
 *
 * Windows starts an app on the power-saving GPU unless told otherwise, and
 * nothing here ever told it. A viewer's report showed the cost (i5-13600HX with
 * an Intel + NVIDIA pair, a 4K panel at 250%): 1440p90 H.265 arrived with no
 * loss, 35-68 fps were decoded, 8,755 frames were dropped and it froze 224 times.
 *
 * Two levers, because neither could be proven on a real laptop from here:
 *   - Chromium's `force_high_performance_gpu` launch switch;
 *   - the per-app preference Settings > System > Display > Graphics writes,
 *     HKCU\Software\Microsoft\DirectX\UserGpuPreferences, read when a process
 *     starts - so it counts from the NEXT launch.
 * The preference belongs to the user. It is written at most once per install
 * (a marker file), and only if there is no value for this executable: a choice
 * made in Settings is never overwritten, and removing ours does not bring it back.
 *
 * Only on a hybrid machine: a single GPU has nothing to choose, and a desktop
 * with two graphics cards is left to the driver and the user. Off along with
 * "Prioritize call video while gaming".
 */
import type { GpuTopologyHint } from './capture-flags';

export const HIGH_PERFORMANCE_GPU_SWITCH = 'force_high_performance_gpu';
export const USER_GPU_PREFERENCES_KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
export const HIGH_PERFORMANCE_GPU_VALUE = 'GpuPreference=2;';
export const GPU_PREFERENCE_MARKER_FILENAME = 'gpu-preference-set';

/**
 * Chromium's own hybrid flag, or an Intel integrated GPU beside a discrete one.
 * The flag alone is not enough: the vendor pair covers a laptop it missed. An
 * AMD + NVIDIA pair counts only by the flag, because it is also what a desktop
 * with two cards looks like.
 */
export function isHybridGpu(topology: GpuTopologyHint | null | undefined): boolean {
    if (!topology) return false;
    if (topology.hybrid) return true;
    return topology.vendors.includes('Intel') && (topology.vendors.includes('NVIDIA') || topology.vendors.includes('AMD'));
}

/** Decided from the PREVIOUS launch's layout: a launch switch cannot wait for this one's. */
export function highPerformanceGpuSwitches(enabled: boolean, platform: string, topology: GpuTopologyHint | null | undefined): string[] {
    return enabled && platform === 'win32' && isHybridGpu(topology) ? [HIGH_PERFORMANCE_GPU_SWITCH] : [];
}

export type GpuPreferenceOutcome = 'skipped' | 'already-done' | 'kept-existing' | 'set' | 'failed';

export interface GpuPreferenceDeps {
    platform: string;
    enabled: boolean;
    topology: GpuTopologyHint | null;
    exePath: string;
    markerExists(): boolean;
    writeMarker(): void;
    /** Runs reg.exe with these exact arguments (never through a shell). Resolves to its exit code. */
    reg(args: string[]): Promise<number>;
}

/**
 * Asks Windows for the high-performance GPU for this executable, once. Never
 * throws: a failure leaves the marker unwritten, so the next launch tries again.
 */
export async function ensureHighPerformancePreference(deps: GpuPreferenceDeps): Promise<GpuPreferenceOutcome> {
    if (deps.platform !== 'win32' || !deps.enabled || !isHybridGpu(deps.topology)) return 'skipped';
    try {
        if (deps.markerExists()) return 'already-done';
        // reg query exits 0 only when this executable already has a value.
        if ((await deps.reg(['query', USER_GPU_PREFERENCES_KEY, '/v', deps.exePath])) === 0) {
            deps.writeMarker();
            return 'kept-existing';
        }
        const code = await deps.reg(['add', USER_GPU_PREFERENCES_KEY, '/v', deps.exePath, '/t', 'REG_SZ', '/d', HIGH_PERFORMANCE_GPU_VALUE, '/f']);
        if (code !== 0) return 'failed';
        deps.writeMarker();
        return 'set';
    } catch {
        return 'failed';
    }
}

/** Which GPU Chromium really renders on, from getGPUInfo('complete'): the vendor word only. */
export function activeGpuVendor(info: unknown): string {
    const renderer = (info as { auxAttributes?: { glRenderer?: unknown } } | null)?.auxAttributes?.glRenderer;
    if (typeof renderer !== 'string') return 'unknown';
    const match = /nvidia|intel|amd|radeon|microsoft/i.exec(renderer);
    if (!match) return 'other';
    const word = match[0].toLowerCase();
    return word === 'radeon' ? 'amd' : word;
}
