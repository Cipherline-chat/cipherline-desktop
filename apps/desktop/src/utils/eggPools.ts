/**
 * eggPools — every text pool the personality catalog draws from, plus the pure
 * selectors that pick a line. See `docs/personality.md` for the doctrine.
 *
 * Why this file exists at all: the doctrine's rules are checkable, and this is
 * the only place they CAN be checked. Vitest here runs `environment: 'node'`
 * with `include: ['src/**\/*.test.ts']` and no `matchMedia` stub, so anything
 * importing React or `clPhysics.ts` is untestable by construction. Keeping the
 * copy in a dependency-free module lets `eggPools.test.ts` enforce rule 3
 * (pools need ≥3 lines) and rule 4 (banned vocabulary) automatically — every
 * pool registered in ALL_POOLS below is covered whether or not anyone
 * remembers to write a test for it.
 *
 * Voice, as established by the pools that shipped before this file:
 * lowercase and dry for inline field messages, sentence case for status
 * labels, factually true about E2E every time, and never a joke at the user's
 * expense (writing test #4). Typographic ’ and … to match the rest of the app.
 */

// ── selectors ────────────────────────────────────────────────────────────────

/** Cycle a pool. Consecutive `seq` values never repeat a line (rule 3). */
export function pickRotating<T>(pool: readonly T[], seq: number): T {
    return pool[((seq % pool.length) + pool.length) % pool.length];
}

/** Walk a pool and stay on the last line once exhausted — for eggs that
 *  escalate toward a punchline rather than looping (the header-lock '…' is the
 *  shipped example of the shape). */
export function pickEscalating<T>(pool: readonly T[], step: number): T {
    if (step < 0) return pool[0];
    return pool[Math.min(step, pool.length - 1)];
}

// ── cuttlefish (StartDMModal search) ─────────────────────────────────────────

/** Typing `cuttlefish` in the people search. Replaces a single hardcoded
 *  'you rang?' — one line is not a pool (rule 3). */
export const CUTTLEFISH_POOL = [
    'you rang?',
    'eight arms, zero access to your messages.',
    'found me. still can’t read anything.',
    'not on your friends list. or anyone’s.',
] as const;

/** Searching for yourself. Moved here from StartDMModal so the registry test
 *  covers it too. You CAN message yourself now (a one-member DM, encrypted to
 *  your own devices), so the old "can't DM yourself" line was retired. */
export const SELF_EGGS = [
    'you already talk to yourself plenty.',
    'that’s you. hi.',
    'notes to self, encrypted to you and nobody else.',
] as const;

// ── composer hesitation (ChatPane) ───────────────────────────────────────────

/**
 * Wrote something real, then deleted all of it — three times over.
 *
 * Tone matters more here than anywhere else in this file. Drafting and
 * deleting is often someone composing something difficult, so a line that
 * pokes at the hesitation itself would punch at the user, which writing test
 * #4 forbids. Every line below points at the TEXT instead, and each is
 * literally true: an unsent draft never left this machine, so nobody saw it
 * and nothing can be recovered. That's reassurance doing the work, not a joke
 * at anyone's expense.
 */
export const DRAFT_ERASED_POOL = [
    'nobody saw that.',
    'gone. it never left this machine.',
    'unsent, unsendable, unrecoverable.',
    'the draft folder here is imaginary.',
] as const;

/** Consecutive write-then-erase cycles before the pool speaks. */
export const DRAFT_ERASED_AT = 3;
/** Characters that count as "wrote something", vs a stray keypress. */
export const DRAFT_MIN_CHARS = 10;

// ── channel naming (ChannelSettingsDialog) ───────────────────────────────────

/** Naming a channel one of the four inevitable names. Drawn at random per
 *  keystroke-match; every line is true about E2E or true about the name. */
export const CHANNEL_NAME_EGGS: Record<string, readonly string[]> = {
    general: [
        'the default. bold.',
        'every server has one. this one’s encrypted, at least.',
        'naming is hard. we get it.',
    ],
    memes: [
        'encrypted memes. same as unencrypted memes, but private.',
        'the server can’t see them either. tragic.',
        'hope they’re good ones.',
    ],
    random: [
        'a channel for everything, which means a channel for nothing.',
        'where topics go to stop being topics.',
        'no theme, no rules, still encrypted.',
    ],
    announcements: [
        'it’ll get two posts, then silence. every time.',
        'the one channel nobody mutes. allegedly.',
        'big words go here, apparently.',
    ],
};

/**
 * Placeholder impatience after repeatedly focusing the empty name field.
 * Deliberately written as VALID hyphenated channel names: the placeholder is a
 * suggestion slot, so the joke must not stop it doing its actual job (rule 5).
 */
export const CHANNEL_NAME_IMPATIENCE = [
    'still-nothing',
    'type-anything',
    'we-can-wait',
    'any-word-will-do',
    'literally-any-word',
    'the-cursor-is-right-there',
] as const;

/** Focus count at which the impatience pool takes over the placeholder. */
export const IMPATIENCE_AFTER_FOCUSES = 4;

/**
 * Match a typed channel name to its egg pool. Normalizes the way a user
 * actually types: trims, lowercases, drops a leading `#`, and collapses inner
 * whitespace to `-` (which is what the name will become anyway).
 * Returns null for anything unrecognized — `generalist` is not `general`.
 */
export function channelNameEgg(rawName: string, seq: number): string | null {
    const key = rawName
        .trim()
        .toLowerCase()
        .replace(/^#+/, '')
        .replace(/\s+/g, '-');
    const pool = CHANNEL_NAME_EGGS[key];
    return pool ? pickRotating(pool, seq) : null;
}

// ── attachment uploads (ChatPane) ────────────────────────────────────────────

/** The shipped per-file status pool. */
export const ENCRYPTING_POOL = [
    'Encrypting…',
    'Scrambling bits…',
    'Doing the math…',
    'Folding it into the dark…',
] as const;

/**
 * Third consecutive upload onward. Present tense on purpose — this label
 * renders BEFORE the upload starts, so the catalog's original past-tense
 * "Encrypted. Again." would have been describing something that hadn't
 * happened yet.
 */
export const UPLOAD_STREAK_POOL = [
    'Encrypting. Again.',
    'Encrypting. Still.',
    'Yes, this one too.',
    'Same math, new file.',
] as const;

/** Streak count at which the label switches from per-file to the streak pool. */
export const UPLOAD_STREAK_AT = 3;

/**
 * Label for an upload. Under the streak threshold this stays deterministic per
 * filename — re-renders during an upload must not reroll the line, which is
 * why the shipped version hashed the name rather than picking at random.
 */
export function uploadLabel(filename: string, streak: number): string {
    if (streak >= UPLOAD_STREAK_AT) {
        return pickEscalating(UPLOAD_STREAK_POOL, streak - UPLOAD_STREAK_AT);
    }
    const hash = (filename.length * 31) + (filename.charCodeAt(0) || 0);
    return ENCRYPTING_POOL[hash % ENCRYPTING_POOL.length];
}

// ── settings search (DepthGauge) ─────────────────────────────────────────────

/** Settings search box placeholders, cycled per focus. */
export const SETTINGS_PLACEHOLDERS = [
    'Find a setting…',
    'Search the deep…',
    'It’s down here somewhere…',
    'Sonar for settings…',
] as const;

/**
 * Factual one-liners for security-flavored searches — every line true.
 * Each pool gained a third line here: they shipped with two, which is under
 * rule 3's minimum.
 */
export const SETTINGS_SEARCH_NOTES: Record<string, readonly string[]> = {
    password: [
        'Your password never leaves this device unhashed.',
        'Passwords are hashed with Argon2id. We couldn’t read yours if we wanted to.',
        'We store a verifier, not a password.',
    ],
    keys: [
        'Private keys are generated here and stay here.',
        'Your keys live in this device’s keystore. Not our servers.',
        'Lose this device’s keys and we can’t recover them. That’s the point.',
    ],
    secrets: [
        'Everything here is encrypted before it travels.',
        'Secrets are the whole product.',
        'The server stores ciphertext and routing. That’s the whole list.',
    ],
};

// ── Keys quips (home deck mascot speech) ─────────────────────────────────────

/** Keys' poke-quips on the home deck. Voice: a small deep-sea creature being
 *  poked — dry, a little put-upon, never a sales pitch. Encryption appears as
 *  punchline logic, not as a feature list (rule 4). He does NOT speak on
 *  every poke (shouldSpeak in keysBrain.ts) — the animation is the payoff. */
export const KEYS_QUIPS = [
    'ow.',
    'do I look like a button?',
    'careful — I’m load-bearing.',
    'that tickles. stop it. continue.',
    'blub.',
    'poke received. encrypted. discarded.',
    'I’m a cuttlefish, not a jellyfish. common mistake.',
    'the server can’t see this. lucky server.',
    'you know I can’t actually hear you, right?',
    'I contain multitudes. mostly keys.',
] as const;

// ── Keys contextual observations (keysObservations.ts picks by priority) ─────
// Everything below reads ONLY local UI state — counts, the clock, presence
// booleans (rule 8: no content, no metadata leaves the machine; these never
// even leave the component). `{n}` is replaced by the engine.

/** Mentions waiting (highest priority — it's also why he's amber). */
export const KEYS_OBS_MENTIONS = [
    'someone said your name. I heard nothing, obviously.',
    'you’ve been mentioned. the red dot demands tribute.',
    'people are literally saying your name and you’re poking me.',
] as const;

/** Calls happening in your servers right now. */
export const KEYS_OBS_CALLS = [
    'there are {n} people in a call right now. without you. just saying.',
    'a call is happening. I can feel the vibrations from here.',
    '{n} people talking somewhere. probably about cuttlefish.',
] as const;

/** Deep night, 00:00–04:59. */
export const KEYS_OBS_LATENIGHT = [
    'it is deeply past bedtime. I would know. I live in the deep.',
    'the 3am shift. just you, me, and the anglerfish.',
    'nothing good gets typed at this hour. type it anyway.',
] as const;

/** Early birds, 05:00–07:59. */
export const KEYS_OBS_EARLY = [
    'you’re up early. the sun doesn’t even reach this depth yet.',
    'dawn patrol. respect.',
    'early. the plankton aren’t even awake.',
] as const;

/** No backup configured — the one observation that's also advice. */
export const KEYS_OBS_NOBACKUP = [
    'still no backup. bold.',
    'your history lives on this one machine. sleep well.',
    'ink clouds protect me. backups protect you. you have none.',
] as const;

/** Unreads piling up. */
export const KEYS_OBS_UNREADS = [
    'you have {n} unread messages and one very patient mascot.',
    '{n} unread. I counted. twice.',
    'the {n} unreads aren’t going anywhere. neither am I.',
] as const;

/** Nobody online, nothing waiting. */
export const KEYS_OBS_QUIET = [
    'nobody’s around. just us down here. blub.',
    'quiet. the good kind.',
    'all clear. the ocean keeps its own counsel and so do I.',
] as const;

/** Friday. The currents feel different. */
export const KEYS_OBS_FRIDAY = [
    'it’s friday. even the abyss relaxes.',
    'friday. the currents feel different.',
    'weekend incoming. batten the hatches.',
] as const;

/** December — the marine snow window. */
export const KEYS_OBS_SNOW = [
    'marine snow. it’s detritus, but festive detritus.',
    'snowing down here too. don’t think about it too hard.',
    'the snow sinks 4,000 meters to get to you. commitment.',
] as const;

/** The sleepy protest (poke 6) — replaces a generic quip. */
export const KEYS_SLEEPY_POOL = [
    'six pokes past polite. napping now.',
    'that’s enough. I’m going to sleep out of protest.',
    'I have been poked beyond my contract.',
] as const;

// ── chat-list "1 year+" divider (Dashboard DM/group list) ────────────────────

/** Label for the chat-list section holding conversations untouched for a year
 *  or more. The younger sections get plain labels ("Today", "Yesterday", …);
 *  the oldest one gets the deep-sea treatment — the further down the list, the
 *  deeper the water. Sentence case (status-label voice); the divider's CSS
 *  uppercases it. Rotates by day via pickRotating in chatListDividers.ts. */
export const ANCIENT_CHATS_POOL = [
    'The hadal zone',
    'Sediment layer',
    'Lost to the abyss',
    'Anglerfish territory',
] as const;

// ── registry ─────────────────────────────────────────────────────────────────

/**
 * Every pool, for the doctrine tests. Add new pools here — that's what makes
 * rule 3 and rule 4 enforcement automatic rather than something a reviewer has
 * to remember.
 */
export const ALL_POOLS: Record<string, readonly string[]> = {
    CUTTLEFISH_POOL,
    SELF_EGGS,
    DRAFT_ERASED_POOL,
    CHANNEL_NAME_IMPATIENCE,
    ENCRYPTING_POOL,
    UPLOAD_STREAK_POOL,
    SETTINGS_PLACEHOLDERS,
    ANCIENT_CHATS_POOL,
    KEYS_QUIPS,
    KEYS_OBS_MENTIONS,
    KEYS_OBS_CALLS,
    KEYS_OBS_LATENIGHT,
    KEYS_OBS_EARLY,
    KEYS_OBS_NOBACKUP,
    KEYS_OBS_UNREADS,
    KEYS_OBS_QUIET,
    KEYS_OBS_FRIDAY,
    KEYS_OBS_SNOW,
    KEYS_SLEEPY_POOL,
    ...Object.fromEntries(
        Object.entries(CHANNEL_NAME_EGGS).map(([k, v]) => [`CHANNEL_NAME_EGGS.${k}`, v]),
    ),
    ...Object.fromEntries(
        Object.entries(SETTINGS_SEARCH_NOTES).map(([k, v]) => [`SETTINGS_SEARCH_NOTES.${k}`, v]),
    ),
};
