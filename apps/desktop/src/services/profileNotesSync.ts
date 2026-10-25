/**
 * profileNotesSync - pull/publish for the `profile_notes` own-device slot.
 *
 * Same shape and posture as achievementsSyncService (best-effort, never
 * blocking, a throw leaves local state as it was): the snapshot is the whole
 * NotesState, merged by utils/profileNotes.ts (per-person LWW + tombstones).
 * The server only ever holds one opaque blob, client-encrypted and wrapped to
 * this account's OTHER devices; a note is never sent to it in plaintext.
 */
import {
    frameOwnSlot, parseOwnSlotFrame, envelopeRecipientIds, republishReason, OWN_SLOT_CONTAINER_VERSION, type SlotView,
} from '../utils/ownSlotSync';
import {
    isEmptyNotes, mergeNotes, sameNotes, sanitizeNotes, type NotesState,
} from '../utils/profileNotes';
import type { OwnSlotEnv, UnwrappedKey } from './personalSavesSyncService';

export const NOTES_SNAPSHOT_MAGIC = 'CLNOT1';
const PAYLOAD_VERSION = 1;

export interface NotesSyncEnv extends OwnSlotEnv {
    loadLocalState(): NotesState;
    /** Adopt a remote snapshot (merge + persist). Returns true if local changed. */
    mergeRemote(remote: NotesState): boolean;
}

export interface NotesPullResult { applied: boolean; view: SlotView<NotesState> | null }

const warn = (env: OwnSlotEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[notesSync] ${m}`, e)))(msg, err);
const normalizeUnwrap = (u: string | UnwrappedKey): UnwrappedKey => (typeof u === 'string' ? { contentJson: u } : u);

export function buildNotesPayload(state: NotesState, now: number): { v: number; writtenAt: number; state: NotesState } {
    return { v: PAYLOAD_VERSION, writtenAt: now, state };
}
export function parseNotesPayload(json: string): NotesState {
    const o = JSON.parse(json) as { state?: unknown } | null;
    return sanitizeNotes(o?.state);
}

/** Probe the slot; if it changed since `view`, download, verify, decrypt and merge. Never publishes. */
export async function pullNotes(env: NotesSyncEnv, view: SlotView<NotesState> | null): Promise<NotesPullResult> {
    const meta = await env.getSlotMeta();
    if (!meta) return { applied: false, view: null };
    if (view && view.updatedAt === meta.updated_at) return { applied: false, view };

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return { applied: false, view: null };

    const { header, body } = parseOwnSlotFrame(NOTES_SNAPSHOT_MAGIC, bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);
    const unreadable: SlotView<NotesState> = { updatedAt: meta.updated_at, recipients, publisher: null, state: null };

    let unwrapped: UnwrappedKey;
    let contentKeyB64: string;
    try {
        unwrapped = normalizeUnwrap(await env.unwrapFromEnvelope(header.key_envelope_b64));
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        warn(env, 'notes snapshot is not readable by this device; skipping', e);
        return { applied: false, view: unreadable };
    }

    const remote = parseNotesPayload(await env.decryptWithKey(body, contentKeyB64));
    const nextView: SlotView<NotesState> = {
        updatedAt: meta.updated_at, recipients, publisher: unwrapped.senderDeviceId ?? null, state: remote,
    };
    return { applied: env.mergeRemote(remote), view: nextView };
}

export function notesRepublishReason(
    view: SlotView<NotesState> | null, local: NotesState, ownDeviceIds: readonly string[] | null, myDeviceId: string,
) {
    return republishReason({ view, local, isEmpty: isEmptyNotes, merge: mergeNotes, same: sameNotes, ownDeviceIds, myDeviceId });
}

/** Publish the local notes wrapped to this account's other devices; null when there is nobody to tell. */
export async function publishNotes(env: NotesSyncEnv, myDeviceId: string): Promise<SlotView<NotesState> | null> {
    const ids = await env.listOwnDeviceIds();
    if (ids && !ids.some((id) => id !== myDeviceId)) return null;
    const devices = (await env.fetchOwnDevices()).filter((d) => d.device_id && d.spk_pub_b64 && d.device_id !== myDeviceId);
    if (devices.length === 0) return null;

    const state = env.loadLocalState();
    const contentKeyB64 = await env.generateContentKeyB64();
    const body = await env.encryptWithKey(JSON.stringify(buildNotesPayload(state, env.now())), contentKeyB64);
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);
    await env.uploadSlot(frameOwnSlot(NOTES_SNAPSHOT_MAGIC, { v: OWN_SLOT_CONTAINER_VERSION, key_envelope_b64: keyEnvelope }, body));

    const meta = await env.getSlotMeta();
    if (!meta) return null;
    return { updatedAt: meta.updated_at, recipients: envelopeRecipientIds(keyEnvelope), publisher: myDeviceId, state };
}
