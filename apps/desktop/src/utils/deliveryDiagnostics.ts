/**
 * A bounded, in-memory record of message/channel-key delivery failures.
 *
 * Every failure path in the E2EE pipeline used to end in a bare
 * `console.error`/`console.warn` — invisible unless DevTools happened to be
 * open at the exact moment, and gone the instant the console scrolled. That
 * silence is why one-way DM delivery and "Waiting for channel keys…" went
 * undiagnosed for months: nothing anywhere accumulated evidence.
 *
 * This is deliberately NOT persisted (no secureLocalStore write) — it's a
 * debugging aid for the current session, not an audit log, and it never
 * touches plaintext content, only envelope/channel identifiers and error
 * codes. Surfaced in Settings → Advanced → "Delivery diagnostics".
 */

export type DiagnosticKind = 'message_decrypt' | 'message_process' | 'message_persist' | 'message_encrypt' | 'message_ack' | 'channel_key_decrypt' | 'channel_key_distribute';

export interface DiagnosticEntry {
    /** Wall-clock ms — informational only; never persisted across restarts. */
    ts: number;
    kind: DiagnosticKind;
    /** The `[E2EE:CODE]` prefix if present, else 'UNKNOWN'. */
    code: string;
    /** Free-form context: envelope_id, conversation_id, channel_id, epoch, device_id — never plaintext. */
    ctx: Record<string, string | number | undefined>;
    /** The raw error message, for the copy-to-clipboard report. */
    message: string;
}

const MAX_ENTRIES = 200;
const entries: DiagnosticEntry[] = [];

/** Extract the `[E2EE:CODE]` prefix from an error message, if present. */
export function extractE2eeCode(message: string): string {
    const m = /\[E2EE:([A-Z_]+)\]/.exec(message);
    return m ? m[1] : 'UNKNOWN';
}

export function record(kind: DiagnosticKind, error: unknown, ctx: DiagnosticEntry['ctx'] = {}): DiagnosticEntry {
    const message = error instanceof Error ? error.message : String(error);
    const entry: DiagnosticEntry = { ts: Date.now(), kind, code: extractE2eeCode(message), ctx, message };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
    return entry;
}

/** Most-recent-first snapshot for rendering. */
export function snapshot(): DiagnosticEntry[] {
    return [...entries].reverse();
}

/** Count of entries per `[kind, code]` pair, for a quick "what's actually failing" summary. */
export function counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of entries) {
        const key = `${e.kind}:${e.code}`;
        out[key] = (out[key] ?? 0) + 1;
    }
    return out;
}

export function clear(): void {
    entries.length = 0;
}

/** Plain-text report for the Settings → Advanced copy-to-clipboard button. */
export function formatReport(): string {
    if (entries.length === 0) return 'No delivery failures recorded this session.';
    const lines = snapshot().map(e => {
        const ctxStr = Object.entries(e.ctx)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        return `${new Date(e.ts).toISOString()} [${e.kind}] ${e.code} ${ctxStr} — ${e.message}`;
    });
    const summary = Object.entries(counts())
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `  ${k}: ${n}`)
        .join('\n');
    return `Delivery diagnostics — ${entries.length} entries this session\n\nBy type:\n${summary}\n\nDetail (newest first):\n${lines.join('\n')}`;
}
