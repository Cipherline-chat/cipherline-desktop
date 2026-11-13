/* The app-side wiring of renderVerify.ts: where the remembered fallback lives
   (secureLocalStore, install-local), the `dots_render` call event, and the CSS
   guard that keeps a canvas that should be showing from staying invisible. */
import secureLocalStore from '../../../utils/secureLocalStore';
import { logCallEvent } from '../../../utils/callEventLog';
import { APP_VERSION } from '../../../constants';
import { cssRepairs, readRememberedFallback, rememberFallback } from './renderVerify';
import type { DotsReason, RenderOutcome } from './renderVerify';

/** The reason an earlier launch of THIS version fell back, or null. */
export function rememberedDotsFallback(): DotsReason | null {
  return readRememberedFallback(secureLocalStore, APP_VERSION);
}

let lastPath = 'webgl';

/** `onRender` for createResilientDotField: one event per decision, and remember a bad WebGL for next launch. */
export function reportDotsRender(o: RenderOutcome): void {
  lastPath = o.path;
  if (import.meta.env.DEV) console.info('dots: dots_render', o.path, o.reason);
  logCallEvent('dots_render', { path: o.path, reason: o.reason });
  rememberFallback(secureLocalStore, APP_VERSION, o.reason);
}

/** After the opacity transition (.6 s), repair a canvas that should be on screen but is not. Returns a cancel. */
export function guardDotsVisible(canvas: HTMLCanvasElement, shouldShow: () => boolean, delayMs = 900): () => void {
  const id = window.setTimeout(() => {
    /* a twin canvas stands in for the original after a fallback (resilientField.ts) */
    const next = canvas.nextElementSibling;
    const el = canvas.style.display === 'none' && next instanceof HTMLCanvasElement ? next : canvas;
    const cs = window.getComputedStyle(el);
    const fix = cssRepairs(shouldShow(), { opacity: parseFloat(cs.opacity), visibility: cs.visibility });
    if (!fix) return;
    for (const [k, v] of Object.entries(fix)) el.style.setProperty(k, v);
    logCallEvent('dots_render', { path: lastPath, reason: 'css_opacity' });
  }, delayMs);
  return () => window.clearTimeout(id);
}

/** The dots are meant to be off again: lift any inline repair so the CSS fade-out works. */
export function clearDotsRepairs(canvas: HTMLCanvasElement): void {
  const next = canvas.nextElementSibling;
  for (const el of [canvas, next instanceof HTMLCanvasElement ? next : null]) {
    if (!el) continue;
    for (const k of ['opacity', 'transition', 'visibility']) el.style.removeProperty(k);
  }
}
