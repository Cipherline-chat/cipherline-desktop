/**
 * Private notes on people ("met at the LAN party"). Only YOU ever see them.
 *
 * Storage: encrypted on this device (secureLocalStore, per account), in the
 * encrypted backup, and synced between YOUR OWN devices as a whole-snapshot
 * `profile_notes` own-device slot (services/profileNotesSync.ts). The server
 * only ever holds that opaque, client-encrypted blob; a note is never sent to
 * it in plaintext, and nothing about notes is in any profile response.
 *
 * Merge: per-person last-writer-wins by timestamp, with tombstones so a delete
 * survives a sync. `mergeNotes` is commutative, associative and idempotent
 * (ties break on the text itself, never on arrival order), so any two devices
 * converge no matter how snapshots interleave.
 */
import { isSafeSyncId } from './ownSlotSync';
import secureLocalStore from './secureLocalStore';

export const NOTE_MAX = 256;
const MAX_ENTRIES = 5000;

/** `text: null` is a tombstone (the note was deleted at `at`). */
export interface NoteRec { text: string | null; at: number }
export type NotesState = Record<string, NoteRec>;

/** Classified in services/backupRegistry.ts (included: a restore keeps your notes). */
export const notesKey = (userId: string) => `cipherline_profile_notes_${userId}`;
/** What this DEVICE last knew about the slot. Device-specific: never restored. */
export const notesViewKey = (userId: string) => `cipherline_profile_notes_sync_view_${userId}`;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Trim and validate one note's text; null = cannot be saved. Newlines are kept. */
export function cleanNoteText(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const t = raw.replace(/\r\n/g, '\n').trim();
    if (t.length > NOTE_MAX || CONTROL.test(t)) return null;
    return t;
}

/** Coerce a decoded value (local storage or another device) into a well-formed state. */
export function sanitizeNotes(raw: unknown): NotesState {
    const out: NotesState = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
        if (n >= MAX_ENTRIES) break;
        if (!isSafeSyncId(id) || !v || typeof v !== 'object') continue;
        const rec = v as { text?: unknown; at?: unknown };
        if (typeof rec.at !== 'number' || !Number.isFinite(rec.at) || rec.at < 0) continue;
        if (rec.text === null) { out[id] = { text: null, at: rec.at }; n++; continue; }
        const text = cleanNoteText(rec.text);
        if (text === null || text === '') continue; // an empty/oversized live note is not a record
        out[id] = { text, at: rec.at };
        n++;
    }
    return out;
}

/** The winning record: later `at`; on a tie a live note beats a tombstone, then the larger text. */
function winner(a: NoteRec, b: NoteRec): NoteRec {
    if (a.at !== b.at) return a.at > b.at ? a : b;
    if ((a.text === null) !== (b.text === null)) return a.text === null ? b : a;
    if (a.text === null || b.text === null) return a;
    return a.text >= b.text ? a : b;
}

export function mergeNotes(a: NotesState, b: NotesState): NotesState {
    const out: NotesState = { ...a };
    for (const [id, rec] of Object.entries(b)) out[id] = id in out ? winner(out[id], rec) : rec;
    return out;
}

export function sameNotes(a: NotesState, b: NotesState): boolean {
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    return ka.every((id) => b[id] && b[id].at === a[id].at && b[id].text === a[id].text);
}

/** No live note and no tombstone: nothing worth publishing. */
export const isEmptyNotes = (s: NotesState): boolean => Object.keys(s).length === 0;

/** The note to show for `userId`, or '' (no note / deleted). */
export const noteOf = (s: NotesState, userId: string): string => s[userId]?.text ?? '';

/**
 * Set (or, with an empty `text`, delete) a note. The new stamp is strictly
 * after any existing record for this person, so a local edit always beats what
 * this device already holds even if its clock is behind. Returns the same
 * object when nothing changed. `null` text = invalid (nothing is changed).
 */
export function withNote(s: NotesState, userId: string, text: string, now: number): NotesState | null {
    if (!isSafeSyncId(userId)) return null;
    const clean = cleanNoteText(text);
    if (clean === null) return null;
    const prev = s[userId];
    if ((prev?.text ?? '') === clean) return s;
    if (clean === '' && !prev) return s;
    const at = Math.max(now, (prev?.at ?? 0) + 1);
    return { ...s, [userId]: { text: clean === '' ? null : clean, at } };
}

// ── store: one per signed-in account, bound by ProfileNotesHost ─────────────

let boundUser: string | null = null;
let state: NotesState = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let onLocalChange: (() => void) | null = null;

function persist(): void {
    if (!boundUser) return;
    try { secureLocalStore.setItem(notesKey(boundUser), JSON.stringify(state)); } catch { /* non-fatal: the next edit retries */ }
}

/** Load `userId`'s notes (call after `secureLocalStore.whenAccountReady()`); null unbinds. */
export function bindNotes(userId: string | null, onChange?: () => void): void {
    boundUser = userId;
    onLocalChange = onChange ?? null;
    state = {};
    if (userId) {
        try { state = sanitizeNotes(JSON.parse(secureLocalStore.getItem(notesKey(userId)) ?? 'null')); } catch { state = {}; }
    }
    emit();
}

export const getNotes = (): NotesState => state;
export const subscribeNotes = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Save a note locally and ask the host to sync. Returns false when `text` is invalid. */
export function setNote(userId: string, text: string, now = Date.now()): boolean {
    if (!boundUser) return false;
    const next = withNote(state, userId, text, now);
    if (next === null) return false;
    if (next !== state) { state = next; persist(); emit(); onLocalChange?.(); }
    return true;
}

/** Adopt a remote snapshot (merge + persist). Returns true if local changed. */
export function mergeRemoteNotes(remote: NotesState): boolean {
    if (!boundUser) return false;
    const merged = mergeNotes(state, sanitizeNotes(remote));
    if (sameNotes(merged, state)) return false;
    state = merged;
    persist();
    emit();
    return true;
}
