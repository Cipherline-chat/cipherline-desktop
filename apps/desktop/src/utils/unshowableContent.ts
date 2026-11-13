/**
 * What happens to decrypted content that cannot be shown.
 *
 * ## Why (2026-10-26, owner: "a lot of these 'A message couldn't be shown'")
 *
 * 1.0.23 added the content boundary (utils/contentValidation.ts): decrypted
 * content that fails its variant's schema is stored as a "couldn't be shown"
 * placeholder ROW. That is right for a message the user was meant to see — a
 * message did arrive and the user should know. It is wrong for a CONTROL
 * message: an edit, delete, reaction, pin, profile_update, a call-key share or
 * request. Those never had a row of their own; when one is unusable the only
 * honest outcome is that its side effect does not happen. Turning it into a
 * visible row tells the user a message is missing when none is.
 *
 * So every receive path (DM pull, live channel message, channel history) asks
 * {@link unshowableDisposition} before it stores a stand-in:
 *   - 'drop'        → a control message: nothing is stored (the DM envelope is
 *                     ACKed with nothing to keep), a local diagnostics entry and
 *                     a beta count are recorded;
 *   - 'placeholder' → anything else, including a type this build does not know
 *                     (it may be a real message from a newer client).
 *
 * Every occurrence is counted either way ({@link recordUnshowable}): reason +
 * content type name only, never content, ids or who sent it.
 */
import { record as recordDelivery } from './deliveryDiagnostics';
import { CONTROL_TYPES } from './retentionSweeper';

export type UnshowableScope = 'dm' | 'channel' | 'channel_history';
export type UnshowableOutcome = 'dropped' | 'placeholder';

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** Same rule as dmInbound.isCallKeyControl (kept local: dmInbound imports the
 *  message store). A call key handed to a joiner, minted by a lone joiner or
 *  rotated mid-call — never the call's start, which is the one call bar. */
function isCallKeyControlContent(c: Record<string, unknown>): boolean {
    if (c.type !== 'call_key' || typeof c.key_id !== 'string') return false;
    return c.key_id === 'share' || c.key_id === 'mint' || c.key_id.startsWith('rotate-');
}

/**
 * True for content that is never a chat row of its own: it acts on another row
 * (edit / delete / reaction), on a pin ledger or profile, carries key material,
 * or asks for it. The list is retention's CONTROL_TYPES — the one definition of
 * "not a row" — plus mid-call `call_key`s.
 */
export function isControlContent(content: unknown): boolean {
    if (!isRecord(content) || typeof content.type !== 'string') return false;
    return CONTROL_TYPES.has(content.type) || isCallKeyControlContent(content);
}

/** What to do with content that decrypted but cannot be shown or applied. */
export function unshowableDisposition(content: unknown): 'drop' | 'placeholder' {
    return isControlContent(content) ? 'drop' : 'placeholder';
}

/**
 * The content's type, as a diagnostics-safe enum: the type name when it is
 * shaped like one (`snake_case`, ≤ 32), 'none' when there is no type and
 * 'invalid' otherwise. The type is sender-chosen, so nothing else of it is kept.
 */
export function contentTypeName(content: unknown): string {
    if (!isRecord(content) || content.type === undefined || content.type === null) return 'none';
    return typeof content.type === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(content.type) ? content.type : 'invalid';
}

/**
 * A compact, content-free code for a `contentProblem` answer: which field it
 * is about ("edit.target_id", "content.type"), or 'unknown_type' for a variant
 * this build does not accept. Never the sentence itself.
 */
export function problemCode(problem: string | null | undefined): string | undefined {
    if (!problem) return undefined;
    if (/ is not accepted$/.test(problem)) return 'unknown_type';
    const field = problem.split(' ')[0];
    return /^[a-z_][a-z0-9_.]{0,47}$/.test(field) ? field : 'other';
}

/** Messages already counted this session (see `messageId` below). In memory only. */
const recorded = new Set<string>();
const RECORDED_MAX = 5_000;
export function _resetUnshowableForTests(): void { recorded.clear(); }

/** ctx keys the beta bridge reads back (betaDiagnostics/bridges.ts). */
export const UNSHOWABLE_CTX = {
    reason: 'unshowable_reason',
    type: 'content_type',
    scope: 'scope',
    outcome: 'outcome',
    field: 'problem_field',
} as const;

/**
 * Record one unshowable message: a local Delivery-diagnostics entry and, via
 * the delivery tap, one beta `msg_fetch_gap` count with stage 'unshowable'.
 * `ids` (envelope / conversation / channel ids) stay in the LOCAL entry only;
 * the beta bridge forwards just the enum fields.
 */
export function recordUnshowable(args: {
    scope: UnshowableScope;
    /** 'malformed' | 'unprocessable' | 'unverified_own_device' | … */
    reason: string;
    content: unknown;
    outcome: UnshowableOutcome;
    problem?: string | null;
    ids?: Record<string, string | undefined>;
    /** The message's own id: channel history re-decrypts the same rows on
     *  every open, and one bad message must count once per session. */
    messageId?: string;
}): void {
    if (args.messageId) {
        const key = `${args.scope}:${args.messageId}`;
        if (recorded.has(key)) return;
        if (recorded.size >= RECORDED_MAX) recorded.clear();
        recorded.add(key);
    }
    const type = contentTypeName(args.content);
    const field = problemCode(args.problem);
    recordDelivery('message_process', new Error(`[E2EE:UNSHOWABLE] ${args.reason} ${type} ${args.outcome}${field ? ` (${field})` : ''}`), {
        ...(args.ids ?? {}),
        [UNSHOWABLE_CTX.reason]: args.reason,
        [UNSHOWABLE_CTX.type]: type,
        [UNSHOWABLE_CTX.scope]: args.scope,
        [UNSHOWABLE_CTX.outcome]: args.outcome,
        ...(field ? { [UNSHOWABLE_CTX.field]: field } : {}),
    });
}
