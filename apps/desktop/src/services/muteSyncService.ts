/**
 * muteSyncService - pull/publish for the `mutes` own-device slot (every
 * notification mute: channels, categories, servers, DMs, group chats). A copy of
 * customThemeSyncService with the mute payload: best-effort, never blocking, a
 * throw leaves local state exactly as it was; the server only holds an opaque
 * client-encrypted blob wrapped to this account's devices and never sees
 * what is muted. Merge rule: utils/muteSync.ts.
 */
import {
    frameOwnSlot, parseOwnSlotFrame, envelopeRecipientIds, republishReason, OWN_SLOT_CONTAINER_VERSION, type SlotView,
} from '../utils/ownSlotSync';
import {
    MUTES_MAGIC, buildMutesPayload, isEmptyMuteState, mergeMuteStates, parseMutesPayload, sameMuteState,
    type MuteState,
} from '../utils/muteSync';
import type { OwnSlotEnv, UnwrappedKey } from './personalSavesSyncService';

export interface MuteSyncEnv extends OwnSlotEnv {
    loadLocalState(): MuteState;
    /** Persist a merged state (library + meta) and tell the UI to re-read. NOT a user edit: it must not trigger a publish. */
    saveLocalState(next: MuteState): void;
}

export interface MutePullResult { applied: boolean; view: SlotView<MuteState> | null }

const warn = (env: OwnSlotEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[muteSync] ${m}`, e)))(msg, err);
const normalizeUnwrap = (u: string | UnwrappedKey): UnwrappedKey => (typeof u === 'string' ? { contentJson: u } : u);

/**
 * An API that does not know the slot (every API before the `mutes` slot was
 * added to apps/api/src/history/backup-slots.ts) answers 400 "Unknown backup
 * slot" to every call. That is "sync not available yet", not an error to
 * surface or retry hot.
 */
export function isSlotUnavailableError(e: unknown): boolean {
    const status = (e as { response?: { status?: number } } | null)?.response?.status;
    return status === 400;
}

/** Probe the slot; if it changed since `view`, download, verify, decrypt, validate, merge and persist. Never publishes. */
export async function pullMutes(env: MuteSyncEnv, view: SlotView<MuteState> | null): Promise<MutePullResult> {
    const meta = await env.getSlotMeta();
    if (!meta) return { applied: false, view: null };
    if (view && view.updatedAt === meta.updated_at) return { applied: false, view };

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return { applied: false, view: null };

    const { header, body } = parseOwnSlotFrame(MUTES_MAGIC, bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);
    const unreadable: SlotView<MuteState> = { updatedAt: meta.updated_at, recipients, publisher: null, state: null };

    let unwrapped: UnwrappedKey;
    let contentKeyB64: string;
    try {
        unwrapped = normalizeUnwrap(await env.unwrapFromEnvelope(header.key_envelope_b64));
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        warn(env, 'mutes snapshot is not readable by this device; skipping', e);
        return { applied: false, view: unreadable };
    }

    const now = env.now();
    // A hostile / oversize / unknown-version payload throws here: local state is untouched.
    const remote = parseMutesPayload(await env.decryptWithKey(body, contentKeyB64), now);
    const nextView: SlotView<MuteState> = {
        updatedAt: meta.updated_at, recipients, publisher: unwrapped.senderDeviceId ?? null, state: remote,
    };
    const local = env.loadLocalState();
    const merged = mergeMuteStates(local, remote, now);
    if (merged === local || sameMuteState(merged, local)) return { applied: false, view: nextView };
    env.saveLocalState(merged);
    return { applied: true, view: nextView };
}

export function mutesRepublishReason(
    view: SlotView<MuteState> | null, local: MuteState, ownDeviceIds: readonly string[] | null, myDeviceId: string, now: number,
) {
    return republishReason({
        view, local,
        isEmpty: isEmptyMuteState,
        merge: (a, b) => mergeMuteStates(a, b, now),
        same: sameMuteState,
        ownDeviceIds, myDeviceId,
    });
}

/** Publish the local state wrapped to this account's other devices; null when there is nothing to publish or nobody to tell. */
export async function publishMutes(env: MuteSyncEnv, myDeviceId: string): Promise<SlotView<MuteState> | null> {
    const state = env.loadLocalState();
    if (isEmptyMuteState(state)) return null;
    const ids = await env.listOwnDeviceIds();
    if (ids && !ids.some(id => id !== myDeviceId)) return null;
    const devices = (await env.fetchOwnDevices()).filter(d => d.device_id && d.spk_pub_b64 && d.device_id !== myDeviceId);
    if (devices.length === 0) return null;

    const contentKeyB64 = await env.generateContentKeyB64();
    const body = await env.encryptWithKey(buildMutesPayload(state, env.now()), contentKeyB64);
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);
    await env.uploadSlot(frameOwnSlot(MUTES_MAGIC, { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: keyEnvelope }, body));

    const meta = await env.getSlotMeta();
    if (!meta) return null;
    return { updatedAt: meta.updated_at, recipients: envelopeRecipientIds(keyEnvelope), publisher: myDeviceId, state };
}
