/**
 * personalSavesSyncService — pull/publish for the `personal_saves` own-device slot.
 *
 * Same shape as gifLibrarySyncService: every side effect goes through an env
 * so the ordering and the decisions are unit-testable against a fake.
 *
 * Posture: best-effort, never blocking, never corrupting. A throw anywhere
 * leaves local state exactly as it was; the local save/unsave has always
 * already happened before this runs.
 *
 * Design: docs/OWN-DEVICE-SYNC.md in cipherline-mobile.
 */

import {
    frameOwnSlot,
    parseOwnSlotFrame,
    envelopeRecipientIds,
    republishReason,
    OWN_SLOT_CONTAINER_VERSION,
    type RepublishReason,
    type SlotView,
} from '../utils/ownSlotSync';
import {
    buildSavesPayload,
    isEmptySaves,
    mergeSaves,
    parseSavesPayload,
    sameSaves,
    sanitizeScope,
    SAVES_SNAPSHOT_MAGIC,
    type SavesState,
} from '../utils/personalSavesSync';

/** What an unwrap returns: the decrypted JSON and, when the env knows it, the
 *  device that wrote it. The env has ALREADY verified the sender is one of this
 *  account's devices and throws otherwise. */
export interface UnwrappedKey {
    contentJson: string;
    senderDeviceId?: string;
}

/** A device's wrap material, as `prekey_bundle` returns it. */
export interface OwnDevicePub {
    device_id: string;
    spk_pub_b64: string;
    sig_b64?: string;
    identity_pub_b64?: string;
    otp_pub_b64?: string | null;
    otp_id?: number | null;
}

export interface OwnSlotEnv {
    getSlotMeta(): Promise<{ backup_id: string; updated_at: string } | null>;
    downloadSlot(): Promise<Uint8Array | null>;
    uploadSlot(bytes: Uint8Array): Promise<void>;

    /** Current device ids of this account (non-claiming lookup), or null if
     *  the lookup failed. Includes this device. */
    listOwnDeviceIds(): Promise<string[] | null>;
    /** Signed-prekey bundles for this account's OTHER devices. Claims one-time
     *  prekeys, so it is only called when a publish is actually going ahead. */
    fetchOwnDevices(): Promise<OwnDevicePub[]>;
    wrapToDevices(plaintext: string, devices: OwnDevicePub[]): Promise<string>;
    /** Throws when this device is not addressed, or the sender is not ours. */
    unwrapFromEnvelope(envelopeB64: string): Promise<string | UnwrappedKey>;

    generateContentKeyB64(): Promise<string>;
    encryptWithKey(plaintext: string, keyB64: string): Promise<Uint8Array>;
    decryptWithKey(bytes: Uint8Array, keyB64: string): Promise<string>;

    now(): number;
    log?(msg: string, err?: unknown): void;
}

export interface SavesSyncEnv extends OwnSlotEnv {
    loadLocalState(): SavesState;
    /** Persist a merged state. `prev` is what it replaces, for callers that act
     *  on what changed. */
    saveLocalState(next: SavesState, prev: SavesState): void;
}

export interface SavesPullResult {
    /** True when the merge changed local state. */
    applied: boolean;
    state: SavesState;
    /** The view to persist: what this device now knows about the slot. */
    view: SlotView<SavesState> | null;
}

const warn = (env: OwnSlotEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[savesSync] ${m}`, e)))(msg, err);

const normalizeUnwrap = (u: string | UnwrappedKey): UnwrappedKey =>
    typeof u === 'string' ? { contentJson: u } : u;

/**
 * Probe the slot, and if it changed since `view`, download, verify, decrypt,
 * merge into local state and persist. Never publishes.
 */
export async function pullSaves(env: SavesSyncEnv, view: SlotView<SavesState> | null): Promise<SavesPullResult> {
    const local = env.loadLocalState();
    const meta = await env.getSlotMeta();
    if (!meta) return { applied: false, state: local, view: null };
    if (view && view.updatedAt === meta.updated_at) return { applied: false, state: local, view };

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return { applied: false, state: local, view: null };

    const { header, body } = parseOwnSlotFrame(SAVES_SNAPSHOT_MAGIC, bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);
    const unreadable: SlotView<SavesState> = { updatedAt: meta.updated_at, recipients, publisher: null, state: null };

    let unwrapped: UnwrappedKey;
    let contentKeyB64: string;
    try {
        unwrapped = normalizeUnwrap(await env.unwrapFromEnvelope(header.key_envelope_b64));
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        // Not addressed to this device yet (it is newer than the snapshot), or
        // not written by one of our devices. Either way: nothing to merge, and
        // this device must not republish over a slot it could not read.
        warn(env, 'saves snapshot is not readable by this device; skipping', e);
        return { applied: false, state: local, view: unreadable };
    }

    const payload = parseSavesPayload(await env.decryptWithKey(body, contentKeyB64));
    const remote: SavesState = { conversation: payload.conversation, channel: payload.channel };
    const nextView: SlotView<SavesState> = {
        updatedAt: meta.updated_at,
        recipients,
        publisher: unwrapped.senderDeviceId ?? null,
        state: remote,
    };

    const merged = mergeSaves(local, remote);
    if (sameSaves(merged, local)) return { applied: false, state: local, view: nextView };
    env.saveLocalState(merged, local);
    return { applied: true, state: merged, view: nextView };
}

/** The local state exactly as it would be published (sanitized). */
export function publishableSaves(state: SavesState): SavesState {
    return { conversation: sanitizeScope(state.conversation), channel: sanitizeScope(state.channel) };
}

/** Should this device publish although nothing changed locally? */
export function savesRepublishReason(
    view: SlotView<SavesState> | null,
    local: SavesState,
    ownDeviceIds: readonly string[] | null,
    myDeviceId: string,
): RepublishReason {
    return republishReason({
        view,
        local: publishableSaves(local),
        isEmpty: isEmptySaves,
        merge: mergeSaves,
        same: sameSaves,
        ownDeviceIds,
        myDeviceId,
    });
}

/**
 * Publish the local saves to the slot, wrapped to this account's other
 * devices. Returns the new view, or null when there is nobody to publish to
 * (single-device account) — a blob nobody else can read is not uploaded.
 */
export async function publishSaves(env: SavesSyncEnv, myDeviceId: string): Promise<SlotView<SavesState> | null> {
    // Non-claiming check first: a single-device account must not spend its own
    // one-time prekeys on every save just to find out there is nobody to tell.
    const ids = await env.listOwnDeviceIds();
    if (ids && !ids.some(id => id !== myDeviceId)) return null;

    const devices = (await env.fetchOwnDevices()).filter(d => d.device_id && d.spk_pub_b64 && d.device_id !== myDeviceId);
    if (devices.length === 0) return null;

    const state = publishableSaves(env.loadLocalState());
    const contentKeyB64 = await env.generateContentKeyB64();
    const payload = buildSavesPayload(state, env.now());
    const body = await env.encryptWithKey(JSON.stringify(payload), contentKeyB64);
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);

    await env.uploadSlot(frameOwnSlot(
        SAVES_SNAPSHOT_MAGIC,
        { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: keyEnvelope },
        body,
    ));

    // Our own upload is now the slot. Record it so the next probe does not
    // download what we just wrote; `updatedAt` comes from a fresh probe.
    const meta = await env.getSlotMeta();
    if (!meta) return null;
    return {
        updatedAt: meta.updated_at,
        recipients: envelopeRecipientIds(keyEnvelope),
        publisher: myDeviceId,
        state,
    };
}
