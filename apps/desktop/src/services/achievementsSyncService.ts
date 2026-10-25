/**
 * achievementsSyncService — pull/publish for the `achievements` own-device slot.
 *
 * Same shape and posture as personalSavesSyncService (best-effort, never
 * blocking, a throw leaves local state exactly as it was); the snapshot is the
 * whole AchievementsState, merged with state.ts's CRDT merge. The server only
 * ever holds an opaque client-encrypted blob wrapped to this account's devices.
 */
import {
    frameOwnSlot, parseOwnSlotFrame, envelopeRecipientIds, republishReason, OWN_SLOT_CONTAINER_VERSION, type SlotView,
} from '../utils/ownSlotSync';
import {
    isEmptyState, mergeState, sameState, sanitizeState, type AchievementsState,
} from '../utils/achievements/state';
import type { OwnSlotEnv, UnwrappedKey } from './personalSavesSyncService';

export const ACHIEVEMENTS_SNAPSHOT_MAGIC = 'CLACH1';
const PAYLOAD_VERSION = 1;

export interface AchievementsSyncEnv extends OwnSlotEnv {
    loadLocalState(): AchievementsState;
    /** Adopt a remote snapshot (merge + persist). Returns true if local changed. */
    mergeRemote(remote: AchievementsState): boolean;
}

export interface AchievementsPullResult {
    applied: boolean;
    view: SlotView<AchievementsState> | null;
}

const warn = (env: OwnSlotEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[achievementsSync] ${m}`, e)))(msg, err);

const normalizeUnwrap = (u: string | UnwrappedKey): UnwrappedKey => (typeof u === 'string' ? { contentJson: u } : u);

export function buildAchievementsPayload(state: AchievementsState, now: number): { v: number; writtenAt: number; state: AchievementsState } {
    return { v: PAYLOAD_VERSION, writtenAt: now, state };
}

export function parseAchievementsPayload(json: string): AchievementsState {
    const o = JSON.parse(json) as { state?: unknown } | null;
    return sanitizeState(o?.state);
}

/** Probe the slot; if it changed since `view`, download, verify, decrypt and merge. Never publishes. */
export async function pullAchievements(env: AchievementsSyncEnv, view: SlotView<AchievementsState> | null): Promise<AchievementsPullResult> {
    const meta = await env.getSlotMeta();
    if (!meta) return { applied: false, view: null };
    if (view && view.updatedAt === meta.updated_at) return { applied: false, view };

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return { applied: false, view: null };

    const { header, body } = parseOwnSlotFrame(ACHIEVEMENTS_SNAPSHOT_MAGIC, bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);
    const unreadable: SlotView<AchievementsState> = { updatedAt: meta.updated_at, recipients, publisher: null, state: null };

    let unwrapped: UnwrappedKey;
    let contentKeyB64: string;
    try {
        unwrapped = normalizeUnwrap(await env.unwrapFromEnvelope(header.key_envelope_b64));
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        // Not addressed to this device yet, or not written by one of our devices.
        warn(env, 'achievements snapshot is not readable by this device; skipping', e);
        return { applied: false, view: unreadable };
    }

    const remote = parseAchievementsPayload(await env.decryptWithKey(body, contentKeyB64));
    const nextView: SlotView<AchievementsState> = {
        updatedAt: meta.updated_at, recipients, publisher: unwrapped.senderDeviceId ?? null, state: remote,
    };
    return { applied: env.mergeRemote(remote), view: nextView };
}

export function achievementsRepublishReason(
    view: SlotView<AchievementsState> | null,
    local: AchievementsState,
    ownDeviceIds: readonly string[] | null,
    myDeviceId: string,
) {
    return republishReason({ view, local, isEmpty: isEmptyState, merge: mergeState, same: sameState, ownDeviceIds, myDeviceId });
}

/** Publish the local state wrapped to this account's other devices; null when there is nobody to tell. */
export async function publishAchievements(env: AchievementsSyncEnv, myDeviceId: string): Promise<SlotView<AchievementsState> | null> {
    const ids = await env.listOwnDeviceIds();
    if (ids && !ids.some(id => id !== myDeviceId)) return null;
    const devices = (await env.fetchOwnDevices()).filter(d => d.device_id && d.spk_pub_b64 && d.device_id !== myDeviceId);
    if (devices.length === 0) return null;

    const state = env.loadLocalState();
    const contentKeyB64 = await env.generateContentKeyB64();
    const body = await env.encryptWithKey(JSON.stringify(buildAchievementsPayload(state, env.now())), contentKeyB64);
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);
    await env.uploadSlot(frameOwnSlot(ACHIEVEMENTS_SNAPSHOT_MAGIC, { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: keyEnvelope }, body));

    const meta = await env.getSlotMeta();
    if (!meta) return null;
    return { updatedAt: meta.updated_at, recipients: envelopeRecipientIds(keyEnvelope), publisher: myDeviceId, state };
}
