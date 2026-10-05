/**
 * What a history payload (device-to-device transfer, backup restore) IS,
 * decided completely before `importLocalHistory` writes a single byte.
 *
 * ## Why this exists (History transfer §1, 2026-09-24 — data loss)
 *
 * `importLocalHistory` used to pick its branch with
 * `isWrapped = !!(vault.history && vault.topics)` and treat anything else as
 * the ancient pre-wrapper bare dump: clear every DM thread, then write the raw
 * JSON into the legacy `cipherline_msgs_<uid>` slot. A mobile vault
 * (`{ v: 5, userId, tables, history, channelHistory, kv }` — no `topics`) took
 * that branch, so a phone → computer transfer wiped the desktop's DM history
 * and imported nothing. That branch also skipped the account binding. It was
 * reachable from HistorySyncBanner (a transfer approved by a phone) and from
 * both restore paths.
 *
 * ## The rule
 *
 * Classify and validate first; refuse with a message a person can act on;
 * never let a refusal leave a partial write behind. So the import either
 * applies a payload it fully understood or changes nothing.
 *
 *  - **desktop** — has `history` and/or `topics` (the wrapper). Every field the
 *    importer reads is type-checked here, and `userId` must be present and match.
 *    `version` may be absent (early wrapped vaults had none) or any positive
 *    integer: the vault contract is additive (see `VAULT_VERSION` in crypto.ts),
 *    so a newer desktop's vault is still read for the fields this build knows.
 *  - **mobile** — `v` is a number and `tables` is an object (cipherline-mobile
 *    `src/features/backups/types.ts`). Refused: this build cannot convert it yet.
 *  - **legacy-bare** — the pre-wrapper dump, `Record<conversationId, Message[]>`,
 *    accepted ONLY when it really looks like one: non-empty, every value an array
 *    of objects, and none of the wrapper/mobile field names present. It predates
 *    accounts, so it is the one shape with no `userId` to bind.
 *  - anything else — refused.
 *
 * Pure: no storage, no I/O.
 */

export type HistoryRefusalReason =
    | 'unreadable'        // not JSON
    | 'unrecognised'      // JSON, but not a shape this build can import
    | 'mobile_format'     // a Cipherline MOBILE vault
    | 'missing_account'   // wrapped vault with no userId
    | 'wrong_account';    // belongs to another account

/** Thrown for every refusal. The `message` is written for the person looking at
 *  the screen; `reason` is for code (HistorySyncBanner picks its copy from it). */
export class HistoryPayloadRefusedError extends Error {
    readonly reason: HistoryRefusalReason;
    constructor(reason: HistoryRefusalReason, message: string) {
        super(message);
        this.name = 'HistoryPayloadRefusedError';
        this.reason = reason;
    }
}

export type ThreadMap = Record<string, unknown[]>;

/** A desktop vault that passed validation. Only the fields the importer reads
 *  are typed; everything is still the parsed object, untouched. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the importer reads ~20 optional fields, each type-checked by OPTIONAL_FIELD_CHECKS above
export type ValidDesktopVault = Record<string, any> & {
    userId: string;
    topics: unknown[];
    history: ThreadMap;
};

export type ClassifiedHistoryPayload =
    | { kind: 'desktop'; vault: ValidDesktopVault }
    | { kind: 'legacy-bare'; text: string };

/** Field names that mark a payload as a wrapper (desktop or mobile) rather than
 *  a bare `Record<conversationId, Message[]>`. A real conversation id is a UUID,
 *  so none of these can collide with one. */
const WRAPPER_KEYS = ['userId', 'version', 'v', 'tables', 'history', 'topics', 'channelHistory', 'kv', 'deviceId'];

const MSG_MOBILE =
    'This history was made by the Cipherline mobile app, and this computer can’t import a phone’s history yet. Nothing on this device was changed.';
const MSG_UNREADABLE =
    'This history file is damaged or isn’t a Cipherline history file. Nothing on this device was changed.';
const MSG_UNRECOGNISED =
    'This isn’t a history format this version of Cipherline can import. Nothing on this device was changed.';
// Kept verbatim from the checks these replace — AuthScreen and the Settings
// restore surface them as-is, and backupBinding.test.ts pins them.
const MSG_MISSING_ACCOUNT = 'This backup is missing account information — refusing to restore.';
const MSG_WRONG_ACCOUNT = 'This backup belongs to a different account — refusing to restore.';

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isThreadMap(v: unknown): v is ThreadMap {
    return isPlainObject(v) && Object.values(v).every(Array.isArray);
}

function isStringMap(v: unknown): boolean {
    return isPlainObject(v) && Object.values(v).every(x => typeof x === 'string');
}

const absent = (v: unknown) => v === undefined || v === null;

/**
 * Every optional field `importLocalHistory` reads, with the container type its
 * writer assumes. A field that is present with the wrong type is a damaged or
 * foreign payload — refusing it here is what keeps the importer from replacing
 * history and THEN tripping over it.
 */
const OPTIONAL_FIELD_CHECKS: Array<[field: string, ok: (v: unknown) => boolean]> = [
    ['channelHistory', isThreadMap],
    ['attachmentBlobs', isStringMap],
    ['gifKeys', isStringMap],
    ['gifFiles', isStringMap],
    ['gifFavorites', Array.isArray],
    ['gifLedger', isPlainObject],
    ['avatarKeys', isPlainObject],
    ['hiddenConversations', Array.isArray],
    ['mutedConversations', Array.isArray],
    ['pinnedMessages', isPlainObject],
    ['localChannelPins', isPlainObject],
    ['kv', isPlainObject],
    ['appPrefs', isPlainObject],
    ['userStatus', v => isPlainObject(v)
        && ['status', 'text', 'emoji'].every(k => absent(v[k]) || typeof v[k] === 'string')],
];

function refuseUnrecognised(): never {
    throw new HistoryPayloadRefusedError('unrecognised', MSG_UNRECOGNISED);
}

/**
 * Parse and classify `text` for an import into `userId`'s account. Throws a
 * {@link HistoryPayloadRefusedError} for anything that must not be applied.
 */
export function classifyHistoryPayload(text: string, userId: string): ClassifiedHistoryPayload {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new HistoryPayloadRefusedError('unreadable', MSG_UNREADABLE);
    }
    if (!isPlainObject(parsed)) refuseUnrecognised();

    // Mobile first: it is refused whoever it belongs to, and "made by the
    // mobile app" is the message that tells the person what to do instead.
    if (typeof parsed.v === 'number' && isPlainObject(parsed.tables)) {
        throw new HistoryPayloadRefusedError('mobile_format', MSG_MOBILE);
    }

    // Account binding applies to every shape that carries an id. Checked before
    // the structural validation so a foreign vault is named as foreign.
    if ('userId' in parsed) {
        if (typeof parsed.userId !== 'string' || parsed.userId === '') {
            throw new HistoryPayloadRefusedError('missing_account', MSG_MISSING_ACCOUNT);
        }
        if (parsed.userId !== userId) {
            throw new HistoryPayloadRefusedError('wrong_account', MSG_WRONG_ACCOUNT);
        }
    }

    const isWrapper = 'history' in parsed || 'topics' in parsed;
    if (isWrapper) {
        // A wrapped vault has always carried its userId alongside history and
        // topics (exportLocalHistory writes all three in the same object); one
        // without it is hand-crafted, corrupted, or tampered — fail closed.
        if (!('userId' in parsed)) {
            throw new HistoryPayloadRefusedError('missing_account', MSG_MISSING_ACCOUNT);
        }
        if (!Array.isArray(parsed.topics) || !isThreadMap(parsed.history)) refuseUnrecognised();
        if (!absent(parsed.version)
            && !(typeof parsed.version === 'number' && Number.isInteger(parsed.version) && parsed.version > 0)) {
            refuseUnrecognised();
        }
        for (const [field, ok] of OPTIONAL_FIELD_CHECKS) {
            if (!absent(parsed[field]) && !ok(parsed[field])) refuseUnrecognised();
        }
        return { kind: 'desktop', vault: parsed as ValidDesktopVault };
    }

    // Legacy pre-wrapper bare dump — only when it unmistakably is one.
    const entries = Object.entries(parsed);
    const looksBare = entries.length > 0
        && !WRAPPER_KEYS.some(k => k in parsed)
        && entries.every(([, msgs]) => Array.isArray(msgs) && msgs.every(isPlainObject));
    if (looksBare) return { kind: 'legacy-bare', text };

    refuseUnrecognised();
}
