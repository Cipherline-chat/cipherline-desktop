/**
 * update-applying — the small "Applying update" popup shown for a beat right
 * before an already-downloaded update is handed to the installer.
 *
 * Why: the common launch-time update path (update-install.ts "startup" /
 * "reopen", plus the Settings "Restart to update" and "Restart to apply"
 * buttons) used to hide the window and call quitAndInstall one tick later, so
 * to the user the app simply opened and vanished. A tiny card now says what is
 * happening, up until the installer takes the app down. It does NOT delay the
 * install (owner 2026-11-19: no fake waits; it used to hold the hand-over for
 * 1.8 s): the install starts on the next tick either way. The bar and status
 * lines are cosmetic, paced over APPLYING_UPDATE_MS in case the hand-over is slow.
 *
 * Safety rules, enforced here (unit-tested in update-applying.test.ts):
 *   - never under the CI smoke test (the smoke harness must see the renderer paint);
 *   - if the window cannot be created, the install runs immediately, as before;
 *   - the install callback runs exactly once, on the next tick (never held back);
 *   - nothing is shown when there is no version to apply.
 *
 * The page is self-contained: no script, no network, no fonts from a CDN, no
 * preload. It is loaded by applying-update-window.ts as a data: URL.
 *
 * No `electron` import and no import from ../src (the rootDir trap): unit-testable.
 */

import {
    SPLASH_TOKENS_CSS, SPLASH_KEYFRAMES_CSS, SPLASH_CARD_CSS, SPLASH_MARK_CSS, SPLASH_FOOTER_CSS,
    SPLASH_HEADLINE_CSS, SPLASH_TITLEBAR_MARK_SVG, SPLASH_WORKING_MARK_HTML,
} from './splash-style';
import { bootPalette } from './theme-boot';

/** The card's animation pacing only. The install is never held back for it. */
export const APPLYING_UPDATE_MS = 1800;
/** The bar's fill animation; slightly shorter than the hold so it reads 100% before the quit. */
export const APPLYING_BAR_MS = 1500;

/**
 * The status line, in the installer's update wording (installer-splash.ts
 * `statusesJs`, isUpdate). CSS-only rotation (the page runs no script): each
 * line holds for APPLYING_STATUS_STEP_MS and the last one stays.
 */
export const APPLYING_STATUSES: readonly string[] = ['applying update…', 'swapping in the new build…', 'almost there…'];
export const APPLYING_STATUS_STEP_MS = Math.round(APPLYING_UPDATE_MS / APPLYING_STATUSES.length);

/** The card: the installer's card (440 wide), shortened to this popup's content. */
export const APPLYING_CARD_W = 440;
export const APPLYING_CARD_H = 310;
/**
 * Room around the floating card for its drop shadow (transparent window only).
 * The installer's shadow is `0 24px 60px`: it reaches 24 + 60 = 84px below the
 * card, so anything less clips it in a visible straight line.
 */
export const APPLYING_SHADOW_MARGIN = 88;
/** The card's colour (--cl-deep, theme-boot.ts). The opaque window paints it before the page does. */
export const APPLYING_CARD_BG = bootPalette().card;

const VERSION_RE = /[^0-9A-Za-z.+-]/g;

/** The version itself: allow-listed characters only, bounded (may be empty). */
function safeVersion(version: string | null | undefined): string {
    return String(version ?? '').replace(VERSION_RE, '').slice(0, 40);
}

/** The version as shown: allow-listed characters only, bounded, never empty text. */
export function applyingVersionLabel(version: string | null | undefined): string {
    const v = safeVersion(version);
    return v ? `Updating to ${v}` : 'Updating Cipherline';
}

export interface ApplyingUpdatePageOptions {
    /**
     * true: a transparent window; the card floats in it with the installer's
     * 20px radius and drop shadow, exactly like the installer splash.
     * false (default): an opaque window; the card fills it edge to edge, square,
     * keeping the installer's 1px border as its edge.
     */
    floating?: boolean;
}

export interface ApplyingUpdateWindowPlan {
    transparent: boolean;
    width: number;
    height: number;
    backgroundColor: string;
    page: ApplyingUpdatePageOptions;
}

/**
 * Per-OS window choice. The installer splash is a transparent window around a
 * floating rounded card; that look is reproduced only where a transparent window
 * is reliably composited:
 *   - Windows (DWM composition is always on since Windows 8) and macOS (always
 *     composited): transparent, the card floats with the installer's radius and
 *     shadow. These are the same window options the installer splash ships with.
 *   - Linux and anything else: OPAQUE, the card fills the window. On X11 with no
 *     compositing manager Chromium paints a "transparent" window black
 *     (annotation-overlay-target.ts), which would put black corners and a black
 *     shadow margin around the card; the only reliable compositor test is an
 *     async X11 probe, too slow for a 1.8 s popup. Opaque = square corners (or
 *     the desktop's own rounding under CSD), with the card's border as the edge.
 */
export function applyingUpdateWindowPlan(platform: string): ApplyingUpdateWindowPlan {
    if (platform === 'win32' || platform === 'darwin') {
        return {
            transparent: true,
            width: APPLYING_CARD_W + 2 * APPLYING_SHADOW_MARGIN,
            height: APPLYING_CARD_H + 2 * APPLYING_SHADOW_MARGIN,
            backgroundColor: '#00000000',
            page: { floating: true },
        };
    }
    return { transparent: false, width: APPLYING_CARD_W, height: APPLYING_CARD_H, backgroundColor: APPLYING_CARD_BG, page: { floating: false } };
}

/** CSS-only status rotation: line i fades in at i*step and (unless last) out at (i+1)*step. */
function statusCss(): string {
    const n = APPLYING_STATUSES.length;
    const step = APPLYING_STATUS_STEP_MS;
    return APPLYING_STATUSES.map((_, i) => {
        const anims: string[] = [];
        if (i > 0) anims.push(`st-in 160ms ease-out ${i * step}ms forwards`);
        if (i < n - 1) anims.push(`st-out 160ms ease-in ${(i + 1) * step}ms forwards`);
        return `  .st:nth-child(${i + 1}) { opacity: ${i === 0 ? 1 : 0}; animation: ${anims.join(', ')}; }`;
    }).join('\n');
}

/*
 * The look IS the installer splash (installer-splash.ts): its tokens, card,
 * title bar, working mark (pulse rings + bouncing tentacles), headline type,
 * mono status line with a blinking dot, percentage, and the sink-well bar all
 * come verbatim from splash-style.ts, which the installer uses too. This page
 * adds only what differs: the "Applying update" / "Updating to X" headline in
 * the stage, a CSS-timed bar + percentage + status rotation (no script), the
 * fill-the-window variant for an opaque window, and reduced motion.
 *
 * Fonts: NOT the installer's Google Fonts @import (this page fetches nothing).
 * The same family names come first, then platform fallbacks.
 */
export function applyingUpdateHtml(version: string | null | undefined, opts: ApplyingUpdatePageOptions = {}): string {
    const label = applyingVersionLabel(version);
    // The installer's title-bar label in update mode ("updating 0.1.1").
    const titleVer = `updating ${safeVersion(version)}`.trim();
    const mode = opts.floating ? 'float' : 'fill';
    const ease = 'cubic-bezier(.45,0,.25,1)';
    const statuses = APPLYING_STATUSES.map(s => `<span class="st">${s}</span>`).join('');
    return `<!DOCTYPE html>
<html lang="en" class="${mode}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Applying update</title>
<style>
${SPLASH_TOKENS_CSS}
  /* No color-scheme here, like the installer: a dark color-scheme can give the
     root canvas an opaque dark backdrop, which would fill the transparent window. */
  :root {
    --cl-font-display: 'Fredoka', 'Nunito', ui-rounded, 'SF Pro Rounded', 'Segoe UI Variable Display', 'Segoe UI', system-ui, Ubuntu, Cantarell, sans-serif;
    --cl-font-body: 'Nunito', ui-rounded, 'Segoe UI Variable Text', 'Segoe UI', system-ui, Ubuntu, Cantarell, sans-serif;
    --cl-font-mono: 'JetBrains Mono', ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: transparent; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: var(--cl-font-body);
    overflow: hidden; user-select: none; cursor: default;
  }

${SPLASH_KEYFRAMES_CSS}
  @keyframes st-in  { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @keyframes st-out { from { opacity: 1; } to { opacity: 0; transform: translateY(-3px); } }
  @keyframes fill   { from { width: 0%; } to { width: 100%; } }
  @property --p { syntax: '<integer>'; inherits: false; initial-value: 0; }
  @keyframes pct    { from { --p: 0; } to { --p: 100; } }

${SPLASH_CARD_CSS}
${SPLASH_MARK_CSS}
${SPLASH_FOOTER_CSS}
${SPLASH_HEADLINE_CSS}

  .card { height: ${APPLYING_CARD_H}px; }
  .titlebar { -webkit-app-region: no-drag; }
  /* Opaque window: the card IS the window. Square; its 1px border is the edge. */
  html.fill .card { width: 100%; height: 100%; border-radius: 0; box-shadow: none; }

  .stage {
    flex: 1; min-height: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; padding: 6px 28px 2px;
  }
  /* The delayed ring must not sit, unanimated and off-centre, before its delay. */
  .pulse-ring { opacity: 0; }

  .statustext { display: grid; }
  .st { grid-area: 1 / 1; white-space: nowrap; }
${statusCss()}
  .pct::after { counter-reset: p var(--p); content: counter(p) '%'; animation: pct ${APPLYING_BAR_MS}ms ${ease} forwards; }
  .bar-fill { animation: fill ${APPLYING_BAR_MS}ms ${ease} forwards; }

  @media (prefers-reduced-motion: reduce) {
    .pulse-ring, .statusdot, .headline, .st, .pct::after, .bar-fill, .mark-wrap rect { animation: none !important; }
    .bar-fill { width: 100%; }
    .pct::after { --p: 100; }
  }
</style>
</head>
<body>
  <div class="card" role="status" aria-live="polite">
    <div class="titlebar">
${SPLASH_TITLEBAR_MARK_SVG}
      <span class="brand">cipherline</span>
      <span class="spacer"></span>
      <span class="ver">${titleVer}</span>
    </div>

    <div class="stage">
${SPLASH_WORKING_MARK_HTML}
      <div class="headline">
        <div class="big">Applying update</div>
        <div class="sub">${label}</div>
      </div>
    </div>

    <div class="footer">
      <div class="statusline">
        <span class="statusdot"></span>
        <span class="statustext">${statuses}</span>
        <span class="spacer"></span>
        <span class="pct"></span>
      </div>
      <div class="bar"><div class="bar-fill"></div></div>
    </div>
  </div>
</body>
</html>`;
}

export interface ApplyingUpdateDeps {
    /** CI smoke test: never show anything. */
    smokeTest: boolean;
    /** Create + show the popup. Returns its closer, or null / throws when it cannot be made. */
    open(version: string): (() => void) | null;
    /** Run `fn` after `ms` (0 = next tick). */
    setTimer(fn: () => void, ms: number): void;
    log?(line: string): void;
}

export class ApplyingUpdatePopup {
    private closer: (() => void) | null = null;

    constructor(private readonly d: ApplyingUpdateDeps) {}

    get visible(): boolean { return this.closer !== null; }

    /** Show the popup for `version`. false = nothing shown (smoke test, no version, or the window failed). */
    show(version: string | null | undefined): boolean {
        if (this.closer) return true;
        if (this.d.smokeTest || !version) return false;
        try {
            this.closer = this.d.open(version) ?? null;
        } catch (e) {
            this.closer = null;
            this.d.log?.(`[Main/Updater] applying-update popup unavailable: ${(e as Error)?.message || e}`);
        }
        return this.closer !== null;
    }

    /**
     * Run the install on the next tick, popup or not: the card is there to say
     * what is happening, never to make the user wait. `run` is called exactly once.
     */
    install(run: () => void): void {
        let ran = false;
        const once = () => { if (ran) return; ran = true; run(); };
        this.d.setTimer(once, 0);
    }

    /** The install failed / was cancelled: take the popup down. */
    dismiss(): void {
        const c = this.closer;
        this.closer = null;
        if (!c) return;
        try { c(); } catch { /* already gone */ }
    }
}
