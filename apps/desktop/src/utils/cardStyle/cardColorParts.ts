/**
 * Split / join a card colour for the editor's colour field: a base (a theme
 * token, or `#rrggbb`) and an alpha 0..100. Joining always goes back through
 * the shared parser, so the editor can only ever produce a valid CardColor.
 */
import { cardColorRgba, cardThemeColorParts, parseCardColor, type CardColor, type CardThemeToken } from '@cipherline/shared';
import { DESKTOP_CARD_THEME } from './cardStyleReact';

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

/** Split a colour into its base (token or #rrggbb) and alpha 0..100. */
export function splitCardColor(c: CardColor | null | undefined): { token: CardThemeToken | null; hex: string; alpha: number } {
    const t = c ? cardThemeColorParts(c) : null;
    if (t) return { token: t.token, hex: DESKTOP_CARD_THEME.tokens[t.token], alpha: Math.round(t.alpha * 100) };
    const rgba = c ? cardColorRgba(c) : null;
    if (!rgba) return { token: null, hex: '#25e0c8', alpha: 100 };
    return { token: null, hex: `#${hex2(rgba[0])}${hex2(rgba[1])}${hex2(rgba[2])}`, alpha: Math.round(rgba[3] * 100) };
}

/** Join a base and alpha back into a normalised colour. */
export function joinCardColor(token: CardThemeToken | null, hex: string, alpha: number): CardColor {
    const a = Math.max(0, Math.min(100, Math.round(alpha)));
    if (token) return a >= 100 ? `theme(${token})` : `theme(${token} / ${a}%)`;
    return parseCardColor(`${hex.slice(0, 7)}${a >= 100 ? '' : hex2((a / 100) * 255)}`) ?? '#25e0c8';
}
