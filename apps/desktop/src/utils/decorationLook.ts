import { readItemOptions, type CosmeticOptions, type ItemOptions } from './profileCosmetics';
import { matchTint, readTheme } from './profileTheme';

/**
 * Everything an avatar decoration needs to look the way its owner set it up -
 * exactly what the profile card passes to <AvatarDecoration>:
 *
 *   decoration  the item id (null = none)
 *   tint        "Match theme": the colour hue-able items take when no hue is set
 *   options     the owner's per-item knobs (hue, glow, style...); a hue beats `tint`
 *
 * Spread the result onto the component: `<AvatarDecoration {...look} ...>`.
 * A call site that passes only `decoration` draws the stock colour for
 * everyone, which is the bug this module exists to prevent (a recoloured halo
 * showed teal in the rail, the Friends page and every list). The wiring test
 * in components/decorationLook.wiring.test.ts fails on any call site that
 * omits it.
 */
export interface DecorationLook {
    decoration: string | null;
    tint: string | null;
    options: ItemOptions | null;
}

/** The cosmetic fields as every payload carries them (own /auth/me, public profile, friends row). */
export interface CosmeticFields {
    avatar_decoration?: string | null;
    profile_theme?: { primary: string; accent: string } | null;
    cosmetic_options?: CosmeticOptions | null;
}

export const NO_DECORATION_LOOK: DecorationLook = Object.freeze({ decoration: null, tint: null, options: null });

/**
 * @param source   the payload row (own user, friends row, public profile); null = nobody
 * @param fallback used for the fields `source` does not carry AT ALL (undefined),
 *                 e.g. a friends row from an API that predates the theme /
 *                 options fields, completed from the session profile cache. A
 *                 field that is present (even null = "none set") is never
 *                 overridden: a friend who cleared their colour must not get
 *                 an older cached one back.
 */
export function decorationLook(source: CosmeticFields | null | undefined, fallback?: CosmeticFields | null): DecorationLook {
    if (!source && !fallback) return NO_DECORATION_LOOK;
    const pick = <K extends keyof CosmeticFields>(k: K): CosmeticFields[K] => (source && source[k] !== undefined ? source[k] : fallback?.[k]);
    const decoration = pick('avatar_decoration') ?? null;
    if (!decoration) return NO_DECORATION_LOOK;
    return {
        decoration,
        tint: matchTint(readTheme(pick('profile_theme'))),
        options: readItemOptions(pick('cosmetic_options')?.d, 'decoration', decoration),
    };
}
