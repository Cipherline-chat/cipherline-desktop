/**
 * splash-style — the visual language shared by the two pre-app splash pages:
 * the installer splash (installer-splash.ts) and the "Applying update" popup
 * (update-applying.ts). Both pages interpolate these strings verbatim, so the
 * two cannot drift apart.
 *
 * Moved here byte for byte from installer-splash.ts: installerSplashHtml()'s
 * output is unchanged (update-applying.test.ts pins its sha256). Each constant
 * keeps the indentation it had in the installer page.
 *
 * Plain strings only: no fonts, no URLs, no script. The installer adds its own
 * Google Fonts @import; the update popup must never fetch anything.
 *
 * No `electron` import and no import from ../src (the rootDir trap).
 */
import { bootPalette } from './theme-boot';

/** The default theme's colours (theme-boot.ts, pinned to src/theme/themes.ts). */
const P = bootPalette();

/** The :root design tokens (theme data values, inlined; layout byte-identical to before). */
export const SPLASH_TOKENS_CSS = `  :root {
    --cl-abyss:   ${P.abyss};
    --cl-deep:    ${P.deep};
    --cl-surface: ${P.surface};
    --cl-border:  ${P.border};
    --cl-sink:    ${P.sink};
    --cl-lume:        ${P.lume};
    --cl-lume-hi:     ${P.lumeHi};
    --cl-lume-deep:   ${P.lumeDeep};
    --cl-glow:    ${P.glow};
    --cl-ok:      ${P.ok};
    --cl-text:  ${P.text};
    --cl-muted: ${P.muted};
    --cl-faint: ${P.faint};
    --cl-font-display: 'Fredoka', system-ui, sans-serif;
    --cl-font-body:    'Nunito', system-ui, sans-serif;
    --cl-font-mono:    'JetBrains Mono', ui-monospace, monospace;
    --cl-spring: cubic-bezier(.34, 1.56, .64, 1);
  }`;

/** Every keyframe either splash uses. */
export const SPLASH_KEYFRAMES_CSS = `  @keyframes cl-blink { 0%,100%{opacity:.22} 50%{opacity:1} }
  @keyframes cl-bars  { 0%{transform:scaleY(.34)} 100%{transform:scaleY(1)} }
  @keyframes cl-ring  { 0%{transform:translate(-50%,-50%) scale(.5);opacity:.55} 75%{opacity:0} 100%{transform:translate(-50%,-50%) scale(2.2);opacity:0} }
  @keyframes cl-tape  { from{transform:translateY(0)} to{transform:translateY(-50%)} }
  @keyframes cl-pop   { 0%{transform:scale(.62)} 55%{transform:scale(1.1)} 100%{transform:scale(1)} }
  @keyframes cl-breathe { 0%,100%{transform:scale(1)} 50%{transform:scale(1.035)} }
  @keyframes cl-halo  { 0%,100%{opacity:.42;transform:translate(-50%,-50%) scale(1)} 50%{opacity:.72;transform:translate(-50%,-50%) scale(1.14)} }
  @keyframes cl-ringdone { 0%{transform:translate(-50%,-50%) scale(.45);opacity:.6} 80%{opacity:0} 100%{transform:translate(-50%,-50%) scale(2.5);opacity:0} }
  @keyframes cl-confetti { 0%{transform:translate(0,0) scale(0) rotate(0deg);opacity:0} 14%{opacity:1} 72%{opacity:1} 100%{transform:translate(var(--dx),var(--dy)) scale(1) rotate(var(--r));opacity:0} }
  @keyframes cl-glowpulse { 0%,100%{box-shadow:0 0 16px rgba(37,224,200,.30)} 50%{box-shadow:0 0 26px rgba(37,224,200,.55)} }
  @keyframes cl-rise  { 0%{transform:translateY(9px);opacity:0} 100%{transform:translateY(0);opacity:1} }
  @keyframes cl-fadein { 0%{opacity:0} 100%{opacity:1} }`;

/** The card and its title bar (brand + version). */
export const SPLASH_CARD_CSS = `  .card {
    position: relative;
    width: 440px;
    background: var(--cl-deep);
    border: 1px solid var(--cl-border);
    border-radius: 20px;
    box-shadow: 0 24px 60px rgba(0,0,0,.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* the title bar drags the whole window */
  .titlebar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--cl-border);
    -webkit-app-region: drag;
  }
  .titlebar .brand {
    font-family: var(--cl-font-display);
    font-weight: 500;
    font-size: 16px;
    color: var(--cl-text);
  }
  .titlebar .ver {
    font-family: var(--cl-font-mono);
    font-size: 11px;
    color: var(--cl-faint);
  }`;

/** The working mark's stage and its pulse rings. */
export const SPLASH_MARK_CSS = `  .mark-wrap { position: relative; width: 84px; height: 70px; display: flex; align-items: center; justify-content: center; }
  .pulse-ring { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; border-radius: 50%; border: 1.5px solid var(--cl-lume); animation: cl-ring 2.6s ease-out infinite; }`;

/** The footer: status line (dot, mono status text, percentage) and the progress bar. */
export const SPLASH_FOOTER_CSS = `  .footer { padding: 0 24px 22px; display: flex; flex-direction: column; gap: 13px; }
  .statusline { display: flex; align-items: center; gap: 8px; min-height: 18px; }
  .statusdot { width: 7px; height: 7px; border-radius: 99px; background: var(--cl-lume); box-shadow: 0 0 8px var(--cl-lume); flex: none; animation: cl-blink 1.4s ease-in-out infinite; }
  .statustext { font-family: var(--cl-font-mono); font-size: 13px; color: var(--cl-muted); letter-spacing: .2px; }
  .spacer { flex: 1; }
  .pct { font-family: var(--cl-font-mono); font-size: 12px; color: var(--cl-faint); }

  .bar { position: relative; height: 8px; border-radius: 99px; background: var(--cl-sink); border: 1px solid var(--cl-border); overflow: hidden; }
  .bar-fill {
    height: 100%; width: 0%; border-radius: 99px;
    background: linear-gradient(90deg, var(--cl-lume-deep), var(--cl-lume));
    box-shadow: 0 0 12px rgba(37,224,200,.5);
    transition: width .22s ease-out;
  }`;

/** The big Fredoka headline and its muted sub line. */
export const SPLASH_HEADLINE_CSS = `  .headline { display: flex; flex-direction: column; align-items: center; gap: 5px; animation: cl-rise 460ms var(--cl-spring) both; animation-delay: 200ms; }
  .headline .big { font-family: var(--cl-font-display); font-weight: 600; font-size: 27px; color: var(--cl-text); letter-spacing: -.5px; white-space: nowrap; }
  .headline .sub { font-size: 13.5px; color: var(--cl-muted); white-space: nowrap; }`;

/** The small mark in the title bar. */
export const SPLASH_TITLEBAR_MARK_SVG = `      <svg width="20" height="17" viewBox="0 0 110 90"><rect x="22.5" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><rect x="39.8" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><rect x="57.1" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><rect x="74.4" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"></rect><path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8"></path></svg>`;

/** The working mark: two pulse rings behind Keys with the bouncing tentacle bars. */
export const SPLASH_WORKING_MARK_HTML = `        <div class="mark-wrap">
          <div class="pulse-ring"></div>
          <div class="pulse-ring" style="animation-delay:1.3s;"></div>
          <svg width="70" height="58" viewBox="0 0 110 90" style="position:relative; z-index:2; filter:drop-shadow(0 0 10px rgba(37,224,200,.6));">
            <rect x="22.5" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:0ms;"></rect>
            <rect x="39.8" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:130ms;"></rect>
            <rect x="57.1" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:260ms;"></rect>
            <rect x="74.4" y="44" width="13" height="34" rx="6.5" fill="#25E0C8" style="transform-box:fill-box; transform-origin:center bottom; animation:cl-bars 760ms var(--cl-spring) infinite alternate; animation-delay:390ms;"></rect>
            <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8"></path>
            <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path>
            <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"></path>
          </svg>
        </div>`;
