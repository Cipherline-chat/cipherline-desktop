/**
 * Public-name rules: the profanity filter for usernames (and server
 * nicknames), and the username-change cooldown.
 *
 * ONE implementation, three consumers: the API enforces it (the only
 * load-bearing check), the desktop and the website account portal run the
 * identical function for inline feedback before they submit. A client that
 * skips the mirror just gets the server's 400 instead.
 *
 * ── Profanity: what is matched, and how ─────────────────────────────────────
 * The word list and the matching engine are `obscenity` (MIT): its English
 * dataset plus its recommended transformers, which already fold
 * leetspeak (`sh1t`, `a55`), Unicode confusables/homoglyphs (Cyrillic `к`,
 * fullwidth `ｆ`, Cherokee `Ꮯ`), case, and stretched letters (`fuuuck`).
 * On top of that this module:
 *
 *   1. NFKC-normalises, strips invisible/zero-width characters and combining
 *      marks (`fúck`, `f​uck`), so they cannot split or disguise a word.
 *   2. Treats separators (`_ - . , ~` and whitespace) as WORD BREAKS and splits
 *      camelCase (`BigAss` -> `Big Ass`), because a handle has no spaces and
 *      obscenity's word-boundary patterns (`|ass`) would otherwise never see
 *      the start of the second word.
 *   3. Re-joins letters spelled out one at a time (`f_u_c_k`, `s.e.x`).
 *   4. Checks the FULLY joined form (`fu_ck` -> `fuck`) for a short STRICT
 *      list of words only (slurs and the strongest profanity). Joining
 *      everything for every word would turn `pen_is`, `this_hit` and
 *      `go_rape...` style coincidences into rejections, so the generic list
 *      only ever sees real word breaks.
 *
 * ── False-positive policy (the Scunthorpe problem) ──────────────────────────
 *   - A blocked word must be a WHOLE word, or a word that is never innocently
 *     embedded. Ordinary words and real names that merely CONTAIN one pass:
 *     Scunthorpe, Cassandra, assassin, Dickens, Dickson, Hancock, therapist,
 *     cockpit, shiitake, pussycat, Penistone, Essex, analyst, grape, raccoon,
 *     Ashkenazi, pedometer, Clitheroe, retardant, cumulative, document...
 *     Fukuoka, Cummings... (the full table is pinned in
 *     apps/api/src/auth/username-rules.spec.ts).
 *   - A name that IS the word is blocked even when it is also a real name or a
 *     harmless word in another sense (`Dick`, `Cock`, `Spic`): a public handle
 *     is read out of context, and "choose another" costs the person far less
 *     than the alternative costs everyone who sees it.
 *   - Ambiguous everyday words are NOT on the list (`hoe`, `homo`, `queer`,
 *     `thot`): reclaimed or common enough that blocking them hurts more people
 *     than it protects.
 *   - Rejections never say WHICH word matched (see the messages below), so the
 *     filter cannot be used as an oracle to map out the list.
 *
 * ── Username-change cooldown ────────────────────────────────────────────────
 * See USERNAME_CHANGE_COOLDOWN_MS. Only the constants and display helpers
 * live here; the check itself is one conditional UPDATE in the API
 * (AuthService.updateProfile), which is what makes it race-safe.
 */
import {
    DataSet,
    RegExpMatcher,
    englishDataset,
    englishRecommendedTransformers,
    parseRawPattern,
} from 'obscenity';

/** The ONE message every username rejection uses. Deliberately neutral: it
 *  never echoes the matched word. */
export const USERNAME_NOT_ALLOWED_MESSAGE = "That username isn't allowed. Please choose another.";
/** Same, for a per-server nickname. */
export const NICKNAME_NOT_ALLOWED_MESSAGE = "That nickname isn't allowed. Please choose another.";

type Meta = { originalWord: string };

/** Slurs / hate / sexual terms obscenity's English set does not cover (or, for
 *  `jizz`, covers with a pattern its own duplicate-collapsing can never reach).
 *  Boundary-anchored (`|x|`) wherever the bare letters occur inside innocent
 *  words (spice, raccoon, Ashkenazi, pedometer, Clitheroe). */
const EXTRA_PHRASES: Array<[string, string[]]> = [
    ['spic', ['|spic|', '|spics|']],
    ['wetback', ['wetback']],
    ['beaner', ['|beaner']],
    ['gook', ['|gook|', '|gooks|']],
    ['coon', ['|coon|', '|coons|']],
    ['raghead', ['raghead']],
    ['towelhead', ['towelhead']],
    ['sandnigger', ['sandnig']],
    ['nazi', ['|nazi']],
    ['hitler', ['hitler']],
    ['jizz', ['|jiz']],
    ['skank', ['skank']],
    ['clit', ['|clit|', '|clits|', 'clitoris']],
    ['pedo', ['|pedo|', '|pedos|', '|paedo|', '|paedos|', 'pedophil', 'paedophil']],
    ['molest', ['molest']],
    ['kys', ['|kys|']],
    ['porn', ['|pron|']],
    ['ballsack', ['ballsack', 'nutsack']],
];

/** Whole words that contain a blocked pattern but are not offensive. Applied
 *  as obscenity whitelist terms: a match lying entirely inside one of these
 *  is dropped. Additions here are the false-positive policy in action. */
const EXTRA_WHITELIST = [
    'cockpit', 'shiitake', 'pussycat', 'pussywillow', 'pussy willow',
    'dickson', 'dickinson', 'dickerson', 'dickey', 'penistone',
    'retardant', 'scunthorpe', 'clitheroe', 'ashkenazi', 'cocker spaniel',
    'hancock', 'cockatoo', 'cockatiel', 'peacock', 'shuttlecock', 'woodcock', 'gamecock',
    'fukuoka', 'fukushima', 'cummings',
];

/** The words checked against the FULLY JOINED form (separators removed). Long
 *  or distinctive enough that gluing two innocent halves together does not
 *  produce them by accident. Keyed by obscenity's `originalWord` metadata. */
const STRICT_WORDS = new Set([
    'nigger', 'fag', 'fuck', 'cunt', 'kike', 'chingchong', 'tranny', 'retard',
    'wetback', 'beaner', 'raghead', 'towelhead', 'sandnigger', 'hitler', 'pedo',
    'motherfucker', 'cocksucker', 'whore', 'bitch', 'dyke', 'twat',
]);

let cache: { dataset: DataSet<Meta>; matcher: RegExpMatcher } | null = null;

/** Built on first use: importing the shared package (as every client and the
 *  API do, for unrelated exports) must not pay for compiling the matcher. */
function engine() {
    if (cache) return cache;
    const dataset = new DataSet<Meta>().addAll(englishDataset);
    for (const [word, patterns] of EXTRA_PHRASES) {
        dataset.addPhrase((p) => {
            let phrase = p.setMetadata({ originalWord: word });
            for (const src of patterns) phrase = phrase.addPattern(parseRawPattern(src));
            return phrase;
        });
    }
    const built = dataset.build();
    const matcher = new RegExpMatcher({
        ...built,
        whitelistedTerms: [...(built.whitelistedTerms ?? []), ...EXTRA_WHITELIST],
        ...englishRecommendedTransformers,
    });
    cache = { dataset, matcher };
    return cache;
}

/** Invisible / zero-width / bidi-control / filler characters. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;
/** Characters that act as word breaks in a name. Leetspeak symbols that
 *  obscenity resolves (`@ $ ! | ( / 0-9`) are deliberately NOT here. */
const SEPARATORS = /[\s_\-.,~·•‧∙⋅]+/g;

function prepare(raw: string): string {
    return raw
        .normalize('NFKC')
        .replace(INVISIBLE, '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .normalize('NFC');
}

/** `f u c k` -> `fuck`: a run of 3+ single-character words is one word. */
function joinSpelledOut(spaced: string): string {
    const tokens = spaced.split(' ');
    const out: string[] = [];
    let run = '';
    let runLen = 0;
    const flush = () => {
        if (runLen >= 3) out.push(run);
        else if (runLen > 0) out.push(...run.split(''));
        run = '';
        runLen = 0;
    };
    for (const t of tokens) {
        if ([...t].length === 1) { run += t; runLen++; }
        else { flush(); out.push(t); }
    }
    flush();
    return out.join(' ');
}

/**
 * True when `name` may be used as a public name (username or nickname).
 * Pure and deterministic; safe on any string, including empty and hostile
 * input (it only ever reads it).
 */
export function isNameAllowed(name: string): boolean {
    if (typeof name !== 'string' || name.length === 0) return true;
    const { dataset, matcher } = engine();
    const base = prepare(name);
    const camel = base.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
    const spaced = camel.replace(SEPARATORS, ' ').trim();
    const loose = [base, spaced, joinSpelledOut(spaced)];
    for (const text of loose) {
        if (matcher.hasMatch(text)) return false;
    }
    const joined = base.replace(SEPARATORS, '');
    if (joined !== base) {
        for (const m of matcher.getAllMatches(joined)) {
            const word = dataset.getPayloadWithPhraseMetadata(m).phraseMetadata?.originalWord;
            if (word && STRICT_WORDS.has(word)) return false;
        }
    }
    return true;
}

// ── Username-change cooldown ─────────────────────────────────────────────────

/** At most one username change per this window. Enforced by the API. */
export const USERNAME_CHANGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * A brand-new account's name is still being CHOSEN for this long after the
 * account is created: changes in this window neither check nor start the
 * cooldown. Without it the onboarding profile step — which saves the name
 * every time typing pauses (and shipped desktop builds already do) — would
 * spend the one daily change on the second pause and 429 the third.
 */
export const USERNAME_FIRST_CHOICE_GRACE_MS = 60 * 60 * 1000;

/** `error` field of the API's 429 body for a username change in cooldown. */
export const USERNAME_COOLDOWN_ERROR = 'username_change_cooldown';

/** Milliseconds until a username change is allowed again (0 = now). Accepts
 *  the `next_username_change_at` value from /auth/me or the 429 body. */
export function usernameCooldownRemainingMs(
    nextChangeAt: string | Date | null | undefined,
    now: number = Date.now(),
): number {
    if (!nextChangeAt) return 0;
    const t = nextChangeAt instanceof Date ? nextChangeAt.getTime() : Date.parse(nextChangeAt);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, t - now);
}

/** `5 h`, `1 h`, `45 min`, `1 min` — rounded UP, so the hint never promises a
 *  change earlier than the server will accept it. */
export function formatCooldownRemaining(ms: number): string {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    if (minutes < 60) return `${minutes} min`;
    return `${Math.ceil(ms / 3_600_000)} h`;
}

/** The sentence both clients (and the 429 body) show. */
export function usernameCooldownMessage(ms: number): string {
    return `You can change your username again in ${formatCooldownRemaining(ms)}.`;
}
