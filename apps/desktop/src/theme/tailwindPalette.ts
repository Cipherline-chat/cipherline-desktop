/**
 * Tailwind's stock colour scale (`text-red-400`, `bg-amber-300/10`,
 * `text-gray-500` …) made theme-aware, for tailwind.config.js only.
 *
 * Every shade compiles to `rgb(var(--cl-tw-<hue>-<shade>) / <alpha-value>)`.
 * The base layer sets those channels to Tailwind's own values on `:root`
 * (so Dark computes exactly what the literal classes did) and to a
 * readable-on-cream shade under `:root[data-scheme="light"]`:
 *   - chromatic hues (red, amber, green …) used as text or a tint in the dark
 *     UI are 300-500; in Light they become 700 (≥ 4.5:1 on white / cream);
 *   - neutral hues (gray, slate …) mirror the scale (400 <-> 600, 900 <-> 100),
 *     so a grey label stays a mid grey and a dark grey fill becomes a light one.
 *
 * Not imported by the app (it pulls in tailwindcss/colors); the engine never
 * touches these — Light's values are static CSS.
 */
import twColors from 'tailwindcss/colors';

export const TW_SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;
export const TW_CHROMATIC = ['red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'] as const;
export const TW_NEUTRAL = ['slate', 'gray', 'zinc', 'neutral', 'stone'] as const;
type Shade = (typeof TW_SHADES)[number];

/** The shade Light shows for a shade the (dark-designed) markup asks for. */
export function lightShade(hue: string, shade: Shade): Shade {
    const i = TW_SHADES.indexOf(shade);
    if ((TW_NEUTRAL as readonly string[]).includes(hue)) return TW_SHADES[TW_SHADES.length - 1 - i];
    if (i <= 2) return '800';
    if (i <= 6) return '700';
    return shade;
}

function channels(hex: string): string {
    const n = parseInt(hex.replace('#', ''), 16);
    return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

const scale = (hue: string): Record<Shade, string> => (twColors as unknown as Record<string, Record<Shade, string>>)[hue];

/** `colors` entries for tailwind.config.js (no hex: every value is a variable). */
export function tailwindPaletteColors(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const hue of [...TW_CHROMATIC, ...TW_NEUTRAL]) {
        out[hue] = Object.fromEntries(TW_SHADES.map((s) => [s, `rgb(var(--cl-tw-${hue}-${s}) / <alpha-value>)`]));
    }
    return out;
}

/** The base-layer rules: Dark (Tailwind's own values) on :root, Light's on :root[data-scheme="light"]. */
export function tailwindPaletteBase(): Record<string, Record<string, string>> {
    const dark: Record<string, string> = {};
    const light: Record<string, string> = {};
    for (const hue of [...TW_CHROMATIC, ...TW_NEUTRAL]) {
        const sc = scale(hue);
        for (const s of TW_SHADES) {
            dark[`--cl-tw-${hue}-${s}`] = channels(sc[s]);
            light[`--cl-tw-${hue}-${s}`] = channels(sc[lightShade(hue, s)]);
        }
    }
    return { ':root': dark, ':root[data-scheme="light"]': light };
}
