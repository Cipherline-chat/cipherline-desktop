/**
 * Rotating the call's media key without a decrypt gap — the key RING.
 *
 * ── The bug (measured: 103 `call_e2ee_error {invalid_key}` events / 4 users /
 *    14 days, exactly every 10 min on both peers, ~2 s freeze of remote
 *    camera + screen share)
 *
 * LiveKit's `ExternalE2EEKeyProvider.setKey()` always writes key index 0, and
 * a sender stamps every frame with the index it is CURRENTLY sending at.
 * Rotation therefore OVERWROTE the only key. The rotator switched the moment
 * it broadcast the new `call_key`; each receiver switched only after its own
 * poll → ACK → decrypt → React effect. Every frame sealed under the new key
 * that reached a receiver still holding the old one (or the reverse) failed
 * AES-GCM → `InvalidKey` → freeze until the next keyframe.
 *
 * ── The fix
 *
 * Each epoch's key is installed at its own ring slot and the SENDING index is
 * moved later (`switchDelayMs`, after receivers have had the key), while the
 * previous epoch's key stays installed for `graceMs` and is then overwritten
 * with a random key nobody holds (the worker has no "delete key" message).
 * Frames sealed under epoch N therefore still decrypt during the grace, and
 * frames under N+1 decrypt as soon as the receiver has N+1 — no overwrite, so
 * no window in which the only key is the wrong one.
 *
 * ── Compatibility (why there is a capability and a legacy mode)
 *
 * Stable desktop (<= 1.0.23), older staging builds and the mobile client all
 * install keys at index 0 and decrypt by the index in the frame trailer. A
 * sender stamping index 5 would make every one of them drop the frame (the
 * call goes dark for them). So indexed SENDING is used only when EVERY remote
 * participant advertises the LiveKit participant attribute `cl.ekr = "1"`
 * (same mechanism as `cl.vdec`, hevcNegotiation.ts); an absent attribute is a
 * legacy peer and we send at index 0 exactly as before. The safe direction is
 * always the default: unknown capability (a joiner whose attribute has not
 * landed yet) is treated as legacy, and the switch back to indexed happens
 * when the attribute arrives.
 *
 * Why that is safe without any handshake: a ring-capable client ALWAYS
 * installs every epoch's key at BOTH its ring slot AND index 0. So a peer that
 * flips between "indexed" and "legacy" sending at any moment is decryptable by
 * every other ring-capable peer in either mode; only the SEND index depends on
 * the roster. Ring slots are 1..15 (`1 + epoch % 15`); index 0 is the
 * legacy/newest-key slot and can never collide with a ring slot, and two
 * consecutive epochs never share one.
 *
 * What this cannot fix: a call that contains a legacy participant keeps
 * today's index-0 overwrite semantics (their frames and their key handling
 * are outside our control). Nothing gets worse there.
 *
 * A client is ring-capable (advertises) only once it holds a key WITH a known
 * epoch — a key adopted without one has no slot peers could address.
 */
import { ExternalE2EEKeyProvider, KeyProviderEvent, createKeyMaterialFromBuffer, createKeyMaterialFromString } from 'livekit-client';

/** LiveKit participant attribute: "I hold call keys by ring slot". */
export const KEYRING_ATTR = 'cl.ekr';
export const KEYRING_ATTR_VALUE = '1';

/**
 * How long after installing a new epoch's key we keep sending the old one.
 * Receivers learn the key by poll trigger → GET /messages → ACK → decrypt →
 * React render → effect → worker, which is typically a few hundred ms; 3 s
 * leaves ~10x headroom for a slow poll or a busy main thread while keeping
 * the exposure of the OLD key to a few seconds (it is also what every
 * receiver still needs for frames already in flight).
 */
export const KEYRING_SEND_SWITCH_DELAY_MS = 3_000;
/** The previous epoch's key stays installed this long after the new one lands, then is overwritten. */
export const KEYRING_PREV_KEY_GRACE_MS = 30_000;

const RING_SLOTS = 15;
/** Ring slot for an epoch: 1..15. Index 0 is reserved for the legacy slot. */
export const ringIndexForEpoch = (epoch: number): number => 1 + (((epoch % RING_SLOTS) + RING_SLOTS) % RING_SLOTS);

/** True when every remote advertises the capability (vacuously true when alone). */
export function allRemotesRingCapable(remotes: Iterable<{ attributes?: Record<string, string> }>): boolean {
    for (const p of remotes) if (p.attributes?.[KEYRING_ATTR] !== KEYRING_ATTR_VALUE) return false;
    return true;
}

/** The epoch to install a key at, or undefined when the store's accepted key is not THIS key. */
export function epochForKey(held: { keyB64: string; epoch: number } | null | undefined, keyB64: string): number | undefined {
    return held && held.epoch >= 1 && held.keyB64 === keyB64 ? held.epoch : undefined;
}

export interface KeyRingOptions {
    switchDelayMs?: number;
    graceMs?: number;
}

type KeyInfo = { key: CryptoKey; participantIdentity?: string; keyIndex?: number };

export class RotatingKeyProvider extends ExternalE2EEKeyProvider {
    private readonly slots = new Map<number, KeyInfo>();
    private sendIndex = 0;
    private readonly switchDelayMs: number;
    private readonly graceMs: number;
    private newest: { epoch: number; index: number; installedAt: number } | null = null;
    private readonly heldEpochs = new Map<number, number>(); // index → epoch
    private peersCapable = false;
    private switchTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly dropTimers = new Set<ReturnType<typeof setTimeout>>();
    private chain: Promise<unknown> = Promise.resolve();
    private capabilityListener: ((capable: boolean) => void) | null = null;

    constructor(opts: KeyRingOptions = {}) {
        super();
        this.switchDelayMs = opts.switchDelayMs ?? KEYRING_SEND_SWITCH_DELAY_MS;
        this.graceMs = opts.graceMs ?? KEYRING_PREV_KEY_GRACE_MS;
    }

    // ── What LiveKit's manager reads ────────────────────────────────────────
    override getKeys() { return Array.from(this.slots.values()); }
    /** On SignalConnected the manager re-posts every key, "current" = this index. */
    override getLatestManuallySetKeyIndex() { return this.sendIndex; }
    /** Legacy entry point (index 0, sending index 0): the epoch-less first key, tests, Calls channels. */
    override async setKey(key: string | ArrayBuffer) {
        await this.writeSlot(key, 0, true);
    }

    // ── Observability / wiring ──────────────────────────────────────────────
    get currentSendIndex() { return this.sendIndex; }
    /** True once a key with a known epoch is installed — what we advertise to peers. */
    get ringCapable() { return this.newest !== null; }
    get newestEpoch() { return this.newest?.epoch ?? null; }
    /** Ring slots currently holding a key (index 0 included). */
    heldIndices(): number[] { return Array.from(this.slots.keys()).sort((a, b) => a - b); }
    onRingCapableChange(fn: ((capable: boolean) => void) | null) { this.capabilityListener = fn; }

    private async writeSlot(raw: string | ArrayBuffer, index: number, makeCurrent: boolean) {
        const key = typeof raw === 'string' ? await createKeyMaterialFromString(raw) : await createKeyMaterialFromBuffer(raw);
        const info: KeyInfo = { key, participantIdentity: undefined, keyIndex: index };
        this.slots.set(index, info);
        if (makeCurrent) this.sendIndex = index;
        // Straight to the manager's SetKey listener: `updateCurrentKeyIndex`
        // is OURS to decide (the base class would force it true for any index).
        this.emit(KeyProviderEvent.SetKey, info, makeCurrent);
    }

    private moveSendIndex(index: number) {
        const info = this.slots.get(index);
        if (!info) return;
        this.sendIndex = index;
        this.emit(KeyProviderEvent.SetKey, info, true);
    }

    private async wipeSlot(index: number) {
        const junk = new Uint8Array(32);
        crypto.getRandomValues(junk);
        const key = await createKeyMaterialFromBuffer(junk.buffer as ArrayBuffer);
        this.slots.delete(index);
        this.heldEpochs.delete(index);
        // Never current: the sender is not on this slot (see the guards below).
        this.emit(KeyProviderEvent.SetKey, { key, participantIdentity: undefined, keyIndex: index } satisfies KeyInfo, false);
    }

    /**
     * Install the key of `epoch`. Resolves once it is installed (the promise
     * `activateRoomE2EE` waits on as `keyReady`). Installs are serialised so
     * a rotation cannot overtake the previous key's async derivation.
     */
    installKeyAtEpoch(raw: ArrayBuffer, epoch: number): Promise<void> {
        const run = this.chain.then(() => this.doInstall(raw, epoch));
        this.chain = run.catch(() => {});
        return run;
    }

    private async doInstall(raw: ArrayBuffer, epoch: number) {
        if (this.newest && epoch <= this.newest.epoch) return; // duplicate / stale: keep what we have
        const index = ringIndexForEpoch(epoch);
        await this.writeSlot(raw, index, false);
        // Legacy slot too, always: a peer in legacy mode (or one that flips to it) sends at 0.
        await this.writeSlot(raw, 0, !this.peersCapable);
        this.heldEpochs.set(index, epoch);
        const wasCapable = this.ringCapable;
        this.newest = { epoch, index, installedAt: Date.now() };
        if (!wasCapable) this.capabilityListener?.(true);
        if (this.peersCapable) this.scheduleSwitch(this.switchDelayMs);
        // Retire everything older than this epoch after the grace.
        const t = setTimeout(() => {
            this.dropTimers.delete(t);
            for (const [idx, e] of [...this.heldEpochs]) {
                if (e < epoch && idx !== this.sendIndex) void this.wipeSlot(idx).catch(() => {});
            }
        }, this.graceMs);
        this.dropTimers.add(t);
    }

    private scheduleSwitch(delayMs: number) {
        if (this.switchTimer !== undefined) clearTimeout(this.switchTimer);
        this.switchTimer = setTimeout(() => {
            this.switchTimer = undefined;
            const n = this.newest;
            if (n && this.peersCapable && this.slots.has(n.index)) this.moveSendIndex(n.index);
        }, Math.max(0, delayMs));
    }

    /**
     * The roster verdict: true = every remote participant advertises the
     * capability. Anything else sends at index 0 (immediately: a legacy peer
     * is already receiving).
     */
    setPeersCapable(capable: boolean) {
        if (capable === this.peersCapable) return;
        this.peersCapable = capable;
        if (!capable) {
            if (this.switchTimer !== undefined) { clearTimeout(this.switchTimer); this.switchTimer = undefined; }
            if (this.newest && this.sendIndex !== 0) this.moveSendIndex(0);
        } else if (this.newest) {
            this.scheduleSwitch(this.newest.installedAt + this.switchDelayMs - Date.now());
        }
    }

    dispose() {
        if (this.switchTimer !== undefined) clearTimeout(this.switchTimer);
        this.switchTimer = undefined;
        for (const t of this.dropTimers) clearTimeout(t);
        this.dropTimers.clear();
    }
}
