/**
 * personalEmojiSyncService - pull/publish for the `personal_emojis` own-device
 * slot: the My Emojis library following the user to their other devices.
 *
 * Same shape as personalSavesSyncService / gifLibrarySyncService: every side
 * effect goes through an env, so ordering and failure handling are unit-tested
 * against a fake. The slot is ONE opaque snapshot (container "CLEMJ1", see
 * utils/ownSlotSync.ts) only the account's own devices can open:
 *
 *   payload JSON { v, writtenAt, entries, tombstones, files: { id: base64(image bytes) },
 *                  entranceSound? }
 *
 * `entranceSound` (optional) is your custom call entrance sound riding along
 * in the same encrypted snapshot - it is one more small personal file that
 * must follow you between your devices, and a slot of its own would need a
 * server allowlist change for no gain. Shape, LWW merge and verification:
 * utils/customEntranceSound/transfer.ts. Absent (an older build published the
 * snapshot) means "no information", never "removed".
 *
 * The image bytes travel as plaintext INSIDE the encrypted body (<= 256 KB each,
 * 100 at most, typically a few KB) and each receiving device re-seals them under
 * its own per-item key (utils/personalEmoji/store.ts), so no at-rest key ever
 * crosses devices.
 *
 * ORDERING: image bytes are written to disk BEFORE the merged library is
 * persisted, and an entry whose bytes did not arrive (or do not hash to its id)
 * is left out of the merge entirely, so the library never lists an emoji that
 * cannot render. Best-effort: a throw leaves local state exactly as it was.
 */

import {
    frameOwnSlot, parseOwnSlotFrame, envelopeRecipientIds, republishReason, OWN_SLOT_CONTAINER_VERSION,
    type RepublishReason, type SlotView,
} from '../utils/ownSlotSync';
import type { OwnSlotEnv, UnwrappedKey } from './personalSavesSyncService';
import { mergeLibraries, sanitizeLibrary, emptyLibrary, type EmojiEntry, type EmojiLibState } from '../utils/personalEmoji/library';
import {
    b64ToBytes, bytesToB64, personalEmojiIdFromBytes, sniffImageMime, PERSONAL_EMOJI_MAX_BYTES,
} from '../utils/personalEmoji/token';
import type { EntranceSoundTransfer, ImportOutcome } from '../utils/customEntranceSound/transfer';

export const EMOJI_SNAPSHOT_MAGIC = 'CLEMJ1';
/** The `/v1/history` slot. Must match apps/api/src/history/backup-slots.ts. */
export const EMOJI_LIBRARY_SLOT = 'personal_emojis';

export interface EmojiSyncEnv extends OwnSlotEnv {
    loadLocalState(): EmojiLibState;
    /** Plaintext bytes of an emoji on this device, or null. */
    readBytes(id: string): Promise<Uint8Array | null>;
    hasBytes(id: string): boolean;
    writeBytes(entry: EmojiEntry, bytes: Uint8Array): Promise<void>;
    /** Merge + persist a remote snapshot (already file-backed). */
    applyRemote(remote: EmojiLibState): { changed: boolean; added: EmojiEntry[]; removed: string[] };
    /** Your custom entrance sound for the snapshot (undefined = nothing to say). */
    exportEntranceSound?(): Promise<EntranceSoundTransfer | undefined>;
    /** Apply the snapshot's entrance sound if newer (verifies before writing). */
    importEntranceSound?(raw: unknown): Promise<ImportOutcome>;
}

export interface EmojiPullResult {
    applied: boolean;
    /** What this device now knows about the slot (null: nothing, keep the previous view). */
    view: SlotView<EmojiLibState> | null;
    /** Remote entries whose bytes were missing or did not match their id. */
    incomplete: string[];
}

const warn = (env: OwnSlotEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[emojiSync] ${m}`, e)))(msg, err);
const normalizeUnwrap = (u: string | UnwrappedKey): UnwrappedKey => (typeof u === 'string' ? { contentJson: u } : u);

interface SnapshotPayload { v: number; writtenAt: number; state: EmojiLibState; files: Record<string, string>; entranceSound?: unknown }

export function parseEmojiPayload(json: string): SnapshotPayload {
    let raw: unknown;
    try { raw = JSON.parse(json); } catch { throw new Error('emoji snapshot is not valid JSON'); }
    if (!raw || typeof raw !== 'object') throw new Error('emoji snapshot is not an object');
    const r = raw as { v?: unknown; writtenAt?: unknown; entries?: unknown; tombstones?: unknown; files?: unknown; entranceSound?: unknown };
    const files: Record<string, string> = {};
    if (r.files && typeof r.files === 'object') {
        for (const [id, b64] of Object.entries(r.files as Record<string, unknown>)) if (typeof b64 === 'string' && b64) files[id] = b64;
    }
    return {
        v: typeof r.v === 'number' ? r.v : 1,
        writtenAt: typeof r.writtenAt === 'number' ? r.writtenAt : 0,
        state: sanitizeLibrary({ entries: r.entries, tombstones: r.tombstones }),
        files,
        ...(r.entranceSound !== undefined ? { entranceSound: r.entranceSound } : {}),
    };
}

/** Are these bytes really `entry`? (size cap, image magic, content hash.) */
async function bytesMatch(entry: EmojiEntry, bytes: Uint8Array): Promise<boolean> {
    if (bytes.length === 0 || bytes.length > PERSONAL_EMOJI_MAX_BYTES) return false;
    if (!sniffImageMime(bytes)) return false;
    return (await personalEmojiIdFromBytes(bytes)) === entry.id;
}

export async function pullEmojis(env: EmojiSyncEnv, view: SlotView<EmojiLibState> | null): Promise<EmojiPullResult> {
    const none = (v: SlotView<EmojiLibState> | null): EmojiPullResult => ({ applied: false, view: v, incomplete: [] });
    const meta = await env.getSlotMeta();
    if (!meta) return none(null);
    if (view && view.updatedAt === meta.updated_at) return none(view);

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return none(null);

    const { header, body } = parseOwnSlotFrame(EMOJI_SNAPSHOT_MAGIC, bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);
    let contentKeyB64: string;
    let publisher: string | null = null;
    try {
        const unwrapped = normalizeUnwrap(await env.unwrapFromEnvelope(header.key_envelope_b64));
        publisher = unwrapped.senderDeviceId ?? null;
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        // Not addressed to this device yet, or not written by one of our devices:
        // nothing to merge, and we must not republish over a slot we never saw.
        warn(env, 'emoji snapshot is not readable by this device; skipping', e);
        return none({ updatedAt: meta.updated_at, recipients, publisher: null, state: null });
    }

    const payload = parseEmojiPayload(await env.decryptWithKey(body, contentKeyB64));
    const incomplete: string[] = [];
    const usable: EmojiEntry[] = [];
    for (const entry of payload.state.entries) {
        if (env.hasBytes(entry.id)) { usable.push(entry); continue; }
        const b64 = payload.files[entry.id];
        if (!b64) { incomplete.push(entry.id); continue; }
        try {
            const img = b64ToBytes(b64);
            if (!(await bytesMatch(entry, img))) { incomplete.push(entry.id); continue; }
            await env.writeBytes(entry, img);
            usable.push(entry);
        } catch (e) {
            warn(env, `could not materialise emoji ${entry.id}`, e);
            incomplete.push(entry.id);
        }
    }

    const nextView: SlotView<EmojiLibState> = {
        updatedAt: meta.updated_at, recipients, publisher,
        state: { entries: payload.state.entries, tombstones: payload.state.tombstones },
    };
    const res = env.applyRemote({ entries: usable, tombstones: payload.state.tombstones });
    let soundApplied = false;
    if (payload.entranceSound !== undefined && env.importEntranceSound) {
        try { soundApplied = (await env.importEntranceSound(payload.entranceSound)) === 'applied'; }
        catch (e) { warn(env, 'could not apply the entrance sound', e); }
    }
    return { applied: res.changed || soundApplied, view: nextView, incomplete };
}

/** What a publish would carry: entries only, minus ids whose bytes cannot be read. */
export function publishableLibrary(state: EmojiLibState, unpublishable: ReadonlySet<string> = new Set()): EmojiLibState {
    return { entries: state.entries.filter(e => !unpublishable.has(e.id)), tombstones: state.tombstones };
}

const libraryShape = (s: EmojiLibState) => {
    const c = mergeLibraries(emptyLibrary(), s);
    return JSON.stringify([c.entries.map(e => [e.id, e.name, e.order, e.at]), Object.entries(c.tombstones).sort(([a], [b]) => (a < b ? -1 : 1))]);
};
export const sameLibrary = (a: EmojiLibState, b: EmojiLibState) => libraryShape(a) === libraryShape(b);

export function emojiRepublishReason(
    view: SlotView<EmojiLibState> | null,
    local: EmojiLibState,
    ownDeviceIds: readonly string[] | null,
    myDeviceId: string,
    unpublishable: ReadonlySet<string> = new Set(),
): RepublishReason {
    return republishReason({
        view,
        local: publishableLibrary(local, unpublishable),
        isEmpty: s => s.entries.length === 0 && Object.keys(s.tombstones).length === 0,
        merge: mergeLibraries,
        same: sameLibrary,
        ownDeviceIds,
        myDeviceId,
    });
}

export interface EmojiPublishResult {
    published: boolean;
    view: SlotView<EmojiLibState> | null;
    /** Entries left out because their bytes could not be read. */
    skipped: string[];
}

export async function publishEmojis(env: EmojiSyncEnv, myDeviceId?: string): Promise<EmojiPublishResult> {
    const nothing: EmojiPublishResult = { published: false, view: null, skipped: [] };
    // Non-claiming check first: the prekey bundle below spends a one-time prekey
    // per device, which a single-device account would pay for nobody to read.
    if (env.listOwnDeviceIds && myDeviceId) {
        const ids = await env.listOwnDeviceIds();
        if (ids && !ids.some(id => id !== myDeviceId)) return nothing;
    }
    const local = env.loadLocalState();
    const devices = (await env.fetchOwnDevices()).filter(d => d.device_id && d.spk_pub_b64);
    if (devices.length === 0) return nothing;

    const files: Record<string, string> = {};
    const skipped: string[] = [];
    for (const e of local.entries) {
        let img: Uint8Array | null = null;
        try { img = await env.readBytes(e.id); } catch (err) { warn(env, `could not read emoji ${e.id}`, err); }
        if (!img || img.length === 0) { skipped.push(e.id); continue; }
        files[e.id] = bytesToB64(img);
    }
    // Entries go up only with their bytes; tombstones go up whole.
    const entries = local.entries.filter(e => files[e.id]);
    let entranceSound: EntranceSoundTransfer | undefined;
    try { entranceSound = await env.exportEntranceSound?.(); } catch (err) { warn(env, 'could not read the entrance sound', err); }
    const contentKeyB64 = await env.generateContentKeyB64();
    const body = await env.encryptWithKey(
        JSON.stringify({ v: 1, writtenAt: env.now(), entries, tombstones: local.tombstones, files, ...(entranceSound ? { entranceSound } : {}) }),
        contentKeyB64,
    );
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);
    await env.uploadSlot(frameOwnSlot(EMOJI_SNAPSHOT_MAGIC, { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: keyEnvelope }, body));

    const meta = await env.getSlotMeta();
    return {
        published: true,
        view: meta ? {
            updatedAt: meta.updated_at, recipients: envelopeRecipientIds(keyEnvelope),
            publisher: myDeviceId ?? null, state: { entries, tombstones: local.tombstones },
        } : null,
        skipped,
    };
}
