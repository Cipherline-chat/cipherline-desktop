/**
 * The theme preview safety bar's pure parts (ThemePreviewBar.tsx): its fixed,
 * theme-independent styling (hard-coded colours and px sizes ON PURPOSE: the bar
 * must stay readable whatever a theme does, so it never uses a theme token), the
 * countdown / announcement text and the placement maths.
 */

/** The host element's tag: a custom element name no app stylesheet targets. */
export const PREVIEW_BAR_HOST_TAG = 'cl-theme-preview-bar';

/** Fixed colours, independent of every theme (the point of the bar). */
export const BAR_COLORS = {
    paper: '#ffffff',
    ink: '#000000',
    inkHover: '#333333',
    paperHover: '#e8e8e8',
    focus: '#0047ff',
    error: '#b00000',
} as const;

const FONT = 'system-ui, "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif';

/** The host's box, locked inline with !important (beats any stylesheet rule that could match the host). */
export const HOST_LOCK: ReadonlyArray<readonly [string, string]> = [
    ['all', 'initial'],
    ['display', 'block'],
    ['position', 'fixed'],
    ['left', '0'],
    ['top', '0'],
    ['width', '0'],
    ['height', '0'],
    ['overflow', 'visible'],
    ['z-index', '2147483647'],
    ['isolation', 'isolate'],
    ['opacity', '1'],
    ['visibility', 'visible'],
    ['transform', 'none'],
    ['filter', 'none'],
    ['contain', 'none'],
    ['pointer-events', 'none'],
];

const C = BAR_COLORS;
/**
 * The shadow root's only stylesheet: px sizes, hex colours, no var().
 * The host lock is repeated in `:host` with !important: for important
 * declarations the cascade lets the shadow tree's own rules win over the outer
 * document's (inline style included), so this is the strongest place a style
 * can come from. (`all: initial` alone there would also reset the inline lock,
 * so every locked property is spelled out after it.)
 */
export const BAR_CSS = `
:host { ${HOST_LOCK.map(([k, v]) => `${k}: ${v} !important;`).join(' ')} }
.bar {
  all: initial;
  box-sizing: border-box;
  position: fixed;
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px;
  background: ${C.paper}; color: ${C.ink};
  border: 2px solid ${C.ink}; border-radius: 12px;
  box-shadow: 0 0 0 3px ${C.paper}, 0 8px 28px ${C.ink};
  font-family: ${FONT}; font-size: 14px; font-weight: 500; line-height: 1.35;
  font-style: normal; letter-spacing: normal; word-spacing: normal; text-transform: none; text-align: left;
  direction: ltr; writing-mode: horizontal-tb; color-scheme: light;
  opacity: 1; visibility: visible; pointer-events: auto; cursor: default; user-select: none;
  -webkit-app-region: no-drag;
}
.bar * { box-sizing: border-box; margin: 0; font-family: ${FONT}; color: inherit; }
.bar:focus { outline: none; }
.title { display: block; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count { display: block; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: 8px; }
button {
  all: initial;
  box-sizing: border-box;
  flex: 1 1 0; min-width: 0; min-height: 34px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 6px 12px; border-radius: 8px; border: 2px solid ${C.ink};
  font-family: ${FONT}; font-size: 14px; font-weight: 700; line-height: 1.2; text-align: center;
  cursor: pointer; pointer-events: auto; opacity: 1; visibility: visible;
  -webkit-app-region: no-drag;
}
.keep { background: ${C.ink}; color: ${C.paper}; }
.keep:hover { background: ${C.inkHover}; }
.revert { background: ${C.paper}; color: ${C.ink}; }
.revert:hover { background: ${C.paperHover}; }
button:focus-visible { outline: 3px solid ${C.focus}; outline-offset: 2px; }
.note { display: block; font-size: 12.5px; font-weight: 700; color: ${C.error}; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
`;

/** Whole seconds left on the countdown (never negative). */
export const secondsLeft = (revertAt: number, now: number): number => Math.max(0, Math.ceil((revertAt - now) / 1000));

/** The bar's countdown line. */
export const countdownText = (secs: number): string => `Reverting in ${secs}s`;

/** What a screen reader hears when a preview starts. */
export const startAnnouncement = (name: string, secs: number): string =>
    `Previewing theme ${name}. Your theme comes back in ${secs} seconds unless you press Keep. Press Escape to revert now.`;

/** Seconds-left marks announced to a screen reader. */
export const ANNOUNCE_AT = new Set([10, 5]);

export interface BarPlacement { left: number; bottom: number; width: number }

/**
 * Where the bar goes. Settings open (its nav, `.sd-gauge`, on screen): inside
 * the bottom of the nav column, so it never covers the theme picker in the
 * content area. Elsewhere: bottom-left, clear of the server rail, 16px above
 * the message box / call dock when one is on screen.
 */
export function computeBarPlacement(
    vw: number,
    vh: number,
    gauge: { left: number; right: number; bottom: number; width: number } | null,
    obstacles: ReadonlyArray<{ top: number; bottom: number; width: number; height: number }>,
): BarPlacement {
    // Whatever is measured, the bar never leaves the window (it is ~120px tall).
    const onScreen = (p: BarPlacement): BarPlacement => ({
        width: p.width,
        left: Math.max(8, Math.min(p.left, vw - p.width - 8)),
        bottom: Math.max(12, Math.min(p.bottom, vh - 160)),
    });
    if (gauge && gauge.width >= 200) {
        const width = Math.round(gauge.width - 24);
        return onScreen({ left: Math.round(gauge.left + 12), bottom: Math.round(vh - Math.min(vh, gauge.bottom)) + 12, width });
    }
    const width = Math.max(220, Math.min(340, vw - 32));
    const left = vw - 90 - 16 >= width ? 90 : 16;
    let bottom = 24;
    for (const r of obstacles) {
        if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.top >= vh) continue;
        bottom = Math.max(bottom, Math.round(vh - r.top) + 16);
    }
    return onScreen({ left, bottom, width });
}

