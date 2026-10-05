/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ── Cipherline design system "glow in the deep" ──────────────────
        // Surfaces (dark → light)
        "cl-abyss":   "#0B0F1E",   // page background
        "cl-deep":    "#131A30",   // panels, cards, modals
        "cl-surface": "#1C2542",   // inputs, tracks, controls
        "cl-raise":   "#243056",   // hover fills, skeleton highlight
        "cl-border":  "#2A3558",   // hairline borders
        "cl-sink":    "#0A1120",   // sheets beneath controls

        // Lume — you & secure (primary)
        primary:       "#25E0C8",
        "cl-lume":     "#25E0C8",
        "cl-lume-hi":  "#3BEAD6",
        "cl-lume-press":"#12B79F",
        "cl-lume-deep": "#0E8F7C",
        "cl-on-lume":  "#06251F",

        // Flash — others & careful
        "cl-flash":       "#FF6B5E",
        "cl-flash-press": "#D14A3F",
        "cl-flash-deep":  "#B23A30",
        "cl-on-flash":    "#3A0E0A",

        // Status & warmth
        "cl-glow":   "#FFC94D",
        "cl-ok":     "#4ADE80",
        "cl-danger": "#FF5C7A",

        // Text
        "cl-text":  "#F4F7FF",
        "cl-muted": "#A7B3D4",
        "cl-faint": "#5E6B8F",

        // Legacy aliases (for classes still referencing old names)
        "page-bg":          "#0B0F1E",
        "panel-bg":         "#131A30",
        "surface-raised":   "#1C2542",
        "surface-elevated": "#243056",
        "bubble-recv":      "#1C2542",   // --cl-surface (others)
        // PORTING-PLAN Layer 1: the send bubble is now Lume aqua — its TEXT must
        // render dark (--cl-on-lume #06251F), handled at the bubble in ChatPane.
        "bubble-send":      "#25E0C8",   // --cl-lume (you)

        // Short reachable aliases (PORTING-PLAN handoff tailwind.config.js)
        flash:        "#FF6B5E",         // --cl-flash  (others & careful / danger)
        glow:         "#FFC94D",         // --cl-glow   (idle / warmth / "loud")
        online:       "#4ADE80",         // --cl-ok
        "text-body":  "#F4F7FF",         // --cl-text
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
    require('@tailwindcss/typography'),
    require('@tailwindcss/forms'),
    require('@tailwindcss/container-queries'),
  ],
}
