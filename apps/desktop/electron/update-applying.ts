/**
 * update-applying — the small "Applying update" popup shown for a beat right
 * before an already-downloaded update is handed to the installer.
 *
 * Why: the common launch-time update path (update-install.ts "startup" /
 * "reopen", plus the Settings "Restart to update" and "Restart to apply"
 * buttons) used to hide the window and call quitAndInstall one tick later, so
 * to the user the app simply opened and vanished. This holds the hand-over for
 * APPLYING_UPDATE_MS while a tiny card says what is happening. The bar is
 * cosmetic: the real install starts when the hold ends.
 *
 * Safety rules, enforced here (unit-tested in update-applying.test.ts):
 *   - never under the CI smoke test (the smoke harness must see the renderer paint);
 *   - if the window cannot be created, the install runs immediately, as before;
 *   - the install callback runs exactly once, and never later than the hold;
 *   - nothing is shown when there is no version to apply.
 *
 * The page is self-contained: no script, no network, no fonts from a CDN, no
 * preload. It is loaded by applying-update-window.ts as a data: URL.
 *
 * No `electron` import and no import from ../src (the rootDir trap): unit-testable.
 */

/** How long the install is held back while the popup is up. */
export const APPLYING_UPDATE_MS = 1800;
/** The bar's fill animation; slightly shorter than the hold so it reads 100% before the quit. */
export const APPLYING_BAR_MS = 1500;

const VERSION_RE = /[^0-9A-Za-z.+-]/g;

/** The version as shown: allow-listed characters only, bounded, never empty text. */
export function applyingVersionLabel(version: string | null | undefined): string {
    const v = String(version ?? '').replace(VERSION_RE, '').slice(0, 40);
    return v ? `Updating to ${v}` : 'Updating Cipherline';
}

export function applyingUpdateHtml(version: string | null | undefined): string {
    const label = applyingVersionLabel(version);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>Applying update</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; background: #0B0F1E; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: 'Nunito', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    color: #F4F7FF; overflow: hidden; user-select: none; cursor: default;
  }
  .card {
    position: relative; width: 100%; height: 100%;
    background: radial-gradient(120% 90% at 50% 0%, #1C2542 0%, #131A30 55%, #0B0F1E 100%);
    border: 1px solid #2A3558; border-radius: 16px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    padding: 0 36px; overflow: hidden;
  }
  .halo {
    position: absolute; top: 18px; left: 50%; width: 120px; height: 120px; margin-left: -60px;
    background: radial-gradient(circle, rgba(37,224,200,.28) 0%, rgba(37,224,200,0) 68%);
    animation: halo 2.2s ease-in-out infinite;
  }
  .mark { position: relative; width: 64px; height: 53px; filter: drop-shadow(0 0 10px rgba(37,224,200,.6)); animation: bob 1.4s ease-in-out infinite; }
  .title { position: relative; margin-top: 10px; font-family: 'Fredoka', 'Nunito', system-ui, sans-serif; font-weight: 600; font-size: 20px; letter-spacing: .2px; }
  .sub { position: relative; font-size: 13px; font-weight: 600; color: #A7B3D4; }
  .track { position: relative; width: 100%; height: 6px; margin-top: 14px; border-radius: 999px; background: #1C2542; border: 1px solid #2A3558; overflow: hidden; }
  .fill {
    height: 100%; width: 100%; border-radius: 999px; transform-origin: left center;
    background: linear-gradient(90deg, #0E8F7C, #25E0C8 70%, #3BEAD6);
    box-shadow: 0 0 12px rgba(37,224,200,.55);
    animation: fill ${APPLYING_BAR_MS}ms ease-in-out forwards;
  }
  @keyframes fill { 0% { transform: scaleX(0); } 100% { transform: scaleX(1); } }
  @keyframes bob  { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
  @keyframes halo { 0%,100% { opacity: .55; transform: scale(1); } 50% { opacity: 1; transform: scale(1.12); } }
  @media (prefers-reduced-motion: reduce) {
    .mark, .halo { animation: none; }
    .fill { animation: none; transform: none; }
  }
</style>
</head>
<body>
  <div class="card" role="status" aria-live="polite">
    <div class="halo"></div>
    <svg class="mark" viewBox="0 0 110 90" aria-hidden="true">
      <rect x="22.5" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"/>
      <rect x="39.8" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"/>
      <rect x="57.1" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"/>
      <rect x="74.4" y="44" width="13" height="34" rx="6.5" fill="#25E0C8"/>
      <path d="M21 48 A34 34 0 0 1 89 48 L89 53 L21 53 Z" fill="#25E0C8"/>
      <path d="M33.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M61.5 40 l3.75 -5 l3.75 5 l3.75 -5 l3.75 5" fill="none" stroke="#0B0F1E" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <div class="title">Applying update</div>
    <div class="sub">${label}</div>
    <div class="track"><div class="fill"></div></div>
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
     * Run the install: after the hold when the popup is up, on the next tick
     * when it is not (today's behaviour). `run` is called exactly once.
     */
    install(run: () => void): void {
        let ran = false;
        const once = () => { if (ran) return; ran = true; run(); };
        this.d.setTimer(once, this.closer ? APPLYING_UPDATE_MS : 0);
    }

    /** The install failed / was cancelled: take the popup down. */
    dismiss(): void {
        const c = this.closer;
        this.closer = null;
        if (!c) return;
        try { c(); } catch { /* already gone */ }
    }
}
