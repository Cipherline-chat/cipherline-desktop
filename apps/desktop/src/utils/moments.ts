/**
 * moments — the full-screen easter eggs ("moments"), DOM-free.
 *
 * A moment is a short (≤ 9 s, paced to be read) piece of full-screen theatre that a trigger
 * somewhere in the app asks for with `requestMoment(id)`. ONE host
 * (components/moments/MomentHost.tsx, mounted once at the app root) decides
 * whether it may play now, claims it in the seen-ledger and renders it.
 * Everything the host DECIDES lives here, where vitest (environment: node)
 * can test it without a DOM.
 *
 * Owner decision 2026-10-20: easter eggs are part of the app, not a feature
 * behind a toggle — there is no switch for moments to read. They share only
 * the seen-ledger (cipherline_egg_seen — device-local, excluded from backups),
 * under ids prefixed `moment:` so they never collide with an egg's rate-limit
 * entry. (For the Egg hunter badge, MomentHost records the BARE id — every
 * MOMENTS key is also in eggProgress.ts's EGG_IDS.)
 *
 * Privacy (doctrine rule 8): triggers are UI actions, local counts and the
 * clock. Nothing here, in the host, or in any view reads message content or
 * draft text, and nothing is sent anywhere.
 */
import {
    EGG_LEDGER_KEY, parseLedger, eggDue, recordEgg, dayNumber,
    type EggStore, type Ledger,
} from './easterEggs';

// ── registry ─────────────────────────────────────────────────────────────────

/**
 * stage   — the moment owns the screen while it runs: a dimmed backdrop that
 *           catches the pointer (so a skip-click can never land on a button
 *           hidden behind it), focus moved onto the overlay unless the user is
 *           in a text field. Reserved for moments the user caused on purpose.
 * passive — decoration over the app: pointer-events none, focus untouched.
 *           A click goes straight through to the app (and also skips).
 */
export type MomentMode = 'stage' | 'passive';

export interface MomentPolicy {
    /** Stop for good after this many plays. */
    maxTimes?: number;
    /** Minimum gap between plays. */
    cooldownMs?: number;
    /** At most once per LOCAL calendar day. */
    oncePerDay?: boolean;
    /**
     * Probability (0–1] that a trigger which IS due actually plays. Rolled once
     * per trigger, before anything is claimed: a miss costs nothing (the
     * cooldown is not started), it just keeps the moment a surprise.
     */
    chance?: number;
    /** The first play on this device skips the dice (`chance` applies from the second on). */
    firstAlways?: boolean;
}

/**
 * Every moment is paced for someone who did NOT expect it (owner, 2026-10-20:
 * "I don't have time to read it … give people time to react"). Five phases,
 * in order, all in ms:
 *
 *   notice — a beat to look: something small appears or the backdrop dims
 *            (0.4–0.6 s) before anything travels;
 *   main   — the gag itself, slower than it feels it needs to be, and over
 *            when the punchline (`shown`) is FULLY on screen;
 *   read   — the punchline fully visible, at least readMs(shown); secondary
 *            motion (a bob, steam, the last firework) may still be settling;
 *   hold   — the settled final frame: nothing travels (≥ 1 s, "a solid second
 *            after the animation is done");
 *   exit   — a gentle way out (0.5–0.7 s).
 *
 * The host publishes the phase start times as CSS custom properties
 * (momentStyleVars), so every view's exit runs off the same numbers the timer
 * uses. Any key or click still skips at once, in every phase.
 */
export interface MomentTimeline { notice: number; main: number; read: number; hold: number; exit: number }

/** What a registry entry declares; `durationMs` is derived from the timeline. */
export interface MomentSpec {
    mode: MomentMode;
    timeline: MomentTimeline;
    /**
     * The punchline exactly as the animated view shows it (the elements marked
     * `data-read` in the view; MomentHost.test checks they match). Its length
     * sets the minimum `read` phase.
     */
    shown: string;
    /**
     * Ambient moments (nobody pressed anything just now) wait for a quiet
     * moment: window visible, no live call, no keystroke for IDLE_KEY_MS.
     * Moments answering a user action play at once (or are dropped).
     */
    waitForIdle: boolean;
    /** The still card under reduced motion, and the aria-live announcement. */
    headline: string;
    line: string;
    /**
     * Optional real button (stage moments only): appears when the punchline
     * is up (the read phase) and, when pressed, dispatches `event` on window,
     * with the requester's context (which server) as `detail`, for the app to
     * act on, then ends the moment. Tab reaches it.
     */
    action?: MomentAction;
    /** The frame the harness photographs as this moment's hero shot (default: the settled hold frame). */
    heroMs?: number;
}

export interface MomentDef extends MomentSpec {
    /** Full length: notice + main + read + hold + exit. The overlay is gone when it elapses. */
    durationMs: number;
}

export interface MomentAction {
    label: string;
    event: string;
    /**
     * The button never times out (owner, 2026-10-20: "stay there unless they
     * click away"): once it is up, the moment waits on its settled frame until
     * the button is pressed, the backdrop is clicked, or a key is pressed.
     */
    stays?: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const timelineTotal = (t: MomentTimeline) => t.notice + t.main + t.read + t.hold + t.exit;
const moment = <T extends MomentSpec>(spec: T): T & { durationMs: number } => ({ ...spec, durationMs: timelineTotal(spec.timeline) });
/** [notice, main, read, hold, exit] in ms, the same order as the table in docs/personality.md. */
const tl = (notice: number, main: number, read: number, hold: number, exit: number): MomentTimeline => ({ notice, main, read, hold, exit });

export const MOMENTS = {
    /** Add Friend with your own tag. The request is never sent. */
    'self-friend': moment({
        mode: 'stage', waitForIdle: false, timeline: tl(500, 4400, 2500, 1000, 600),
        shown: 'You played yourself.',
        headline: 'Friend request from: you. To: you.',
        line: 'You played yourself.',
    }),
    /** First message ever sent to your own notes chat (on this device). */
    'note-to-self': moment({
        mode: 'stage', waitForIdle: false, timeline: tl(500, 4300, 2600, 1000, 600),
        shown: 'Read receipt: also you.',
        headline: 'Note to self: delivered.',
        line: 'Read receipt: also you.',
    }),
    /** @everyone / @here sent in a server where you are the only member. */
    'echo-everyone': moment({
        mode: 'stage', waitForIdle: false, timeline: tl(500, 3700, 2600, 1000, 600),
        shown: 'It’s just you in here.',
        headline: '@everyone… everyone… one…',
        line: 'It’s just you in here.',
        action: { label: 'Invite friends', event: 'cipherline:moment-invite', stays: true },
    }),
    /** A message that @mentions yourself. */
    'self-ping': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2900, 2500, 1000, 600),
        shown: 'Ping! …it was you.',
        headline: 'You pinged yourself.',
        line: 'Notification delivered. To you.',
    }),
    /** Joining a voice channel at 11:11 (am or pm), local time. */
    'wish': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2100, 2500, 1000, 600),
        shown: '11:11 — make a wish.',
        headline: '11:11.',
        line: 'Make a wish.',
    }),
    /** Joining a voice channel in a server where nobody else is online. */
    'empty-party': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 3200, 3600, 1000, 600),
        shown: 'Snacks are out. Guests: any minute now.',
        headline: 'Nobody else is online.',
        line: 'Keys put the snacks out anyway.',
    }),
    /** Pushing a volume slider past its 200% ceiling, three times in a few seconds. */
    'volume-ceiling': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 1300, 2500, 1000, 600),
        shown: '200% is the ceiling.',
        headline: '200% is the ceiling.',
        line: 'Keys would like his ears back.',
    }),
    /** Your accepted-friends count crossing 100 (seen happen, not loaded at 100+). */
    'friends-100': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 2700, 3600, 1000, 700),
        shown: '100 friends. That’s officially a school.',
        headline: '100 friends.',
        line: 'That’s officially a school.',
    }),
    /** Your server count crossing 10 (seen happen). */
    'servers-10': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 2600, 3200, 1000, 700),
        shown: 'Ten servers. You’ve built a reef.',
        headline: 'Ten servers.',
        line: 'You’ve built a reef.',
    }),
    /** The app has been open for 12 hours straight. */
    'coffee': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 2200, 3600, 1000, 700),
        shown: 'Twelve hours straight. Coffee’s on Keys.',
        headline: 'Twelve hours straight.',
        line: 'Coffee’s on Keys.',
    }),
    /** The first time the app is open on New Year's Day (local). */
    'new-year': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 2500, 3800, 1000, 700),
        shown: 'Happy New Year! Fireworks, but underwater.',
        headline: 'Happy New Year!',
        line: 'Fireworks, but underwater.',
    }),
    /** The day your account turns another year older (local calendar). */
    'anniversary': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 2200, 4100, 1000, 700),
        shown: 'Happy Cipherversary. Thanks for sticking around.',
        headline: 'Happy Cipherversary.',
        line: 'Thanks for sticking around.',
    }),
    /** Reacting to your own messages ten times inside two minutes. */
    'self-fan': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2000, 3000, 1000, 600),
        shown: 'Your biggest fan. (It’s you.)',
        headline: 'Ten reactions. All yours.',
        line: 'Your biggest fan, as always.',
    }),
    /** Creating a channel called "general" in a server that already has one. */
    'double-general': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2100, 2700, 1000, 600),
        shown: '#general, meet #general.',
        headline: '#general, meet #general.',
        line: 'They’ll never tell each other apart.',
    }),
    /** Leaving a server and rejoining it within a minute. */
    'revolving-door': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 3100, 3000, 1000, 600),
        shown: 'Welcome back. That was quick.',
        headline: 'Back already?',
        line: 'The door spins both ways.',
    }),
    /** The first time you ban a member from a server, after the ban went through. */
    'first-ban': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2600, 2700, 1000, 600),
        shown: 'Justice has been served.',
        headline: 'Your first ban.',
        line: 'Justice has been served.',
    }),
    /** The first message this (new) account ever delivered. */
    'first-message': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2600, 3300, 1000, 600),
        shown: 'Encrypted, like everything else.',
        headline: 'Your first message.',
        line: 'Encrypted, like everything else.',
    }),
    /** The first call that connected on this (new) account. */
    'first-call': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2800, 3200, 1000, 600),
        shown: 'You’re connected. Say something.',
        headline: 'Your first call.',
        line: 'You’re connected. Say something.',
    }),
    /** The first server you create. */
    'first-server': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 3000, 2500, 1000, 600),
        shown: 'Population: 1.',
        headline: 'Your first server.',
        line: 'Population: 1.',
    }),
    /** The 100th call that connects. */
    'call-100': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 2900, 3200, 1000, 600),
        shown: '100 calls. Somebody was on mute.',
        headline: 'Your 100th call.',
        line: 'Somebody was on mute.',
    }),
    /** March 14th, around 1:59 p.m. local. */
    'pi-day': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 2800, 3100, 1000, 700),
        shown: 'Happy Pi Day. Keys brought pie.',
        headline: '3/14, 1:59.',
        line: 'Keys brought pie.',
    }),
    /** February 29th, the first time the app is used that day. */
    'leap-day': moment({
        mode: 'passive', waitForIdle: true, timeline: tl(500, 3000, 3100, 1000, 700),
        shown: 'Bonus day. Try not to waste it.',
        headline: 'February 29.',
        line: 'Bonus day. Try not to waste it.',
    }),
    /** Midnight on New Year's Eve, while you are in a call. */
    'nye-call': moment({
        mode: 'passive', waitForIdle: false, timeline: tl(500, 3000, 3300, 1000, 700),
        shown: 'Midnight, mid-call. Happy New Year!',
        headline: 'Midnight, mid-call.',
        line: 'Happy New Year!',
    }),
} satisfies Record<string, MomentDef>;

export type MomentId = keyof typeof MOMENTS;

export function isMomentId(v: unknown): v is MomentId {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(MOMENTS, v);
}

/**
 * CEREMONIES — full-screen theatre that is NOT an easter egg.
 *
 * A ceremony rides the same stage as a moment (MomentHost: portal, z-layer,
 * skip, focus, hidden-window pause, reduced-motion card, live announcement) but
 * answers something the user did ON PURPOSE and should always be answered, so it
 * takes none of the egg machinery: no rarity table, no dice, no cooldown, no
 * seen-ledger entry, no waiting for a quiet moment, and it is never counted
 * towards the Egg hunter badge (it is deliberately not in EGG_IDS). It plays the
 * instant it is asked for, over whatever moment is on screen. Its once-per-account
 * rule belongs to its TRIGGER (utils/firstVerification.ts keeps the per-account
 * flag), not to the host.
 *
 * Because the person caused it and is watching for the result, it is shorter than
 * a moment (about 4 s rather than 6-9 s); a click or any key still skips it, in
 * every phase. `{name}` in the copy is the other person's display name.
 */
export const CEREMONIES = {
    /** The first time you mark ANY contact's safety number as verified (utils/firstVerification.ts). */
    'safety-verified': moment({
        mode: 'stage', waitForIdle: false, timeline: tl(300, 1200, 1700, 400, 400),
        shown: 'Verified. Only you and {name} hold the keys.',
        headline: 'Verified.',
        line: 'Only you and {name} hold the keys.',
    }),
} satisfies Record<string, MomentDef>;

export type CeremonyId = keyof typeof CEREMONIES;

export function isCeremonyId(v: unknown): v is CeremonyId {
    return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CEREMONIES, v);
}

/** Anything the stage can play: an egg moment or a ceremony. */
export type StageId = MomentId | CeremonyId;

/** The definition behind a stage id. */
export function stageDef(id: StageId): MomentDef {
    return isCeremonyId(id) ? CEREMONIES[id] : MOMENTS[id];
}

/** The other person's name as it is spoken on the stage: trimmed, one line, capped, never empty. */
export const PEER_NAME_MAX = 24;
export function cleanPeerName(raw: unknown): string {
    if (typeof raw !== 'string') return 'them';
    // eslint-disable-next-line no-control-regex
    const one = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!one) return 'them';
    const chars = [...one];
    return chars.length > PEER_NAME_MAX ? `${chars.slice(0, PEER_NAME_MAX - 1).join('').trimEnd()}…` : one;
}

/** The headline and line a stage id shows, with `{name}` filled in for a ceremony. */
export function stageText(id: StageId, peer?: string | null): { headline: string; line: string } {
    const d = stageDef(id);
    if (!isCeremonyId(id)) return { headline: d.headline, line: d.line };
    const name = cleanPeerName(peer);
    const fill = (t: string) => t.split('{name}').join(name);
    return { headline: fill(d.headline), line: fill(d.line) };
}

/**
 * HOW OFTEN: the one table (mirrored in docs/personality.md). Owner,
 * 2026-10-20: "they're good but should only be a once in a while thing, not
 * something that happens every time". Milestones and one-off novelties play
 * once ever; the rest wait days to weeks, and the ones a person can trip over
 * every day also roll a die.
 */
export const MOMENT_RARITY = {
    'self-friend':    { firstAlways: true, chance: 1 / 4, cooldownMs: 7 * DAY },  // first time always, then 1 in 4, at most weekly
    'note-to-self':   { maxTimes: 1 },                                             // once ever
    'echo-everyone':  { cooldownMs: 30 * DAY },                                    // first time always (Invite friends helps), then monthly
    'self-ping':      { chance: 1 / 3, cooldownMs: 7 * DAY },                      // 1 in 3, at most weekly
    'wish':           { cooldownMs: 7 * DAY },                                     // at most weekly
    'empty-party':    { cooldownMs: 14 * DAY },                                    // at most every two weeks
    'volume-ceiling': { cooldownMs: 30 * DAY },                                    // at most monthly
    'friends-100':    { maxTimes: 1 },                                             // once ever
    'servers-10':     { maxTimes: 1 },                                             // once ever
    'coffee':         { cooldownMs: 30 * DAY },                                    // at most monthly
    'new-year':       { oncePerDay: true },                                        // Jan 1 only, so once a year
    'anniversary':    { oncePerDay: true },                                        // the anniversary only, so once a year
    'self-fan':       { cooldownMs: 30 * DAY },                                    // at most monthly
    'double-general': { cooldownMs: 30 * DAY },                                    // at most monthly
    'revolving-door': { cooldownMs: 30 * DAY },                                    // at most monthly
    'first-ban':      { maxTimes: 1 },                                             // once ever
    'first-message':  { maxTimes: 1 },                                             // once ever (and only for an account under a day old)
    'first-call':     { maxTimes: 1 },                                             // once ever (and only for an account under a day old)
    'first-server':   { maxTimes: 1 },                                             // once ever
    'call-100':       { maxTimes: 1 },                                             // once ever
    'pi-day':         { oncePerDay: true },                                        // Mar 14 only, so once a year
    'leap-day':       { oncePerDay: true },                                        // Feb 29 only, so once per leap day
    'nye-call':       { oncePerDay: true },                                        // the first minute of Jan 1 only, so once a year
} satisfies Record<MomentId, MomentPolicy>;

export const momentPolicy = (id: MomentId): MomentPolicy => MOMENT_RARITY[id];

// ── pacing ───────────────────────────────────────────────────────────────────

/** Reading time for a line nobody expected: 1.2 s + 60 ms a character, never under 2.5 s. */
export const READ_BASE_MS = 1200;
export const READ_PER_CHAR_MS = 60;
export const READ_MIN_MS = 2500;
/** The settled final frame stays at least this long. */
export const HOLD_MIN_MS = 1000;
export function readMs(text: string): number {
    return Math.max(READ_MIN_MS, READ_BASE_MS + READ_PER_CHAR_MS * [...text.trim()].length);
}

/** Phase START times (ms from the beginning) and the end. */
export interface MomentPhases { main: number; read: number; hold: number; exit: number; end: number }
export function momentPhases(id: StageId): MomentPhases {
    const t: MomentTimeline = stageDef(id).timeline;
    const read = t.notice + t.main;
    const hold = read + t.read;
    const exit = hold + t.hold;
    return { main: t.notice, read, hold, exit, end: exit + t.exit };
}

/** Does this moment wait on its button instead of timing out? */
export function momentStays(id: StageId): boolean {
    const d: MomentDef = stageDef(id);
    return d.mode === 'stage' && d.action?.stays === true;
}

/**
 * The phase times as CSS custom properties on the moment's root, so a view's
 * keyframes hang off them (`animation-delay: var(--mo-exit)`) and never drift
 * from the host's timer. A moment that waits on its button never schedules
 * its exit.
 */
export function momentStyleVars(id: StageId): Record<string, string> {
    const p = momentPhases(id);
    return {
        '--mo-main': `${p.main}ms`,
        '--mo-read': `${p.read}ms`,
        '--mo-hold': `${p.hold}ms`,
        '--mo-exit': momentStays(id) ? '86400s' : `${p.exit}ms`,
        '--mo-exit-dur': `${stageDef(id).timeline.exit}ms`,
        '--mo-dur': `${p.end}ms`,
    };
}

/** Reduced motion: the still card stays long enough to read both its lines, plus the hold. */
export function stillMs(id: StageId, peer?: string | null): number {
    const t = stageText(id, peer);
    return readMs(`${t.headline} ${t.line}`) + HOLD_MIN_MS;
}
/** The ceiling every moment's timeline stays under (a moment waiting on its button aside). */
export const MAX_MOMENT_MS = 9000;
/** An ambient moment waits this long after the last keystroke. */
export const IDLE_KEY_MS = 8_000;
/** How often a waiting ambient moment re-checks, and for how long at most. */
export const PENDING_POLL_MS = 2_000;
export const PENDING_MAX_MS = 15 * MIN;

export function announcement(id: StageId, peer?: string | null): string {
    const t = stageText(id, peer);
    return `${t.headline} ${t.line}`;
}

// ── the ledger (shared with the eggs, never gated by their switch) ──────────

export const ledgerId = (id: MomentId) => `moment:${id}`;

/** May this moment play right now? Pure; records nothing. */
export function momentDue(ledger: Ledger, id: MomentId, now: number): boolean {
    const policy = momentPolicy(id);
    const key = ledgerId(id);
    if (!eggDue(ledger, key, now, policy)) return false;
    const e = ledger[key];
    if (policy.oncePerDay && e && dayNumber(new Date(e.last)) === dayNumber(new Date(now))) return false;
    return true;
}

/** Peek without claiming (a corrupt or unreadable ledger = due). */
export function momentDueIn(store: EggStore, id: MomentId, now: number): boolean {
    let ledger: Ledger;
    try { ledger = parseLedger(store.getItem(EGG_LEDGER_KEY)); } catch { ledger = {}; }
    return momentDue(ledger, id, now);
}

/**
 * Policy satisfied → record the play and return true. An unreadable store
 * returns false (better to skip a joke than to repeat a once-ever one); a
 * failed WRITE still plays — it only costs the rate limit.
 */
export function claimMoment(store: EggStore, id: MomentId, now: number): boolean {
    let ledger: Ledger;
    try { ledger = parseLedger(store.getItem(EGG_LEDGER_KEY)); } catch { return false; }
    if (!momentDue(ledger, id, now)) return false;
    try { store.setItem(EGG_LEDGER_KEY, JSON.stringify(recordEgg(ledger, ledgerId(id), now))); } catch { /* still play */ }
    return true;
}

/**
 * The rarity die (MomentPolicy.chance). Pure: `rng` is injected (Math.random
 * in the app, a fixed value in tests and the harness). Rolled once per
 * trigger; `firstAlways` skips it until the moment has played once.
 */
export function momentRoll(ledger: Ledger, id: MomentId, rng: () => number): boolean {
    const p = momentPolicy(id);
    if (p.chance === undefined || p.chance >= 1) return true;
    if (p.firstAlways && !(ledger[ledgerId(id)]?.count)) return true;
    return rng() < p.chance;
}

/** momentRoll against the store (an unreadable store rolls as a first play would). */
export function momentRollIn(store: EggStore, id: MomentId, rng: () => number): boolean {
    let ledger: Ledger;
    try { ledger = parseLedger(store.getItem(EGG_LEDGER_KEY)); } catch { ledger = {}; }
    return momentRoll(ledger, id, rng);
}

/** How many times has this moment played on this device? */
export function momentCount(store: EggStore, id: MomentId): number {
    try { return parseLedger(store.getItem(EGG_LEDGER_KEY))[ledgerId(id)]?.count ?? 0; } catch { return 0; }
}

// ── triggers (structural facts only) ───────────────────────────────────────

/**
 * Is this parsed tag the signed-in user's own? Exact match — the same rule
 * the server uses to find the recipient — so a different person whose name
 * differs only in case is never blocked.
 */
export function isOwnTag(
    tag: { username: string; discriminator: number } | null | undefined,
    me: { username?: string | null; discriminator?: number | null } | null | undefined,
): boolean {
    if (!tag || !me || !me.username || me.discriminator === null || me.discriminator === undefined) return false;
    return tag.username === me.username && tag.discriminator === me.discriminator;
}

/** The structural shape of a parsed mention token — its TYPE, never the text around it. */
export interface MentionFact { type: 'everyone' | 'here' | 'user' | 'role'; id?: string }

/**
 * Which moment (if any) an outgoing message's mention tokens earn. Called on
 * SEND only, with the tokens the composer already parsed for the wire —
 * never the message text.
 *   - @everyone / @here in a server whose roster is loaded and holds nobody
 *     but you → 'echo-everyone';
 *   - a mention of your own user id → 'self-ping'.
 * `othersInServer` is null when unknown (not a server channel, roster not
 * loaded) — then the echo never fires.
 */
export function mentionMoment(
    mentions: readonly MentionFact[],
    ctx: { me: string | null | undefined; othersInServer: number | null },
): MomentId | null {
    if (ctx.othersInServer === 0 && mentions.some(m => m.type === 'everyone' || m.type === 'here')) return 'echo-everyone';
    if (ctx.me && mentions.some(m => m.type === 'user' && m.id === ctx.me)) return 'self-ping';
    return null;
}

/** 11:11 or 23:11 on the local clock. */
export function isWishTime(d: Date): boolean {
    return d.getHours() % 12 === 11 && d.getMinutes() === 11;
}

const OFFLINE = new Set(['offline', 'invisible', '']);

/**
 * Which moment (if any) joining a voice channel earns. Facts: the local clock,
 * and the server roster's presence statuses (null = roster not loaded → no
 * party). The wish outranks the party.
 */
export function voiceJoinMoment(
    now: Date,
    members: ReadonlyArray<{ user_id: string; status?: string | null }> | null,
    me: string | null | undefined,
): MomentId | null {
    if (isWishTime(now)) return 'wish';
    if (me && members && members.length > 0 && !members.some(m => m.user_id !== me && !OFFLINE.has(m.status ?? ''))) return 'empty-party';
    return null;
}

/**
 * Did a count just cross `n` — SEEN happening this session? `prev` null =
 * the first observation (a fresh load) never counts, and a jump of more than
 * two at once is a load/resync, not the user reaching it, so it never counts
 * either: someone who already has 140 friends is not congratulated on boot.
 */
export function crossedMilestone(prev: number | null, cur: number | null, n: number): boolean {
    if (prev === null || cur === null) return false;
    return prev < n && cur >= n && cur - prev <= 2;
}

/** The coffee comes after this long with the app open. */
export const COFFEE_AFTER_MS = 12 * HOUR;

/** Is `d` (local) the anniversary of an account created at `createdIso`? Feb 29 sign-ups celebrate on Feb 28 in common years. */
export function isAccountAnniversary(d: Date, createdIso: string | null | undefined): boolean {
    if (!createdIso) return false;
    const c = new Date(createdIso);
    if (!Number.isFinite(c.getTime()) || d.getFullYear() <= c.getFullYear()) return false;
    const m = c.getMonth();
    let day = c.getDate();
    const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (m === 1 && day === 29 && !leap(d.getFullYear())) day = 28;
    return d.getMonth() === m && d.getDate() === day;
}

/**
 * Pi Day: March 14th, 1:59 p.m. local — 3/14, 1:59 (3.14159). The clock is only
 * checked once a minute and a laptop may be asleep through the exact minute, so
 * the window is a few minutes either side: 1:54–2:04 p.m. (`PI_WINDOW`). The
 * ledger (`oncePerDay`) keeps it to one play a year however many ticks land in it.
 */
export const PI_WINDOW = { from: 13 * 60 + 54, to: 14 * 60 + 4 } as const;
export function isPiDay(d: Date): boolean {
    if (d.getMonth() !== 2 || d.getDate() !== 14) return false;
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= PI_WINDOW.from && m <= PI_WINDOW.to;
}

/** February 29th (local) — a date that only exists in a leap year, so it can only ever be offered on one. */
export function isLeapDay(d: Date): boolean {
    return d.getMonth() === 1 && d.getDate() === 29;
}

/** The clock-driven moments due right now (MomentClock offers each; the ledger keeps them rare). */
export function clockMoments(now: Date, openSince: number, createdIso: string | null | undefined): MomentId[] {
    const out: MomentId[] = [];
    if (now.getMonth() === 0 && now.getDate() === 1) out.push('new-year');
    if (isAccountAnniversary(now, createdIso)) out.push('anniversary');
    if (isLeapDay(now)) out.push('leap-day');
    if (isPiDay(now)) out.push('pi-day');
    if (now.getTime() - openSince >= COFFEE_AFTER_MS) out.push('coffee');
    return out;
}

/**
 * New Year's midnight, in a call. The first MINUTE of January 1st (local) is
 * "midnight": the call is what makes it a moment, so it needs `inCall`. Pure —
 * MomentClock arms a timer for the exact second (`msUntilNewYear`) and also
 * checks here on its minute tick, so a throttled timer still catches it.
 */
export function nyeCallDue(now: Date, inCall: boolean): boolean {
    return inCall && now.getMonth() === 0 && now.getDate() === 1 && now.getHours() === 0 && now.getMinutes() === 0;
}
/** Milliseconds until the next local January 1st, 00:00:00. */
export function msUntilNewYear(now: Date): number {
    return new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0).getTime() - now.getTime();
}

/**
 * Two moments that would both celebrate the same thing: when the first plays,
 * the second is spent for that day without being SHOWN (so the call fireworks
 * and "Fireworks, but underwater" never double up on New Year's). The skipped
 * one is written to the ledger with its count untouched — an entry with count 0
 * is "not due today" for `oncePerDay` but is never credited as a find.
 */
export const MOMENT_YIELDS: Partial<Record<MomentId, readonly MomentId[]>> = { 'nye-call': ['new-year'] };
export function yieldMoments(store: EggStore, id: MomentId, now: number): void {
    const yielded = MOMENT_YIELDS[id];
    if (!yielded?.length) return;
    let ledger: Ledger;
    try { ledger = parseLedger(store.getItem(EGG_LEDGER_KEY)); } catch { return; }
    for (const y of yielded) ledger = { ...ledger, [ledgerId(y)]: { count: ledger[ledgerId(y)]?.count ?? 0, last: now } };
    try { store.setItem(EGG_LEDGER_KEY, JSON.stringify(ledger)); } catch { /* the cost is a double up, nothing more */ }
}

// ── milestones: the "firsts" and the 100th call ────────────────────────────

/**
 * "Your first message / call" is only a first for an account that is NEW. The
 * client has no sent-message history to consult (messages are deleted on
 * delivery and the device-local ledger cannot tell a new device from an old
 * one), so the account's own age is the structural fact: created within the
 * last day. An older account — someone moving to a new machine, or a tester who
 * has been here for months — is never told its tenth-thousandth message is its
 * first. (A few minutes of clock skew either way are tolerated.)
 */
export const NEWCOMER_MS = DAY;
export function isNewcomer(createdIso: string | null | undefined, now: number = Date.now()): boolean {
    if (!createdIso) return false;
    const c = Date.parse(createdIso);
    if (!Number.isFinite(c)) return false;
    const age = now - c;
    return age >= -5 * MIN && age < NEWCOMER_MS;
}

/** The call that earns `call-100`. */
export const CALL_MILESTONE = 100;
/** Parse the persisted connected-calls counter; junk is 0. */
export function parseCallCount(raw: string | null | undefined): number {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n < 1e9 ? n : 0;
}

/**
 * Which "first / 100th" moment (if any) a call that just CONNECTED earns.
 * `before` is the account's connected-call count before this one. Facts only:
 * a count, the account's age, and what the account has already found (so a
 * second machine, or a restore, never plays a once-ever moment again).
 */
export function callConnectedMoment(before: number, createdIso: string | null | undefined, found: readonly string[], now: number = Date.now()): MomentId | null {
    if (before + 1 === CALL_MILESTONE && !found.includes('call-100')) return 'call-100';
    if (before === 0 && isNewcomer(createdIso, now) && !found.includes('first-call')) return 'first-call';
    return null;
}

/** A message was DELIVERED (server accepted it): the first one, for a new account, outside your own notes. */
export function messageDeliveredMoment(createdIso: string | null | undefined, found: readonly string[], isSelfChat: boolean, now: number = Date.now()): MomentId | null {
    if (isSelfChat || found.includes('first-message')) return null;
    return isNewcomer(createdIso, now) ? 'first-message' : null;
}

/**
 * A server was created. It is your FIRST only if the (loaded) server list held
 * no server you own beforehand — `ownedBefore` null = the list was not loaded,
 * so say nothing — and this account has not already found it elsewhere.
 */
export function serverCreatedMoment(ownedBefore: number | null, found: readonly string[]): MomentId | null {
    return ownedBefore === 0 && !found.includes('first-server') ? 'first-server' : null;
}

/** Reactions to your own messages: this many inside the window is a fan club. */
export const SELF_REACTS = 10;
export const SELF_REACT_WINDOW_MS = 2 * MIN;
export function selfReact(times: readonly number[], now: number = Date.now()): { times: number[]; fire: boolean } {
    const next = [...times.filter(t => now - t < SELF_REACT_WINDOW_MS && now >= t), now];
    return next.length >= SELF_REACTS ? { times: [], fire: true } : { times: next, fire: false };
}

/** A new channel named exactly like an existing one, when that name is "general". */
export function isSecondGeneral(created: { channel_id: string; name: string }, existing: ReadonlyArray<{ channel_id: string; name: string }> | null | undefined): boolean {
    const norm = (n: string) => n.trim().toLowerCase().replace(/^#/, '');
    if (norm(created.name) !== 'general') return false;
    return (existing ?? []).some(c => c.channel_id !== created.channel_id && norm(c.name) === 'general');
}

/**
 * Leave-and-rejoin tracking (memory only, never persisted). A server left is
 * remembered for REJOIN_WINDOW_MS; once it has been SEEN absent from your
 * server list and then reappears inside the window, that's the revolving door.
 */
export const REJOIN_WINDOW_MS = MIN;
const leftServers = new Map<string, { at: number; gone: boolean }>();
export function noteServerLeft(serverId: string, now = Date.now()): void { leftServers.set(serverId, { at: now, gone: false }); }
export function serverRejoined(currentIds: readonly string[], now = Date.now()): boolean {
    const present = new Set(currentIds);
    let hit = false;
    for (const [id, e] of leftServers) {
        if (now - e.at > REJOIN_WINDOW_MS || now < e.at) { leftServers.delete(id); continue; }
        if (!present.has(id)) e.gone = true;
        else if (e.gone) { hit = true; leftServers.delete(id); }
    }
    return hit;
}
/** Test-only. */
export function __resetLeftServers(): void { leftServers.clear(); }

/** A push past a slider's ceiling = a drag that runs past its end, or an increase key, while it sits at max. */
export const CEILING_PUSHES = 3;
export const CEILING_WINDOW_MS = 6_000;
export const CEILING_KEYS: ReadonlySet<string> = new Set(['ArrowRight', 'ArrowUp', 'PageUp', 'End']);

/** Record one push; `fire` on the third inside the window (then the count starts over). */
export function ceilingPush(times: readonly number[], now: number): { times: number[]; fire: boolean } {
    const next = [...times.filter(t => now - t < CEILING_WINDOW_MS && now >= t), now];
    return next.length >= CEILING_PUSHES ? { times: [], fire: true } : { times: next, fire: false };
}

/** Fired on window when a moment's "Invite friends" is pressed; Dashboard opens its existing invite dialog. */
export const MOMENT_INVITE_EVENT = 'cipherline:moment-invite';

// ── when the host may interrupt ─────────────────────────────────────────────

export interface QuietCheck {
    hidden: boolean;
    inCall: boolean;
    /** ms since the last keydown anywhere in the window (Infinity = never). */
    sinceKeyMs: number;
}

/** Is now a good time for an AMBIENT moment? (Never mid-call, mid-typing, or unseen.) */
export function quietEnough(q: QuietCheck): boolean {
    return !q.hidden && !q.inCall && q.sinceKeyMs >= IDLE_KEY_MS;
}

// ── the bus ──────────────────────────────────────────────────────────────────

/** Window event a trigger fires and the host listens for. */
export const MOMENT_EVENT = 'cipherline:moment';

/**
 * Where a moment was asked for — only what its button needs to act on the
 * right thing (the echo's "Invite friends" opens THAT server's invite
 * dialog). An id, never content.
 */
export interface MomentContext { serverId?: string | null }

/**
 * Ask for a moment. Fire-and-forget: the host decides (rate limit, a moment
 * already playing, a call in progress…) and nothing happens if no host is
 * mounted. Carries the moment's id and, optionally, a MomentContext.
 */
export function requestMoment(id: MomentId, ctx?: MomentContext): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const serverId = typeof ctx?.serverId === 'string' && ctx.serverId ? ctx.serverId : null;
    try { window.dispatchEvent(new CustomEvent(MOMENT_EVENT, { detail: serverId ? { id, serverId } : { id } })); } catch { /* non-fatal */ }
}

/** Window event a trigger fires for a ceremony and the host listens for. */
export const CEREMONY_EVENT = 'cipherline:ceremony';

/** Where a ceremony was asked for: the other person's display name, nothing else. */
export interface CeremonyContext { peer?: string | null }

/**
 * Ask for a ceremony. Guaranteed: the host plays it at once, with no rarity, no
 * dice, no ledger and no waiting, replacing a moment that is on screen. (Nothing
 * happens if no host is mounted.) Whether it SHOULD play — once per account — is
 * the caller's business; see utils/firstVerification.ts.
 */
export function requestCeremony(id: CeremonyId, ctx?: CeremonyContext): void {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    const peer = typeof ctx?.peer === 'string' && ctx.peer.trim() ? cleanPeerName(ctx.peer) : null;
    try { window.dispatchEvent(new CustomEvent(CEREMONY_EVENT, { detail: peer ? { id, peer } : { id } })); } catch { /* non-fatal */ }
}

/** The detail of MOMENT_INVITE_EVENT: which server's invite dialog to open (null = the open one). */
export interface MomentInviteDetail { serverId: string | null }
