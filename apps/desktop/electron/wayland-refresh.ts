/**
 * The real refresh rate of each display on a Wayland session.
 *
 * Electron reports `displayFrequency` 0 on Wayland, so every report said `refresh_hz: 0` and
 * `share_display hz_src=unknown` and the picker never knew the monitor's rate. The compositor
 * does know it: wl_output.mode carries `refresh` in mHz. The Wayland overlay helper
 * (cl-wayland-overlay) already binds every wl_output; its one-shot `--outputs` mode prints
 * `OUT ...` and `HZ <idx> <mhz>` lines and exits (no surface, no X). This module runs it on
 * demand, validates every line (annotation-overlay-wayland-protocol.ts parseHelperLine), pairs
 * outputs with Electron displays by identical logical rectangle (the same rule the annotation
 * overlay uses) and caches the answer briefly. No permanent process. Any failure = unknown (the
 * pre-existing behaviour). Electron-free so it is unit tested.
 */
import { parseHelperLine, sameLogicalRect, type DisplayLite, type WaylandOutput } from './annotation-overlay-wayland-protocol';

/** Plausible panel refresh range (Hz); anything else is a garbage value, never a limit. */
const MIN_HZ = 10;
const MAX_HZ = 1000;

/** mHz -> whole Hz, or null when it is not a believable refresh rate. 59940 -> 60, 143981 -> 144. */
export function mhzToHz(mhz: unknown): number | null {
    if (typeof mhz !== 'number' || !Number.isFinite(mhz)) return null;
    const hz = Math.round(mhz / 1000);
    return hz >= MIN_HZ && hz <= MAX_HZ ? hz : null;
}

export interface ParsedOutputs { outputs: WaylandOutput[]; hzMhz: Map<number, number> }

/** The helper's `--outputs` stdout -> outputs + their mHz. Lines that are not exactly well-formed are ignored. */
export function parseOutputsDump(stdout: string): ParsedOutputs {
    const outputs: WaylandOutput[] = [];
    const hzMhz = new Map<number, number>();
    for (const line of stdout.split('\n').slice(0, 200)) {
        const ev = parseHelperLine(line.replace(/\r$/, ''));
        if (!ev) continue;
        if (ev.kind === 'out' && outputs.length < 16) outputs.push(ev.out);
        else if (ev.kind === 'hz') hzMhz.set(ev.index, ev.mhz);
    }
    return { outputs, hzMhz };
}

/**
 * Electron display id -> refresh in Hz. A display is included only when exactly ONE output has
 * its logical rectangle (mirrored heads / no match are left out, not guessed) and that output
 * reported a believable rate. A lone display with a lone output pairs without a rectangle check.
 */
export function pairRefreshWithDisplays(displays: readonly DisplayLite[], parsed: ParsedOutputs): Map<number, number> {
    const res = new Map<number, number>();
    const hzFor = (o: WaylandOutput): number | null => mhzToHz(parsed.hzMhz.get(o.index));
    for (const d of displays) {
        const hits = parsed.outputs.filter(o => sameLogicalRect(d.bounds, o));
        let out: WaylandOutput | undefined = hits.length === 1 ? hits[0] : undefined;
        if (!out && hits.length === 0 && displays.length === 1 && parsed.outputs.length === 1) out = parsed.outputs[0];
        const hz = out ? hzFor(out) : null;
        if (hz !== null) res.set(d.id, hz);
    }
    return res;
}

export interface WaylandRefreshDeps {
    /** Run the helper's `--outputs` mode; resolves its stdout, or null (no helper / failed / timed out). */
    run(): Promise<string | null>;
    getDisplays(): DisplayLite[];
    now(): number;
}

/** Layouts change rarely; a stale answer is at worst the old rate for a few seconds. */
export const REFRESH_CACHE_MS = 30_000;
/** A failure is remembered shorter so a transient miss does not hide the rate for long. */
export const REFRESH_FAIL_CACHE_MS = 5_000;

export interface WaylandRefreshProbe {
    /** Display id -> Hz (empty when unknown). Never rejects. Concurrent calls share one run. */
    get(): Promise<Map<number, number>>;
}

export function createWaylandRefreshProbe(deps: WaylandRefreshDeps): WaylandRefreshProbe {
    let cached: { at: number; ttl: number; value: Map<number, number> } | null = null;
    let inflight: Promise<Map<number, number>> | null = null;
    return {
        get() {
            if (cached && deps.now() - cached.at < cached.ttl) return Promise.resolve(cached.value);
            if (inflight) return inflight;
            inflight = (async () => {
                let value = new Map<number, number>();
                try {
                    const out = await deps.run();
                    if (out) value = pairRefreshWithDisplays(deps.getDisplays(), parseOutputsDump(out));
                } catch { /* unknown */ }
                cached = { at: deps.now(), ttl: value.size ? REFRESH_CACHE_MS : REFRESH_FAIL_CACHE_MS, value };
                return value;
            })().finally(() => { inflight = null; });
            return inflight;
        },
    };
}

/** Electron's own frequency when it is real, else the compositor's, else 0 (= unknown, as before). */
export function effectiveDisplayHz(electronHz: number | undefined, id: number, wayland: ReadonlyMap<number, number>): number {
    if (typeof electronHz === 'number' && Number.isFinite(electronHz) && electronHz > 0) return electronHz;
    return wayland.get(id) ?? 0;
}
