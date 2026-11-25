/**
 * What the transfer banner says, as a pure function of the snapshot. Same view for the sender and the receiver
 * (spec component 3); the strings are the catalogue's. A control the engine cannot do is not offered:
 * `controls.pause` is true only when the bridge has the pause members (contract 11.9). A pause the OTHER device made (`pausedBy: 'peer'`) offers no Resume: it continues when that device resumes.
 */
import type { NearSnapshot } from '../types/near';
import { nt } from './nearStrings';
import { formatBytes, percent, transferPhase } from './nearModel';

export interface TransferControls { pause: boolean; cancel: boolean; details: boolean }
export interface TransferCounts { messages: number; attachments: number }

export interface TransferBannerView {
    tone: 'info' | 'neutral' | 'success';
    title: string;
    description: string;
    /** Show the bar. */
    /** `preparing`: connected but no byte has moved yet (the sender is sealing the history; this can take seconds on a big one) - an
     *  indeterminate bar instead of a bar stuck at 0 %. The spec (E-landing-early) has no separate string, so the text is unchanged. */
    progress: { pct: number; state: 'moving' | 'paused' | 'interrupted' | 'preparing' } | null;
    actions: ('pause' | 'resume' | 'details' | 'cancel' | 'discard')[];
    /** Success banners hide themselves after 8 s (spec section 2). */
    autoHideMs: number | null;
    dismissible: boolean;
    kind: 'moving' | 'interrupted' | 'paused' | 'applying' | 'done' | 'partial' | 'stopped' | 'gave_up';
}

export const SUCCESS_BANNER_MS = 8000;

export interface TransferViewCtx {
    /** The other device's name. */
    device: string;
    direction: 'send' | 'receive';
    eta: string | null;
    controls: TransferControls;
    /** True from the end of the byte transfer until the import has finished (receiver). */
    applying?: boolean;
    /** Counts for the success line, once the import knows them. */
    counts?: TransferCounts;
    /** The user stopped it. */
    stopped?: boolean;
    /** We stopped it: the other device never came back (`InterruptWatch`). */
    gaveUp?: boolean;
}

/** B7: how long / how many reconnects a dropped transfer is waited for before it is called dead. The host retries on its own and
 *  would otherwise show "Sending ... 0 B of N" (attempt 6, 7, ...) until the user pressed Cancel, long after the other device's
 *  session had ended (a near session lives at most 5 minutes, contract 11.7). */
export const GIVE_UP_ATTEMPTS = 4;
export const GIVE_UP_AFTER_MS = 90_000;

/**
 * Fed every snapshot, says when a transfer that dropped should be given up on. Only an unplanned drop counts (`interrupted`, not a
 * user's Pause); any progress back in `transferring` resets the clock. Pure apart from the clock it is handed.
 */
export class InterruptWatch {
    private since: number | null = null;
    /** `true` once the transfer has been interrupted for `GIVE_UP_AFTER_MS`, or has been through `GIVE_UP_ATTEMPTS` connection attempts. */
    gaveUp(now: number, snap: NearSnapshot | null): boolean {
        const t = snap?.transfer;
        const dropped = !!snap && !!t && !t.paused && (snap.state === 'transfer_paused' || t.interrupted) && snap.state !== 'done';
        if (!dropped) { this.since = null; return false; }
        this.since ??= now;
        return (t!.attempt ?? 1) >= GIVE_UP_ATTEMPTS || now - this.since >= GIVE_UP_AFTER_MS;
    }
    /** Milliseconds until the time bound is reached (for a timer), or null when nothing is pending. */
    remainingMs(now: number): number | null { return this.since == null ? null : Math.max(0, GIVE_UP_AFTER_MS - (now - this.since)); }
    reset(): void { this.since = null; }
}

export function transferBannerView(snap: NearSnapshot, ctx: TransferViewCtx): TransferBannerView | null {
    const phase = transferPhase(snap);
    const t = snap.transfer;
    const send = ctx.direction === 'send';
    const done = formatBytes(t?.bytesDone ?? 0);
    const total = formatBytes(t?.bytesTotal ?? 0);
    const pct = t ? percent(t) : 0;
    const acts = (a: ('pause' | 'resume' | 'details' | 'cancel')[]) => a.filter(x => (x === 'pause' || x === 'resume' ? ctx.controls.pause : x === 'cancel' ? ctx.controls.cancel : ctx.controls.details));

    if (ctx.gaveUp) {
        return { tone: 'neutral', title: nt('e.gaveup.t'), description: nt('e.gaveup.s', { device: ctx.device }), progress: null, actions: ['discard'], autoHideMs: null, dismissible: false, kind: 'gave_up' };
    }
    if (ctx.stopped) {
        return { tone: 'neutral', title: nt('e.stopped.t'), description: nt('e.stopped.s'), progress: null, actions: [], autoHideMs: null, dismissible: true, kind: 'stopped' };
    }
    if (snap.partial && !send && snap.state !== 'transferring') {
        const skipped = Math.max(0, snap.partial.recordsTotal - snap.partial.recordsHeld);
        return { tone: 'neutral', title: nt('e.partial.t'), description: nt('e.partial.s', { n: skipped, device: ctx.device }), progress: null, actions: [], autoHideMs: null, dismissible: true, kind: 'partial' };
    }
    if (phase === 'done') {
        if (!send && ctx.applying) {
            return { tone: 'info', title: nt('e.applying'), description: '', progress: null, actions: [], autoHideMs: null, dismissible: false, kind: 'applying' };
        }
        const description = send ? '' : ctx.counts ? nt('e.done.s', { messages: ctx.counts.messages.toLocaleString('en-US'), attachments: ctx.counts.attachments.toLocaleString('en-US'), device: ctx.device }) : '';
        return { tone: 'success', title: send ? nt('e.snd.done', { device: ctx.device }) : nt('e.done.t'), description, progress: null, actions: [], autoHideMs: SUCCESS_BANNER_MS, dismissible: true, kind: 'done' };
    }
    if (phase === 'paused') {
        return { tone: 'neutral', title: nt('e.paused.t'), description: nt('e.paused.s', { done, total }), progress: { pct, state: 'paused' }, actions: acts(t?.pausedBy === 'peer' ? ['details', 'cancel'] : ['resume', 'details', 'cancel']), autoHideMs: null, dismissible: false, kind: 'paused' };
    }
    if (phase === 'interrupted') {
        return { tone: 'neutral', title: nt('e.int.t', { device: ctx.device }), description: nt('e.int.s'), progress: { pct, state: 'interrupted' }, actions: acts(['details', 'cancel']), autoHideMs: null, dismissible: false, kind: 'interrupted' };
    }
    if (phase === 'moving') {
        // Total unknown (the manifest has not arrived): say nothing rather than "0 B of 0 B".
        const known = (t?.bytesTotal ?? 0) > 0;
        const description = !known ? '' : ctx.eta ? nt('e.bn.s', { pct, done, total, eta: ctx.eta }) : nt('e.bn.s.noeta', { pct, done, total });
        return {
            tone: 'info',
            title: send ? nt('e.snd.t', { device: ctx.device }) : nt('e.bn.t', { device: ctx.device }),
            description,
            progress: { pct, state: (t?.bytesDone ?? 0) === 0 ? 'preparing' : 'moving' },
            actions: acts(['pause', 'details', 'cancel']),
            autoHideMs: null,
            dismissible: false,
            kind: 'moving',
        };
    }
    return null;
}
