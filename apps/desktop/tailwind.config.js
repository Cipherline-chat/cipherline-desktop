import { DEFAULT_THEME_ID, TAILWIND_COLORS, THEMES, themeRgbVariables } from './src/theme/themes.ts';
import { tailwindPaletteBase, tailwindPaletteColors } from './src/theme/tailwindPalette.ts';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      // ── Cipherline design system "glow in the deep" ──────────────────
      // Every colour is a CSS variable from the theme data (src/theme/themes.ts,
      // TAILWIND_COLORS — the same class names as always, legacy aliases
      // included), so `bg-cl-deep`, `text-cl-muted/80`, `from-primary/20`
      // follow the active theme. `<alpha-value>` keeps opacity modifiers
      // working: `bg-cl-deep` -> rgb(var(--cl-deep-rgb) / 1) and
      // `bg-cl-deep/20` -> rgb(var(--cl-deep-rgb) / 0.2), the same computed
      // colours the literal hex compiled to (theme-engine worklog: compiled-CSS
      // comparison). The `--cl-*-rgb` channels come from the base layer below
      // (default theme) and are re-written by the engine (src/theme/engine.ts).
      colors: {
        // Tailwind's stock scale (red-400, gray-500 ...) follows the theme too:
        // Dark = Tailwind's own values, Light = a readable shade (src/theme/tailwindPalette.ts).
        ...tailwindPaletteColors(),
        ...Object.fromEntries(
          Object.entries(TAILWIND_COLORS).map(([name, token]) => [name, `rgb(var(--cl-${token}-rgb) / <alpha-value>)`]),
        ),
      },
      fontFamily: {
        sans:    ["Nunito", "system-ui", "sans-serif"],
        display: ["Fredoka", "system-ui", "sans-serif"],
        mono:    ["JetBrains Mono", "monospace"],
      },
      borderRadius: {
        DEFAULT: "14px",
        sm:  "11px",
        md:  "14px",
        lg:  "16px",
        xl:  "20px",
        "2xl": "20px",
        pill: "99px",
      },
      boxShadow: {
        "cl-menu":     "0 14px 34px rgba(0,0,0,.5)",
        "cl-glow-lume":"0 0 14px rgba(37,224,200,.22)",
        "cl-press":    "inset 0 3px 7px rgba(0,0,0,.45)",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(.34, 1.56, .64, 1)",
        slide:  "cubic-bezier(.3, 1.32, .45, 1)",
        enter:  "cubic-bezier(.3, 1.4, .4, 1)",
      },
    },
  },
  plugins: [
    // The default theme's `--cl-*-rgb` channel variables, so every Tailwind
    // colour class resolves before (and without) the engine's script: the
    // pre-script paint and the harness pages. The engine writes the same
    // values (and other themes' values) under :root[data-theme=...].
    function clThemeChannels({ addBase }) {
      addBase({ ':root': themeRgbVariables(THEMES[DEFAULT_THEME_ID]) });
      addBase(tailwindPaletteBase());
    },
    require('@tailwindcss/typography'),
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
  ],
}
