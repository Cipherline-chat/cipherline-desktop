/**
 * Call names — the per-Calls-channel policy for what each call under it is
 * called, and whether that name ever changes on its own.
 *
 * ONE implementation, used by both sides:
 *   • the API computes a new call's stored name from it (spawn and
 *     move-into-a-new-call) and refuses manual renames it forbids;
 *   • the desktop renders the live title from it (the "follow the game"
 *     part is a client-side DISPLAY rule over presence data the viewer
 *     already holds — the stored name never changes when a game starts) and
 *     uses the same validator for the settings form.
 *
 * Stored as `channels.call_naming` (JSONB, NULL = every default). Defaults
 * reproduce the behaviour that existed before this setting did, exactly:
 * "<host>'s Call", the game takes over the title while at least half the
 * call plays it, the person who started a call may rename it.
 *
 * No `{game}` token on purpose: the base name is STORED and shown to everyone
 * who can see the channel, so baking a game into it would publish one
 * member's activity to people who may not otherwise see it (someone appearing
 * offline, a non-friend). The game half lives in `callDisplayName`, computed
 * by each viewer from what that viewer is already allowed to know.
 */

export type CallNameStyle = 'host' | 'numbered' | 'fixed' | 'template';
export type CallGameMode = 'replace' | 'off';

export interface CallNamingSettings {
    /** How a new call's name is chosen when it starts. */
    style: CallNameStyle;
    /** `fixed` only: the name every call gets. null = the channel's own name. */
    fixed_name: string | null;
    /** `template` only (kept while another style is picked, so switching back
     *  does not lose it). Placeholders: {host} {channel} {n}. */
    template: string | null;
    /** While at least half the call is playing one game: show the game
     *  instead of the name (`replace`) or never (`off`). The UI is a single
     *  on/off toggle; there is no "next to the name" mode. */
    game: CallGameMode;
    /** The person who started a call may rename it. Off = only members with
     *  Manage Channels here. */
    starter_can_rename: boolean;
    /** "Never change call names": a call keeps the name it started with —
     *  no game titles, no manual renames by anyone (Manage Channels holders
     *  turn this off first). */
    locked: boolean;
}

export const CALL_NAME_STYLES: readonly CallNameStyle[] = ['host', 'numbered', 'fixed', 'template'];
export const CALL_GAME_MODES: readonly CallGameMode[] = ['replace', 'off'];

export const DEFAULT_CALL_NAMING: Readonly<CallNamingSettings> = Object.freeze({
    style: 'host',
    fixed_name: null,
    template: null,
    game: 'replace',
    starter_can_rename: true,
    locked: false,
});

/** Same ceiling as a manual rename (RenameHuddleCallDto / renameCall). */
export const CALL_NAME_MAX_LENGTH = 60;
export const CALL_NAME_TOKENS = ['host', 'channel', 'n'] as const;
export type CallNameToken = typeof CALL_NAME_TOKENS[number];

/** Literal characters allowed in a fixed name or a template — the same set
 *  a manual rename and a channel name accept (letters, digits, space,
 *  apostrophe, hyphen, underscore, period). Rules out control characters,
 *  bidi overrides, zero-width tricks and look-alike scripts by construction. */
const PLAIN_CHARS = /^[a-zA-Z0-9 '\-_.]*$/;

/** Error codes the API returns for refused renames. Clients treat both as a
 *  quiet no-op (the UI already hides the action), never an error toast. */
export const CALL_NAMES_LOCKED = 'CALL_NAMES_LOCKED';
export const CALL_RENAME_MANAGERS_ONLY = 'CALL_RENAME_MANAGERS_ONLY';
/** Returned by a settings write when the database column is missing
 *  (API rolled before the migration). */
export const CALL_NAMING_UNAVAILABLE = 'CALL_NAMING_UNAVAILABLE';

const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CALL_NAMING));

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

// ── Validation (strict — settings writes) ──────────────────────────────────

/** Validate a fixed name. Returns an error message, or null when valid. */
export function fixedNameError(name: string): string | null {
    const t = name.trim();
    if (t.length < 1) return 'Enter a name, or leave it empty to use the channel name';
    if (t.length > CALL_NAME_MAX_LENGTH) return `Keep it to ${CALL_NAME_MAX_LENGTH} characters`;
    if (!PLAIN_CHARS.test(t)) return "Use letters, numbers, spaces and ' - _ . only";
    return null;
}

/** Validate a template. Returns an error message, or null when valid. */
export function templateError(template: string): string | null {
    const t = template.trim();
    if (t.length < 1) return 'Enter a template';
    if (t.length > CALL_NAME_MAX_LENGTH) return `Keep it to ${CALL_NAME_MAX_LENGTH} characters`;
    let literal = '';
    const re = /\{([^{}]*)\}/g;
    let last = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
        literal += t.slice(last, m.index);
        last = m.index + m[0].length;
        if (!(CALL_NAME_TOKENS as readonly string[]).includes(m[1])) {
            return `Unknown placeholder {${m[1]}} — use {host}, {channel} or {n}`;
        }
    }
    literal += t.slice(last);
    if (literal.includes('{') || literal.includes('}')) return 'Every { needs a matching } around {host}, {channel} or {n}';
    if (!PLAIN_CHARS.test(literal)) return "Use letters, numbers, spaces and ' - _ . only (plus placeholders)";
    return null;
}

export type CallNamingValidation =
    | { ok: true; value: CallNamingSettings }
    | { ok: false; error: string };

/**
 * Strict validation of a settings write. Omitted keys take their DEFAULT
 * (the body is the whole setting, not a patch); unknown keys, wrong types,
 * bad names and unknown placeholders are rejected rather than coerced.
 * Names are trimmed.
 */
export function validateCallNaming(raw: unknown): CallNamingValidation {
    if (!isPlainObject(raw)) return { ok: false, error: 'call_naming must be an object' };
    for (const k of Object.keys(raw)) {
        if (!KNOWN_KEYS.has(k)) return { ok: false, error: `call_naming.${k} is not a known setting` };
    }
    const out: CallNamingSettings = { ...DEFAULT_CALL_NAMING };

    if (raw.style !== undefined) {
        if (!(CALL_NAME_STYLES as readonly unknown[]).includes(raw.style)) return { ok: false, error: 'call_naming.style is not valid' };
        out.style = raw.style as CallNameStyle;
    }
    if (raw.game !== undefined) {
        if (!(CALL_GAME_MODES as readonly unknown[]).includes(raw.game)) return { ok: false, error: 'call_naming.game is not valid' };
        out.game = raw.game as CallGameMode;
    }
    for (const k of ['starter_can_rename', 'locked'] as const) {
        if (raw[k] !== undefined) {
            if (typeof raw[k] !== 'boolean') return { ok: false, error: `call_naming.${k} must be true or false` };
            out[k] = raw[k] as boolean;
        }
    }
    if (raw.fixed_name !== undefined && raw.fixed_name !== null) {
        if (typeof raw.fixed_name !== 'string') return { ok: false, error: 'call_naming.fixed_name must be text' };
        const err = fixedNameError(raw.fixed_name);
        if (err) return { ok: false, error: `Fixed name: ${err}` };
        out.fixed_name = raw.fixed_name.trim();
    }
    if (raw.template !== undefined && raw.template !== null) {
        if (typeof raw.template !== 'string') return { ok: false, error: 'call_naming.template must be text' };
        const err = templateError(raw.template);
        if (err) return { ok: false, error: `Template: ${err}` };
        out.template = raw.template.trim();
    }
    if (out.style === 'template' && out.template === null) {
        return { ok: false, error: 'Template: Enter a template' };
    }
    return { ok: true, value: out };
}

// ── Normalisation (lenient — reading what is stored / received) ────────────

/**
 * Read a stored or received value. Never throws: NULL, garbage or a field
 * that no longer validates falls back to that field's default, so a bad row
 * can never take a Calls channel down. (`template` style with an unusable
 * template falls back to the default style rather than an empty name.)
 */
export function normalizeCallNaming(raw: unknown): CallNamingSettings {
    if (!isPlainObject(raw)) return { ...DEFAULT_CALL_NAMING };
    const out: CallNamingSettings = { ...DEFAULT_CALL_NAMING };
    if ((CALL_NAME_STYLES as readonly unknown[]).includes(raw.style)) out.style = raw.style as CallNameStyle;
    if ((CALL_GAME_MODES as readonly unknown[]).includes(raw.game)) out.game = raw.game as CallGameMode;
    if (typeof raw.starter_can_rename === 'boolean') out.starter_can_rename = raw.starter_can_rename;
    if (typeof raw.locked === 'boolean') out.locked = raw.locked;
    if (typeof raw.fixed_name === 'string' && fixedNameError(raw.fixed_name) === null) out.fixed_name = raw.fixed_name.trim();
    if (typeof raw.template === 'string' && templateError(raw.template) === null) out.template = raw.template.trim();
    if (out.style === 'template' && out.template === null) out.style = DEFAULT_CALL_NAMING.style;
    return out;
}

export function isDefaultCallNaming(s: CallNamingSettings): boolean {
    return s.style === DEFAULT_CALL_NAMING.style
        && s.game === DEFAULT_CALL_NAMING.game
        && s.starter_can_rename === DEFAULT_CALL_NAMING.starter_can_rename
        && s.locked === DEFAULT_CALL_NAMING.locked
        && s.fixed_name === DEFAULT_CALL_NAMING.fixed_name
        && s.template === DEFAULT_CALL_NAMING.template;
}

// ── Base name (what a new call is stored as) ───────────────────────────────

export interface CallNameContext {
    /** The starter's name as this server knows them (nickname → username). */
    host: string;
    /** The Calls channel's own name. */
    channel: string;
    /** Names of the calls already live under this channel — {n} picks the
     *  lowest number not already in use. */
    takenNames?: readonly string[];
}

/** Remove control / format characters (incl. bidi overrides and zero-width
 *  joiners) and collapse whitespace. Applied to substituted values: a
 *  nickname is not held to the plain-text set a template is. */
function clean(s: string): string {
    return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
}

function clip(s: string): string {
    const cps = Array.from(s);
    return cps.length <= CALL_NAME_MAX_LENGTH ? s : cps.slice(0, CALL_NAME_MAX_LENGTH).join('').trimEnd();
}

function fillTemplate(template: string, ctx: CallNameContext, n: number): string {
    return clip(clean(template.replace(/\{(host|channel|n)\}/g, (_m, tok: CallNameToken) =>
        tok === 'host' ? clean(ctx.host) : tok === 'channel' ? clean(ctx.channel) : String(n))));
}

/**
 * The name a new call starts with. `host` style is today's exact string
 * ("<host>'s Call", unmodified) so the default changes nothing.
 */
export function renderBaseCallName(s: CallNamingSettings, ctx: CallNameContext): string {
    const legacy = `${ctx.host}'s Call`;
    let template: string;
    switch (s.style) {
        case 'host': return legacy;
        case 'fixed': return clip(clean(s.fixed_name ?? ctx.channel)) || legacy;
        case 'numbered': template = '{channel} {n}'; break;
        case 'template': template = s.template ?? '{host}\'s Call'; break;
        default: return legacy;
    }
    const taken = new Set((ctx.takenNames ?? []).map(n => n.toLowerCase()));
    const usesN = template.includes('{n}');
    const limit = taken.size + 1;
    let name = fillTemplate(template, ctx, 1);
    if (usesN) {
        for (let n = 1; n <= limit; n++) {
            name = fillTemplate(template, ctx, n);
            if (!taken.has(name.toLowerCase())) break;
        }
    }
    return name || legacy;
}

// ── Live title (what viewers see while the call runs) ──────────────────────

/**
 * The game "the call is playing", by the rule the desktop has always used:
 * the most-played game among the participants, if at least half of them are
 * playing it (ties: the first counted). `participantGames` has one entry
 * per participant (null = not playing / unknown to this viewer).
 */
export function pickCallGame(participantGames: ReadonlyArray<string | null | undefined>): string | null {
    if (participantGames.length === 0) return null;
    const counts = new Map<string, number>();
    for (const g of participantGames) if (g) counts.set(g, (counts.get(g) ?? 0) + 1);
    let top: string | null = null;
    let topCount = 0;
    for (const [g, c] of counts) if (c > topCount) { top = g; topCount = c; }
    if (!top) return null;
    return topCount / participantGames.length >= 0.5 ? top : null;
}

/** The title to show for a live call. */
export function callDisplayName(
    storedName: string,
    participantGames: ReadonlyArray<string | null | undefined>,
    s: CallNamingSettings,
): string {
    if (s.locked || s.game === 'off') return storedName;
    const game = pickCallGame(participantGames);
    if (!game) return storedName;
    return game;
}

// ── Manual rename policy ───────────────────────────────────────────────────

export type CallRenameDecision =
    | { ok: true }
    | { ok: false; code: typeof CALL_NAMES_LOCKED | typeof CALL_RENAME_MANAGERS_ONLY };

/**
 * Who may rename a live call. Before this setting: the starter, or anyone
 * with Manage Channels in the channel — which is still the default.
 * (Callers check VIEW_CHANNEL first; a non-starter without Manage Channels
 * is refused by the permission check itself, as before.)
 */
export function decideCallRename(
    s: CallNamingSettings,
    who: { isStarter: boolean; canManageChannels: boolean },
): CallRenameDecision {
    if (s.locked) return { ok: false, code: CALL_NAMES_LOCKED };
    if (who.canManageChannels) return { ok: true };
    if (who.isStarter && s.starter_can_rename) return { ok: true };
    return { ok: false, code: CALL_RENAME_MANAGERS_ONLY };
}
