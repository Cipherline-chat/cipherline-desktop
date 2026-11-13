/**
 * The viewer's notice for the screen-share loss fallback (shareLossFallback.ts):
 * "your connection can't keep up with this stream, so it's showing a lighter
 * version", with "Keep full quality" and a dismiss.
 *
 * CallEventMonitor runs the fallback and has no UI; the share's tile
 * (VideoTile, focused and fullscreen) has the UI and no stats. This is the
 * channel between them: a module-level store keyed by track SID, read with
 * useSyncExternalStore (hooks/useShareFallbackNotice.ts) in the same way
 * shareHold.ts is.
 *
 *   monitor → store  showLighter (the lower layer is on screen), lifted (the cap
 *                    came off), forget (the publication is no longer watched)
 *   tile → store     dismiss, keepFullQuality
 *   store → monitor  onKeepFullQuality: the monitor lifts the cap at once and
 *                    turns that share's fallback off (ShareLossFallback.optOut)
 *
 * Per share only, never persisted: a publication's SID is the share, so "Keep
 * full quality" lasts for that share and the next share from the same person
 * starts with the fallback on again. Everything is dropped when the call ends.
 *
 * Privacy: SIDs are map keys only. Nothing here logs; the monitor logs by
 * track placeholder.
 */
import type { ShareRxReason } from './shareLossFallback';

export type ShareFallbackNotice =
    /** Capped and the lighter copy is what is on screen; `shortSide` = its short side in px, null = not known. */
    | { kind: 'lighter'; shortSide: number | null }
    /** The full layer is back after a notice the viewer could see. Fades out by itself. */
    | { kind: 'restored' };

/** How long "Back to full quality" stays up. */
export const RESTORED_NOTE_MS = 3_000;

export interface ShareFallbackNoticeDeps {
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(t: unknown): void;
}

/** A short side that can honestly be called "<n>p"; anything else is said without a number. */
export function lighterShortSide(px: number | null | undefined): number | null {
    if (typeof px !== 'number' || !Number.isFinite(px)) return null;
    const n = Math.round(px);
    return n >= 144 && n <= 4320 ? n : null;
}

/** The words, wide and narrow. `shortSide` must come from lighterShortSide (or be null). */
export function lighterNoticeCopy(shortSide: number | null): { full: string; short: string } {
    const what = shortSide ? `lighter ${shortSide}p version` : 'lighter version';
    return {
        full: `Your connection can’t keep up with this stream, so it’s showing a ${what}.`,
        short: `Showing a ${what}`,
    };
}

export const KEEP_FULL_QUALITY_HINT = 'Stay on full quality for this stream. It may freeze or stutter.';

export class ShareFallbackNoticeStore {
    private notices = new Map<string, ShareFallbackNotice>();
    private off = new Set<string>();
    private timers = new Map<string, unknown>();
    private listeners = new Set<() => void>();
    private keepHandlers = new Set<(sid: string) => void>();

    private readonly deps: ShareFallbackNoticeDeps;

    constructor(deps: ShareFallbackNoticeDeps) { this.deps = deps; }

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    };

    /** What the tile shows for this share. The same object until it changes: safe as a store snapshot. */
    notice(sid: string | null | undefined): ShareFallbackNotice | null {
        return sid ? this.notices.get(sid) ?? null : null;
    }

    /** The viewer chose full quality for this share. */
    isOptedOut(sid: string): boolean { return this.off.has(sid); }

    // ── The monitor's side ─────────────────────────────────────────────────

    /** Capped, and the lower layer is what the viewer now sees. Nothing on a share they opted out of. */
    showLighter(sid: string, shortSide: number | null): void {
        if (this.off.has(sid)) return;
        this.set(sid, { kind: 'lighter', shortSide: lighterShortSide(shortSide) });
    }

    /**
     * The cap came off. Back on the full layer by 'recovered' after a notice the
     * viewer could see: say so, briefly. Any other way, or with nothing showing:
     * just take the notice down.
     */
    lifted(sid: string, reason: ShareRxReason | undefined): void {
        const cur = this.notices.get(sid);
        if (reason === 'recovered' && cur?.kind === 'lighter') {
            this.set(sid, { kind: 'restored' });
            this.timers.set(sid, this.deps.setTimer(() => {
                this.timers.delete(sid);
                if (this.notices.get(sid)?.kind === 'restored') this.set(sid, null);
            }, RESTORED_NOTE_MS));
            return;
        }
        this.set(sid, null);
    }

    /** The publication is no longer watched (or gone). The opt-out stays: it may be watched again. */
    forget(sid: string): void { this.set(sid, null); }

    /** Told when the viewer picks "Keep full quality", so the cap comes off now, not on the next tick. */
    onKeepFullQuality(fn: (sid: string) => void): () => void {
        this.keepHandlers.add(fn);
        return () => { this.keepHandlers.delete(fn); };
    }

    // ── The viewer's side ──────────────────────────────────────────────────

    /** ×: hide this notice. The lighter version stays. */
    dismiss(sid: string): void { this.set(sid, null); }

    /** "Keep full quality": no automatic drop for the rest of this share. */
    keepFullQuality(sid: string): void {
        this.off.add(sid);
        this.set(sid, null);
        for (const fn of [...this.keepHandlers]) {
            try { fn(sid); } catch { /* one handler cannot stop the others */ }
        }
    }

    /** The call ended. */
    reset(): void {
        for (const t of this.timers.values()) this.deps.clearTimer(t);
        this.timers.clear();
        this.off.clear();
        const had = this.notices.size > 0;
        this.notices.clear();
        if (had) this.emit();
    }

    private set(sid: string, n: ShareFallbackNotice | null): void {
        const t = this.timers.get(sid);
        if (t !== undefined) { this.deps.clearTimer(t); this.timers.delete(sid); }
        const cur = this.notices.get(sid) ?? null;
        if (n === null) {
            if (!cur) return;
            this.notices.delete(sid);
        } else {
            if (cur && cur.kind === n.kind && (cur.kind !== 'lighter' || cur.shortSide === (n as { shortSide: number | null }).shortSide)) return;
            this.notices.set(sid, n);
        }
        this.emit();
    }

    private emit(): void {
        for (const fn of [...this.listeners]) {
            try { fn(); } catch { /* isolate */ }
        }
    }
}

export const shareFallbackNotice = new ShareFallbackNoticeStore({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: t => clearTimeout(t as ReturnType<typeof setTimeout>),
});
