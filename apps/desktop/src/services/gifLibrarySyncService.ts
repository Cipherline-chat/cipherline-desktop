/**
 * gifLibrarySyncService — pull/publish orchestration for GIF-library sync.
 *
 * Every side effect (network, IPC, crypto) is reached through `GifSyncEnv`, so
 * the ordering and failure handling below — the part that is actually easy to
 * get wrong — is unit-testable against a fake environment.
 *
 * ORDERING RULES, and why they are what they are:
 *
 *  • On pull, file bytes are written BEFORE the merged metadata is persisted.
 *    A crash between the two leaves an orphan `.enc` file, which is harmless
 *    and gets swept by the next publish. The other order would leave metadata
 *    pointing at a file that does not exist, which is what the picker renders
 *    as a permanently broken tile.
 *
 *  • A GIF whose bytes or key failed to arrive is dropped from the merge
 *    entirely rather than merged as metadata-only, for the same reason.
 *
 *  • Local deletions delete the file last. A tombstone with the file still on
 *    disk is recoverable; a deleted file the ledger doesn't know about is not.
 *
 * FAILURE POSTURE: sync is best-effort and must never block or corrupt the
 * local library. Any throw leaves local state exactly as it was.
 */

import {
    mergeGifLibraries,
    diffLibraries,
    emptyLibraryState,
    isKlipyRefEntry,
    isSyncableGifEntry,
    type GifLibraryState,
    type GifLibraryDiff,
} from '../utils/gifLibrarySync';
import {
    envelopeRecipientIds,
    isSafeSyncId,
    republishReason,
    type RepublishReason,
    type SlotView,
} from '../utils/ownSlotSync';
import type { UnwrappedKey } from './personalSavesSyncService';
import {
    frameSnapshot,
    parseSnapshotFrame,
    parseSnapshotPayload,
    buildSnapshotPayload,
    bytesToBase64,
    base64ToBytes,
    GIF_SNAPSHOT_VERSION,
} from '../utils/gifLibraryTransport';

export interface GifSyncEnv {
    /** Signed prekey bundles for the user's OWN devices, mapped to the shape
     *  `encryptMessageV2` wants. Claims a one-time prekey per device per call,
     *  so this is only ever called on publish — never on a poll. */
    fetchOwnDevices(): Promise<{ device_id: string; spk_pub_b64: string; sig_b64?: string; identity_pub_b64?: string }[]>;
    /** ECIES-wrap `plaintext` to the given devices. Returns the envelope. */
    wrapToDevices(plaintext: string, devices: { device_id: string; spk_pub_b64: string }[]): Promise<string>;
    /** Reverse of wrapToDevices, using this device's own private key. The
     *  real env also verifies the sender is one of this account's devices
     *  and throws otherwise (ownSlotEnv.ts). */
    unwrapFromEnvelope(envelopeB64: string): Promise<string | UnwrappedKey>;
    /** This account's current device ids, via a lookup that claims nothing.
     *  Optional: without it the single-device pre-check is skipped. */
    listOwnDeviceIds?(): Promise<string[] | null>;

    generateContentKeyB64(): Promise<string>;
    encryptWithKey(plaintext: string, keyB64: string): Promise<Uint8Array>;
    decryptWithKey(bytes: Uint8Array, keyB64: string): Promise<string>;

    readGifBytes(gifId: string): Promise<Uint8Array | null>;
    writeGifBytes(gifId: string, bytes: Uint8Array): Promise<void>;
    deleteGifBytes(gifId: string): Promise<void>;

    getGifKeyB64(gifId: string): string | null;
    putGifKeyB64(gifId: string, keyB64: string): void;

    /** Cheap change-detection. Null when the slot has never been written. */
    getSlotMeta(): Promise<{ backup_id: string; updated_at: string } | null>;
    downloadSlot(): Promise<Uint8Array | null>;
    uploadSlot(bytes: Uint8Array): Promise<void>;

    loadLocalState(): GifLibraryState;
    saveLocalState(state: GifLibraryState): void;

    now(): number;
    log?(msg: string, err?: unknown): void;
}

export interface PullResult {
    /** False when there was nothing to do (no slot, or unchanged). */
    applied: boolean;
    state: GifLibraryState;
    diff: GifLibraryDiff;
    /** Ids present in the remote metadata whose bytes or key never arrived. */
    incomplete: string[];
    /**
     * The slot revision this call actually looked at, or null if there was
     * none. Callers persist THIS rather than re-probing: recording a revision
     * you never read would skip a real update forever.
     */
    seen: string | null;
    /**
     * What this device now knows about the slot (for the anti-entropy check),
     * or undefined when this call learned nothing new — keep the previous one.
     * `state` is the slot's METADATA as published (entries + ledger, no bytes
     * or keys), or null when this device could not read the snapshot.
     */
    view?: SlotView<GifLibraryState> | null;
}

const warn = (env: GifSyncEnv, msg: string, err?: unknown) =>
    (env.log ?? ((m: string, e?: unknown) => console.warn(`[gifSync] ${m}`, e)))(msg, err);

/**
 * Fetch the remote snapshot, merge it into the local library, and materialise
 * whatever new bytes arrived.
 *
 * `lastSeen` is the `updated_at` this device already applied; when it matches
 * the slot's current value nothing is downloaded. That check is the only thing
 * standing between an idle client and re-downloading a multi-MB blob forever,
 * so callers should persist and pass it.
 */
export async function pullLibrary(env: GifSyncEnv, lastSeen?: string | null): Promise<PullResult> {
    const local = env.loadLocalState();
    const none = (seen: string | null): PullResult =>
        ({ applied: false, state: local, diff: { added: [], removed: [] }, incomplete: [], seen });

    const meta = await env.getSlotMeta();
    if (!meta) return { ...none(null), view: null };
    const seen = meta.updated_at;
    if (lastSeen && seen === lastSeen) return none(seen);

    const bytes = await env.downloadSlot();
    if (!bytes || bytes.length === 0) return none(seen);

    const { header, body } = parseSnapshotFrame(bytes);
    const recipients = envelopeRecipientIds(header.key_envelope_b64);

    // If this device isn't addressed in the envelope, the content key is not
    // derivable here. That is the expected state for a device registered after
    // the snapshot was written — not an error worth surfacing to the user.
    // The same path refuses a snapshot another account's key wrote (the real
    // env verifies the sender): it is never merged.
    let contentKeyB64: string;
    let publisher: string | null = null;
    try {
        const raw = await env.unwrapFromEnvelope(header.key_envelope_b64);
        const unwrapped: UnwrappedKey = typeof raw === 'string' ? { contentJson: raw } : raw;
        publisher = unwrapped.senderDeviceId ?? null;
        contentKeyB64 = JSON.parse(unwrapped.contentJson).k;
        if (typeof contentKeyB64 !== 'string' || !contentKeyB64) throw new Error('no key in envelope');
    } catch (e) {
        warn(env, 'snapshot is not readable by this device yet; skipping', e);
        return { ...none(seen), view: { updatedAt: seen, recipients, publisher: null, state: null } };
    }

    const parsed = parseSnapshotPayload(await env.decryptWithKey(body, contentKeyB64));

    // Only what may travel: ids that are safe as file names, entries the sync
    // is allowed to carry (isSyncableGifEntry: KLIPY references yes, KLIPY
    // byte copies never — see KLIPY_GIF_SYNC_ENABLED). A refused entry is
    // dropped together with its ledger timestamp — a timestamp with no entry
    // is a tombstone, and a refusal must never delete a local GIF elsewhere.
    const refused = new Set(parsed.entries
        .filter(e => !isSafeSyncId(e.id) || !isSyncableGifEntry(e))
        .map(e => e.id));
    const payload = {
        ...parsed,
        entries: parsed.entries.filter(e => !refused.has(e.id)),
        ledger: Object.fromEntries(Object.entries(parsed.ledger)
            .filter(([id]) => isSafeSyncId(id) && !refused.has(id))),
    };
    const view: SlotView<GifLibraryState> = {
        updatedAt: seen,
        recipients,
        publisher,
        state: { entries: payload.entries, ledger: payload.ledger },
    };

    // Materialise bytes + keys for everything this device doesn't already have.
    // Anything that fails is excluded from the merge so metadata never outruns
    // the files behind it.
    const incomplete: string[] = [];
    const haveLocally = new Set(local.entries.map(e => e.id));
    const usable: typeof payload.entries = [];

    for (const entry of payload.entries) {
        if (haveLocally.has(entry.id)) { usable.push(entry); continue; }
        // A KLIPY reference is metadata only: nothing to materialise, and
        // nothing may be written to disk for it (KLIPY media is never stored).
        if (isKlipyRefEntry(entry)) { usable.push(entry); continue; }

        const keyB64 = payload.keys[entry.id];
        const fileB64 = payload.files[entry.id];
        if (!keyB64 || !fileB64) { incomplete.push(entry.id); continue; }

        try {
            await env.writeGifBytes(entry.id, base64ToBytes(fileB64));
            env.putGifKeyB64(entry.id, keyB64);
            usable.push(entry);
        } catch (e) {
            warn(env, `could not materialise gif ${entry.id}`, e);
            incomplete.push(entry.id);
        }
    }

    // An id the remote LISTED but we could not materialise must be dropped
    // from the ledger too, not just from the entries. Keeping its timestamp
    // with no entry behind it is indistinguishable from a tombstone — this
    // device would then republish "that GIF was deleted" and the failed
    // download would propagate as a real deletion to every other device.
    //
    // A tombstone the remote genuinely sent (an id in `ledger` that was never
    // in `entries`) carries no bytes by definition and is kept.
    const failed = new Set(incomplete);
    const remoteLedger: typeof payload.ledger = {};
    for (const [id, at] of Object.entries(payload.ledger)) {
        if (!failed.has(id)) remoteLedger[id] = at;
    }

    const merged = mergeGifLibraries(local, { entries: usable, ledger: remoteLedger });
    if (merged === local) return { applied: false, state: local, diff: { added: [], removed: [] }, incomplete, seen, view };

    const diff = diffLibraries(local, merged);
    env.saveLocalState(merged);

    // Only now drop the bytes for GIFs the merge removed.
    for (const id of diff.removed) {
        try { await env.deleteGifBytes(id); } catch (e) { warn(env, `could not delete gif ${id}`, e); }
    }

    return { applied: true, state: merged, diff, incomplete, seen, view };
}

/**
 * The local library as a publish would carry it: syncable sources only, minus
 * ids a previous publish could not read bytes or a key for. Used for the
 * anti-entropy comparison, so a GIF that can never be published does not make
 * the slot look perpetually behind.
 */
export function publishableLibrary(state: GifLibraryState, unpublishable: ReadonlySet<string> = new Set()): GifLibraryState {
    const refused = new Set(state.entries
        .filter(e => !isSyncableGifEntry(e) || unpublishable.has(e.id))
        .map(e => e.id));
    return {
        entries: state.entries.filter(e => !refused.has(e.id)),
        ledger: Object.fromEntries(Object.entries(state.ledger).filter(([id]) => !refused.has(id))),
    };
}

/**
 * The part of a library that sync is about: which ids are live, when each was
 * added, and every ledger timestamp — in canonical form (sorted, and with the
 * `addedAt` fallback made explicit, exactly as a merge would read it).
 * Deliberately NOT label/fileName/mimeType: another platform may carry those
 * differently (mobile has no label column), and a cosmetic difference must not
 * read as "the slot is behind" or two devices would republish at each other.
 */
function libraryShape(s: GifLibraryState): string {
    const c = mergeGifLibraries(emptyLibraryState(), s);
    return JSON.stringify([
        c.entries.map(e => [e.id, e.addedAt]),
        Object.entries(c.ledger).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
    ]);
}

const sameLibrary = (a: GifLibraryState, b: GifLibraryState) => libraryShape(a) === libraryShape(b);

/** Should this device publish its library although nothing changed locally? */
export function gifRepublishReason(
    view: SlotView<GifLibraryState> | null,
    local: GifLibraryState,
    ownDeviceIds: readonly string[] | null,
    myDeviceId: string,
    unpublishable: ReadonlySet<string> = new Set(),
): RepublishReason {
    return republishReason({
        view,
        local: publishableLibrary(local, unpublishable),
        isEmpty: s => s.entries.length === 0 && Object.keys(s.ledger).length === 0,
        merge: mergeGifLibraries,
        same: sameLibrary,
        ownDeviceIds,
        myDeviceId,
    });
}

/**
 * Write the local library to the shared slot, addressed to this user's other
 * devices.
 *
 * Returns false when there is nothing to publish to — a single-device account
 * should not be uploading a blob nobody can read.
 */
export async function publishLibrary(env: GifSyncEnv): Promise<boolean> {
    return (await publishLibraryDetailed(env)).published;
}

export interface PublishResult {
    published: boolean;
    /** The view of the slot after our upload (state = what we published). */
    view: SlotView<GifLibraryState> | null;
    /** Entries left out because their key or bytes could not be read. */
    skipped: string[];
}

export async function publishLibraryDetailed(env: GifSyncEnv, myDeviceId?: string): Promise<PublishResult> {
    const nothing: PublishResult = { published: false, view: null, skipped: [] };

    // Non-claiming check first: prekey_bundle below spends one one-time
    // prekey per device, including this one, and a single-device account
    // would otherwise pay that on every GIF it adds just to learn there is
    // nobody to publish to.
    if (env.listOwnDeviceIds && myDeviceId) {
        const ids = await env.listOwnDeviceIds();
        if (ids && !ids.some(id => id !== myDeviceId)) return nothing;
    }

    // Syncable entries only (isSyncableGifEntry): a refused entry is left
    // out together with its ledger timestamp, so no other device reads its
    // absence as a deletion.
    const state = publishableLibrary(env.loadLocalState());

    const devices = (await env.fetchOwnDevices()).filter(d => d.device_id && d.spk_pub_b64);
    if (devices.length === 0) return nothing;

    const keys: Record<string, string> = {};
    const files: Record<string, string> = {};
    const skipped: string[] = [];

    const refs = new Set<string>();
    for (const entry of state.entries) {
        // KLIPY references travel as metadata: no key, no bytes, nothing read.
        if (isKlipyRefEntry(entry)) { refs.add(entry.id); continue; }
        const keyB64 = env.getGifKeyB64(entry.id);
        if (!keyB64) { warn(env, `no key for gif ${entry.id}; not publishing it`); skipped.push(entry.id); continue; }
        let bytes: Uint8Array | null = null;
        try { bytes = await env.readGifBytes(entry.id); } catch (e) { warn(env, `could not read gif ${entry.id}`, e); }
        if (!bytes || bytes.length === 0) { skipped.push(entry.id); continue; }
        keys[entry.id] = keyB64;
        files[entry.id] = bytesToBase64(bytes);
    }

    // Publish metadata only for GIFs whose bytes actually made it in, so a
    // receiving device never sees an entry it cannot materialise. The ledger
    // goes up whole — tombstones carry no bytes and must not be filtered.
    const publishable = state.entries.filter(e => files[e.id] || refs.has(e.id));

    const contentKeyB64 = await env.generateContentKeyB64();
    const payload = buildSnapshotPayload(publishable, state.ledger, keys, files, env.now());
    const body = await env.encryptWithKey(JSON.stringify(payload), contentKeyB64);
    const keyEnvelope = await env.wrapToDevices(JSON.stringify({ k: contentKeyB64 }), devices);

    await env.uploadSlot(frameSnapshot(
        { v: GIF_SNAPSHOT_VERSION, key_envelope_b64: keyEnvelope },
        body,
    ));

    const meta = await env.getSlotMeta();
    return {
        published: true,
        view: meta ? {
            updatedAt: meta.updated_at,
            recipients: envelopeRecipientIds(keyEnvelope),
            publisher: myDeviceId ?? null,
            state: { entries: publishable, ledger: state.ledger },
        } : null,
        skipped,
    };
}
