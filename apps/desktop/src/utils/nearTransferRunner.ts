/**
 * Runs one local history transfer to its end, outliving whichever dialog started it. The byte movement is the
 * host's (`nearTransfer*`) and the spooling is `nearHistoryTransfer.ts`; this only keeps the page-side facts the
 * banner needs that the snapshot does not carry: which direction, who the other device is, "applying", counts,
 * and that the user stopped it.
 */
import { receiveHistoryOverNear, sendHistoryOverNear, type NearHistoryApi } from './nearHistoryTransfer';
import type { HistoryCounts, NearHistoryPort } from './nearHistoryPort';

export interface RunnerState {
    direction: 'send' | 'receive' | null;
    device: string;
    running: boolean;
    /** Receiver: the bytes are here, the import is running. */
    applying: boolean;
    stopped: boolean;
    /** We gave up: the other device did not come back (B7). The banner says so and offers Discard. */
    gaveUp: boolean;
    /** No transfer happened (approve only, or no local-network path): the receiver shows the quiet pointer. */
    notOffered: boolean;
    counts?: HistoryCounts;
    error?: { code: string; message: string };
    startedAt: number | null;
    finishedAt: number | null;
}

const IDLE: RunnerState = { direction: null, device: '', running: false, applying: false, stopped: false, gaveUp: false, notOffered: false, startedAt: null, finishedAt: null };

export class NearTransferRunner {
    private state: RunnerState = IDLE;
    private listeners = new Set<() => void>();
    private ctl: AbortController | null = null;
    /** The user chose "Keep what arrived" in the stop dialog. */
    private keepRequested = false;

    getSnapshot = (): RunnerState => this.state;
    subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
    private set(p: Partial<RunnerState>): void { this.state = { ...this.state, ...p }; this.listeners.forEach(l => l()); }
    reset(): void { this.ctl?.abort(); this.ctl = null; this.state = IDLE; this.listeners.forEach(l => l()); }

    /** Sender: build the container (attachments per the switch), then stream it. Resolves when the transfer ends. */
    async startSend(o: { api: NearHistoryApi; port: NearHistoryPort; includeAttachments: boolean; device: string; now?: () => number }): Promise<void> {
        const now = o.now ?? Date.now;
        this.ctl?.abort(); this.ctl = new AbortController();
        this.state = { ...IDLE, direction: 'send', device: o.device, running: true, startedAt: now() };
        this.listeners.forEach(l => l());
        try {
            await sendHistoryOverNear({ api: o.api, writeContainer: sink => o.port.writeContainer(sink, { includeAttachments: o.includeAttachments }), signal: this.ctl.signal });
            this.set({ running: false, finishedAt: now() });
        } catch (e) {
            this.fail(e, now);
        }
    }

    /** Receiver: wait for the sender, then apply what arrives through the existing import path. */
    async startReceive(o: { api: NearHistoryApi; port: NearHistoryPort; device: string; now?: () => number }): Promise<void> {
        const now = o.now ?? Date.now;
        this.ctl?.abort(); this.ctl = new AbortController(); this.keepRequested = false;
        this.state = { ...IDLE, direction: 'receive', device: o.device, running: true, startedAt: now() };
        this.listeners.forEach(l => l());
        try {
            await receiveHistoryOverNear({
                api: o.api,
                signal: this.ctl.signal,
                importContainer: async (source, size) => {
                    this.set({ applying: true });
                    const counts = await o.port.importContainer(source, size);
                    this.set({ counts });
                },
                keepOnStop: () => this.keepRequested && !!o.port.importPartial,
                importPartial: async (source, size, ranges) => {
                    this.set({ applying: true });
                    const counts = await o.port.importPartial!(source, size, ranges);
                    this.set({ counts, applying: false });
                },
            });
            this.set({ running: false, applying: false, finishedAt: now() });
        } catch (e) {
            this.fail(e, now);
        }
    }

    /** The user pressed Cancel and confirmed (the host session is cancelled by the caller). `keep`: apply what already arrived. */
    stop(o: { keep?: boolean } = {}): void {
        this.keepRequested = !!o.keep;
        this.ctl?.abort();
        // while the kept parts are being applied the banner says so (and the keep path clears it again)
        this.set({ stopped: true, running: false, applying: false });
    }

    /** The other device never came back (`InterruptWatch`): end our side, free the host session, say so. */
    giveUp(): void {
        if (this.state.gaveUp || this.state.stopped) return;
        this.keepRequested = false;
        this.ctl?.abort();
        this.set({ gaveUp: true, running: false, applying: false });
    }

    private fail(e: unknown, now: () => number): void {
        const name = e instanceof Error ? e.name : '';
        const code = (e as { code?: string })?.code ?? (name === 'AbortError' ? 'aborted' : 'failed');
        const message = e instanceof Error ? e.message : String(e);
        // "no local-network path" / "not approved yet" / "this device is the sender": nothing was offered.
        const notOffered = /no local-network path|no near session|the session ended/.test(message);
        this.set({ running: false, applying: false, error: { code, message }, notOffered, finishedAt: now() });
    }
}

let shared: NearTransferRunner | null = null;
export function getTransferRunner(): NearTransferRunner { return (shared ??= new NearTransferRunner()); }
export function setTransferRunnerForTest(r: NearTransferRunner | null): void { shared = r; }
