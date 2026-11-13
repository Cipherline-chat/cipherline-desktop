/**
 * How fast a Firewall run was actually drawn, for the hitch probe. The probe's
 * late-frame test learns the interval from on-time frames, so a game drawn at a
 * steady 60 fps on a 160 Hz display reads as "0 late frames": smooth, and slow.
 * This counts the frames themselves. Plain numbers, no allocation per frame
 * (the worker's frame loop must make no garbage).
 */
export interface RunRate { frames: number; ms: number; fps: number; busyAvgMs: number; maxGapMs: number }

export class RunRateCounter {
    private frames = 0;
    private first = 0;
    private last = 0;
    private busy = 0;
    private maxGap = 0;

    /** One drawn frame at rAF time `ts` whose own work took `busyMs`. */
    frame(ts: number, busyMs: number): void {
        if (this.frames === 0) this.first = ts;
        else if (ts - this.last > this.maxGap) this.maxGap = ts - this.last;
        this.last = ts;
        this.frames++;
        this.busy += busyMs;
    }

    get count(): number { return this.frames; }

    /** The run so far, or null with fewer than 2 frames. */
    result(): RunRate | null {
        if (this.frames < 2) return null;
        const ms = this.last - this.first;
        if (ms <= 0) return null;
        return { frames: this.frames, ms, fps: ((this.frames - 1) * 1000) / ms, busyAvgMs: this.busy / this.frames, maxGapMs: this.maxGap };
    }

    reset(): void { this.frames = 0; this.first = 0; this.last = 0; this.busy = 0; this.maxGap = 0; }
}

export type PowerPreference = 'low-power' | 'high-performance' | 'default';

/** init's `power`, validated: anything unknown is the loading screen's own choice, low-power. */
export function resolvePower(p: unknown): PowerPreference {
    return p === 'high-performance' || p === 'default' ? p : 'low-power';
}

/** One report line: the game's own draw rate against the display's. */
export function rateLine(r: RunRate | null, displayHz: number, gl: string): string {
    if (!r) return 'Game draw rate: no run measured';
    const share = displayHz > 0 ? r.fps / displayHz : 1;
    const verdict = share < 0.8 ? ` -> the game draws at ${(share * 100).toFixed(0)}% of the display's rate` : ' -> matches the display';
    return `Game draw rate: ${r.fps.toFixed(0)} fps over ${(r.ms / 1000).toFixed(1)} s (${r.frames} frames) vs display ~${displayHz.toFixed(0)} Hz${verdict}`
        + ` · worst gap ${r.maxGapMs.toFixed(0)} ms · submit avg ${r.busyAvgMs.toFixed(2)} ms · GL: ${gl || 'unknown'}`;
}
