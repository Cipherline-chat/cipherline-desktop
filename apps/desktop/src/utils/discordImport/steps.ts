/**
 * Step logic of the "Import from Discord" wizard, kept pure so the rules
 * (what unlocks what) are tested without rendering. UX only: the server
 * enforces everything that matters.
 */
export type WizardStep = 'token' | 'guild' | 'preview' | 'consent' | 'run' | 'done' | 'keep';

/**
 * The steps the user walks through before the run; shown as "Step N of 4".
 * The token comes FIRST (owner, 2026-11-22): the invite link is built from it,
 * so there is nothing to type before it. 'guild' is "add the bot + pick it".
 */
export const SETUP_STEPS: readonly WizardStep[] = ['token', 'guild', 'preview', 'consent'];

// ── Server list polling ──────────────────────────────────────────────────

/** While the "add the bot" step is open the list refreshes itself: gently, and never on a dead token. */
export const GUILD_POLL = { okMs: 5_000, retryMs: 15_000, hiddenMs: 15_000, maxMs: 10 * 60_000 } as const;

/** Error codes that mean "Discord or the network is having a moment": keep trying, slower. */
const TRANSIENT = new Set(['network', 'timeout', 'discord_down', 'rate_limited', 'aborted', 'invalid_response', 'unknown']);

export type GuildListOutcome = { ok: true } | { ok: false; code: string; retryAfterMs?: number };

/**
 * When to ask Discord again after a list attempt, or null to stop polling
 * (the manual Refresh still works). Never re-polls a rejected token: Discord
 * counts invalid requests and bans IPs that keep sending them.
 */
export function nextGuildPoll(r: GuildListOutcome, elapsedMs: number, hidden = false): number | null {
    if (elapsedMs >= GUILD_POLL.maxMs) return null;
    if (r.ok) return hidden ? GUILD_POLL.hiddenMs : GUILD_POLL.okMs;
    if (!TRANSIENT.has(r.code)) return null;
    if (r.code === 'rate_limited') return Math.max(GUILD_POLL.retryMs, r.retryAfterMs ?? 0);
    return GUILD_POLL.retryMs;
}

/** Which empty / error state the server list shows. */
export type GuildListView =
    | { kind: 'loading' }
    | { kind: 'list' }
    /** Discord answered: the token's bot is in no server. */
    | { kind: 'no-servers' }
    /** We could not get an answer (network, timeout, Discord down, rate limit). */
    | { kind: 'unreachable'; message: string }
    /** Discord answered with a hard no (token reset, not a bot any more...). */
    | { kind: 'token-problem'; message: string };

export function guildListView(guilds: readonly unknown[] | null, err: { code: string; message: string } | null): GuildListView {
    if (guilds && guilds.length > 0) return { kind: 'list' }; // a transient error never hides a list we already have
    if (err) {
        return TRANSIENT.has(err.code)
            ? { kind: 'unreachable', message: err.message }
            : { kind: 'token-problem', message: err.message };
    }
    if (guilds === null) return { kind: 'loading' };
    return { kind: 'no-servers' };
}

export interface WizardFacts {
    tokenValid: boolean;
    guildId: string | null;
    previewReady: boolean;
    serverName: string;
    consent: boolean;
    busy: boolean;
    /** Messages are being brought over too: the two extra consents below are required (plan A5 item 8). */
    withHistory?: boolean;
    historyConsent?: { members: boolean; content: boolean };
    /** At least one channel picked for messages (when withHistory). */
    historyChannels?: number;
}

export const CONSENT_TEXT =
    'I administer this Discord server and have the right to copy its settings to Cipherline.';

/** The two extra consents when messages come over too (plan A5 item 8 b and c). */
export const HISTORY_CONSENT_MEMBERS =
    'I have told the members, or will, that their recent messages are being copied, and I will honour requests to remove them.';
export const HISTORY_CONSENT_CONTENT =
    'The messages follow Cipherline’s rules, I have the right to re-post them, and I will not change them.';

/** A ready-made note the admin can post to their members (plan A4 / D8). */
export const ANNOUNCEMENT_TEXT =
    'Heads up: we are moving this server to Cipherline, an end-to-end encrypted chat app. ' +
    'Our recent messages (about the last 30 days) and pinned messages will be copied over with your name and avatar. ' +
    'If you would rather your messages were not copied, tell a moderator within 7 days and they will be left out or removed.';

export function setupIndex(step: WizardStep): number | null {
    const i = SETUP_STEPS.indexOf(step);
    return i < 0 ? null : i;
}

/** May the user press Continue on `step`? */
export function canContinue(step: WizardStep, f: WizardFacts): boolean {
    if (f.busy) return false;
    switch (step) {
        case 'token': return f.tokenValid;
        case 'guild': return f.guildId !== null;
        case 'preview': return f.previewReady && f.serverName.trim().length >= 2;
        // Consent is the only gate that cannot be skipped: no run without it.
        // Copying messages needs all three boxes, and at least one channel.
        case 'consent': return f.consent && f.previewReady && f.guildId !== null && f.serverName.trim().length >= 2
            && (!f.withHistory || (!!f.historyConsent?.members && !!f.historyConsent?.content && (f.historyChannels ?? 0) > 0));
        default: return false;
    }
}

export function nextStep(step: WizardStep): WizardStep {
    const i = SETUP_STEPS.indexOf(step);
    if (i < 0) return step;
    return i === SETUP_STEPS.length - 1 ? 'run' : SETUP_STEPS[i + 1];
}

export function prevStep(step: WizardStep): WizardStep | null {
    const i = SETUP_STEPS.indexOf(step);
    return i <= 0 ? null : SETUP_STEPS[i - 1];
}

/** What a user-facing failure from the Cipherline API says. */
export function guildImportErrorMessage(err: unknown): string {
    const e = err as { response?: { status?: number; data?: { code?: string; message?: unknown } } } | null;
    const status = e?.response?.status;
    const code = e?.response?.data?.code;
    if (code === 'GUILD_SNAPSHOT_INVALID') return 'The Discord server data could not be read. Go back and pick the server again.';
    if (status === 429) return 'Too many tries. Wait a minute, then try again.';
    if (status === 413) return 'That Discord server is too large to import in one go.';
    if (status === 400) {
        const m = e?.response?.data?.message;
        const text = Array.isArray(m) ? m.join(' ') : typeof m === 'string' ? m : '';
        return text || 'Something about that request wasn’t valid.';
    }
    if (!e?.response) return 'Couldn’t reach Cipherline. Check your connection and try again.';
    return 'Something went wrong. Try again.';
}
