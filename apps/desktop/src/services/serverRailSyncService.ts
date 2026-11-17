/**
 * serverRailSyncService - pull/publish for the `server_rail` own-device slot.
 *
 * Keeps the desktop SERVER RAIL layout (server order + folders) in step across
 * this account's devices (other desktops, the native mobile app). Same shape
 * and posture as achievementsSyncService / personalSavesSyncService
 * (best-effort, never blocking, a throw leaves local state exactly as it was),
 * with one difference in the merge: the snapshot is the WHOLE layout and the
 * rule is last-write-wins on `updatedAt` (epoch ms), not a CRDT merge. A rail
 * layout is one personal arrangement; interleaving two devices' arrangements
 * would produce a layout nobody chose.
 *
 * The server only ever holds an opaque client-encrypted blob wrapped to this
 * account's devices; a folder name or a server id is never sent in plaintext.
 * Wire format: docs/server-rail-sync.md.
 */
import {
    frameOwnSlot, parseOwnSlotFrame, envelopeRecipientIds, republishReason, OWN_SLOT_CONTAINER_VERSION, type SlotView,
} from '../utils/ownSlotSync';
import {
    flattenServerIds, parseRailLayout, serializeRailLayout,
} from '../components/rail/serverFolders';
import {
    applyIncludedKv, dropShadowingRailLayout, toPortableKey, BACKUP_RESTORED_EVENT,
} from './backupRegistry';
import type { OwnSlotEnv, UnwrappedKey } from './personalSavesSyncService';

export const SERVER_RAIL_SNAPSHOT_MAGIC = 'CLRAIL1';
export const SERVER_RAIL_SLOT = 'server_rail';
const PAYLOAD_VERSION = 1;
/** Decrypted payloads larger than this are refused (a real layout is a few KB). */
export const MAX_RAIL_PAYLOAD_BYTES = 512 * 1024;
/** A snapshot stamped further ahead than this is treated as corrupt/hostile: it would otherwise win LWW forever. */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Fired (on window) by useServerRailLayout after the USER changed the rail. `detail.userId`. */
export const RAIL_LAYOUT_CHANGED_EVENT = 'cipherline:server-rail-changed';
/** Marks the BACKUP_RESTORED_EVENT this service dispatches after adopting a remote layout, so the sync hook does not treat it as a user restore. */
export const RAIL_SYNC_EVENT_SOURCE = 'rail-sync';

export const serverRailLayoutKey = (uid: string) => `cipherline_server_rail_layout_${uid}`;
export const serverRailOrderKey = (uid: string) => `cipherline_server_rail_order_${uid}`;
/** When THIS device's rail layout was last changed (epoch ms). Device-specific bookkeeping: never backed up. */
export const serverRailSyncTsKey = (uid: string) => `cipherline_server_rail_sync_ts_${uid}`;
/** What this DEVICE last knew about the slot. Device-specific: never restored from a backup. */
export const serverRailViewKey = (uid: string) => `cipherline_server_rail_sync_view_${uid}`;

/** The synced state: the v2 layout object exactly as stored, stamped with its last-change time. updatedAt 0 = this device never had a layout (nothing to publish). */
export interface RailSnapshot {
    updatedAt: number;
    layout: unknown | null;
}

export interface RailStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

// ── Local state <-> store ───────────────────────────────────────────────────

/**
 * This device's rail as a snapshot. The layout is read exactly as
 * useServerRailLayout wrote it (v2 record preferred, legacy flat order as the
 * fallback, canonicalised to v2). A layout with no recorded change time (one
 * that predates this feature) is stamped 1 ms: old enough to lose to any real
 * snapshot, but publishable into an EMPTY slot so existing users seed it.
 */
export function loadLocalRailSnapshot(store: RailStore, uid: string): RailSnapshot {
    let layout: unknown | null = null;
    try {
        const raw = store.getItem(serverRailLayoutKey(uid));
        if (raw) layout = JSON.parse(serializeRailLayout(parseRailLayout(JSON.parse(raw))));
    } catch { /* corrupt v2 record: fall back to the legacy order */ }
    if (layout === null) {
        try {
            const raw = store.getItem(serverRailOrderKey(uid));
            if (raw) layout = JSON.parse(serializeRailLayout(parseRailLayout(JSON.parse(raw))));
        } catch { /* corrupt: nothing to sync */ }
    }
    if (layout === null) return { updatedAt: 0, layout: null };
    const ts = Number(store.getItem(serverRailSyncTsKey(uid)));
    return { updatedAt: Number.isSafeInteger(ts) && ts > 0 ? ts : 1, layout };
}

/**
 * Adopt a remote snapshot IF it is strictly newer than the local one. Goes
 * through the same code a backup restore uses (dropShadowingRailLayout +
 * applyIncludedKv over the registry-classified keys), so servers this account
 * has left or does not know are handled exactly as after a restore: the raw
 * layout is stored and reconcileRailLayout trims it at render time.
 * `notify` then tells the running rail hook to re-read; it does not mark the
 * hook dirty, so nothing is written back and nothing is pushed.
 * Returns true when the local layout was replaced.
 */
export function adoptRemoteRail(store: RailStore, uid: string, remote: RailSnapshot, notify: () => void): boolean {
    const local = loadLocalRailSnapshot(store, uid);
    if (remote.updatedAt <= local.updatedAt) return false; // stale or tie: local wins
    const layout = parseRailLayout(remote.layout);
    const layoutJson = serializeRailLayout(layout);
    const kv: Record<string, string> = {
        [toPortableKey(serverRailLayoutKey(uid), uid)]: layoutJson,
        [toPortableKey(serverRailOrderKey(uid), uid)]: JSON.stringify(flattenServerIds(layout)),
    };
    dropShadowingRailLayout(store, kv, uid);
    applyIncludedKv(store, kv, uid);
    store.setItem(serverRailSyncTsKey(uid), String(remote.updatedAt));
    notify();
    return true;
}

/** Dispatch the "settings changed under you" event the rail hook already listens for. */
export function notifyRailRestored(uid: string): void {
    try { window.dispatchEvent(new CustomEvent(BACKUP_RESTORED_EVENT, { detail: { userId: uid, source: RAIL_SYNC_EVENT_SOURCE } })); } catch { /* non-fatal */ }
}

// ── Payload ─────────────────────────────────────────────────────────────────

export interface RailSyncEnv extends OwnSlotEnv {
    loadLocalState(): RailSnapshot;
    /** Adopt a remote snapshot if newer (LWW). Returns true if local changed. */
    mergeRemote(remote: RailSnapshot): boolean;
}

export interface RailPullResult { applied: boolean; view: SlotView<RailSnapshot> | null }

const warn = (env: OwnSlotEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[serverRailSync] ${m}`, e)))(msg, err);
const normalizeUnwrap = (u: string | UnwrappedKey): UnwrappedKey => (typeof u === 'string' ? { contentJson: u } : u);

export function buildRailPayload(state: RailSnapshot): { v: number; updatedAt: number; layout: unknown } {
    return { v: PAYLOAD_VERSION, updatedAt: state.updatedAt, layout: state.layout };
}

/** Parse + validate a decrypted payload. Throws on anything malformed (never coerces). */
export function parseRailPayload(json: string, now: number): RailSnapshot {
    if (json.length > MAX_RAIL_PAYLOAD_BYTES) throw new Error('server rail payload too large');
    const o = JSON.parse(json) as { v?: unknown; updatedAt?: unknown; layout?: unknown } | null;
    if (!o || typeof o !== 'object') throw new Error('server rail payload is not an object');
    if (o.v !== PAYLOAD_VERSION) throw new Error(`unsupported server rail payload version ${String(o.v)}`);
    if (typeof o.updatedAt !== 'number' || !Number.isSafeInteger(o.updatedAt) || o.updatedAt <= 0) throw new Error('bad updatedAt');
    if (o.updatedAt > now + MAX_FUTURE_SKEW_MS) throw new Error('updatedAt is too far in the future');
    const layout = o.layout as { items?: unknown } | null;
    if (!layout || typeof layout !== 'object' || !Array.isArray(layout.items)) throw new Error('bad layout');
    return { updatedAt: o.updatedAt, layout };
}

/** Probe the slot; if it changed since `view`, download, verify, decrypt and apply (LWW). Never publishes. */
export async function pullServerRail(env: RailSyncEnv, view: SlotView<RailSnapshot> | null): Promise<RailPullResult> {
    const meta = await env.getSlotMeta();
    if (!meta) return { applied: false, view: null };
    if (view && view.updatedAt === meta.updated_at) return { applied: false, view };

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return { applied: false, view: null };

    const { header, body } = parseOwnSlotFrame(SERVER_RAIL_SNAPSHOT_MAGIC, bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);
    const unreadable: SlotView<RailSnapshot> = { updatedAt: meta.updated_at, recipients, publisher: null, state: null };

    let unwrapped: UnwrappedKey;
    let contentKeyB64: string;
    try {
        unwrapped = normalizeUnwrap(await env.unwrapFromEnvelope(header.key_envelope_b64));
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        // Not addressed to this device yet, or not written by one of our devices.
        warn(env, 'server rail snapshot is not readable by this device; skipping', e);
        return { applied: false, view: unreadable };
    }

    const remote = parseRailPayload(await env.decryptWithKey(body, contentKeyB64), env.now());
    const nextView: SlotView<RailSnapshot> = {
        updatedAt: meta.updated_at, recipients, publisher: unwrapped.senderDeviceId ?? null, state: remote,
    };
    return { applied: env.mergeRemote(remote), view: nextView };
}

const newer = (a: RailSnapshot, b: RailSnapshot): RailSnapshot => (a.updatedAt >= b.updatedAt ? a : b);

export function serverRailRepublishReason(
    view: SlotView<RailSnapshot> | null, local: RailSnapshot, ownDeviceIds: readonly string[] | null, myDeviceId: string,
) {
    return republishReason({
        view, local,
        isEmpty: s => s.updatedAt === 0,
        merge: newer,
        same: (a, b) => a.updatedAt === b.updatedAt,
        ownDeviceIds, myDeviceId,
    });
}

/** Publish the local layout wrapped to this account's other devices; null when there is nothing to publish or nobody to tell. */
export async function publishServerRail(env: RailSyncEnv, myDeviceId: string): Promise<SlotView<RailSnapshot> | null> {
    const state = env.loadLocalState();
    if (state.updatedAt === 0 || state.layout === null) return null;
    const ids = await env.listOwnDeviceIds();
    if (ids && !ids.some(id => id !== myDeviceId)) return null;
    const devices = (await env.fetchOwnDevices()).filter(d => d.device_id && d.spk_pub_b64 && d.device_id !== myDeviceId);
    if (devices.length === 0) return null;

    const contentKeyB64 = await env.generateContentKeyB64();
    const body = await env.encryptWithKey(JSON.stringify(buildRailPayload(state)), contentKeyB64);
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);
    await env.uploadSlot(frameOwnSlot(SERVER_RAIL_SNAPSHOT_MAGIC, { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: keyEnvelope }, body));

    const meta = await env.getSlotMeta();
    if (!meta) return null;
    return { updatedAt: meta.updated_at, recipients: envelopeRecipientIds(keyEnvelope), publisher: myDeviceId, state };
}
