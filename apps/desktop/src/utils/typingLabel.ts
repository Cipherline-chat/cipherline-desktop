/**
 * The "who is typing" line above the composer. Structural only: it is handed
 * display names and counts, never anything anyone has written.
 *
 *   1 name          "Ada is typing…"
 *   2 names         "Ada and Bo are typing…"
 *   3 names         "Ada, Bo, and Cy are typing…"
 *   4 to 7          "Several people are typing…"
 *   8 or more       "Everyone is typing. Brace yourself."
 *   everyone        the same, when 4 or more are typing and that is every other
 *                   member of a small channel (`othersCount`): a room of five
 *                   with four of them typing really is everyone.
 */

/** This many typing at once, or more, is "everyone" whatever the room size. */
export const EVERYONE_TYPING_AT = 8;
/** Four and over stop being listed by name. */
export const SEVERAL_TYPING_AT = 4;

export const TYPING_SEVERAL = 'Several people are typing…';
export const TYPING_EVERYONE = 'Everyone is typing. Brace yourself.';

/**
 * @param names       display names of the people typing, in order
 * @param othersCount how many OTHER members the conversation has, when known
 *                    (viewer excluded); omit when it is not known cheaply
 */
export function typingLabel(names: readonly string[], othersCount?: number): string {
    const n = names.length;
    if (n === 0) return '';
    const everyone = n >= EVERYONE_TYPING_AT
        || (n >= SEVERAL_TYPING_AT && othersCount !== undefined && othersCount > 0 && n >= othersCount);
    if (everyone) return TYPING_EVERYONE;
    if (n >= SEVERAL_TYPING_AT) return TYPING_SEVERAL;
    if (n === 3) return `${names[0]}, ${names[1]}, and ${names[2]} are typing…`;
    if (n === 2) return `${names[0]} and ${names[1]} are typing…`;
    return `${names[0]} is typing…`;
}
