/**
 * Cipherline design-system physics — ported VERBATIM from the brand guide
 * (Designsystem/cipherline-brand-guide-final.html <script>). Targets the
 * guide's exact class names (.cap/.bloom/.ico/.dn/.dis) which now live in
 * cl-kit.css. Imported once as a side effect from main.tsx.
 */

const reduced = typeof window !== 'undefined'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ── spring: bake the real k=250 c=13 spring into linear() (guide springStr) ── */
function springStr(k: number, c: number): { lin: string; dur: number } {
  const w0 = Math.sqrt(k);
  const z = c / (2 * Math.sqrt(k));
  const wd = w0 * Math.sqrt(1 - z * z);
  const x = (t: number) =>
    1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  let T = 0.2;
  while (T < 4) {
    let ok = true;
    for (let q = 0; q < 6; q++) {
      if (Math.abs(1 - x(T + q * 0.016)) > 0.001) { ok = false; break; }
    }
    if (ok) break;
    T += 0.05;
  }
  const v: number[] = [];
  for (let i = 0; i <= 70; i++) v.push(Math.round(x((T * i) / 70) * 1000) / 1000);
  v[70] = 1;
  return { lin: `linear(${v.join(',')})`, dur: Math.round(T * 1000) };
}

if (typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', 'linear(0, 1)')) {
  const { lin, dur } = springStr(250, 13);
  const ds = document.documentElement.style;
  // guide var names (used by cl-kit.css) …
  ds.setProperty('--spr', lin);
  ds.setProperty('--dur', `${dur}ms`);
  // … and the app's own aliases (used by index.css), kept in sync.
  ds.setProperty('--cl-spring', lin);
  ds.setProperty('--cl-spring-dur', `${dur}ms`);
}

/* ── icon animation orchestration (guide playIco verbatim) ── */
const ICO_PLAYS = ['play-send', 'play-leave', 'play-trash', 'play-star', 'play-mute', 'play-unmute', 'play-dizzy', 'play-crash', 'play-scared'];
const ICO_PAYOFFS = new Set(['play-crash', 'play-dizzy', 'play-scared']);
let icoTok = 0;

export function playIco(ico: SVGSVGElement | HTMLElement | null, cls: string, force = false): void {
  if (!ico || reduced) return;
  const el = ico as HTMLElement & { _busy?: string; _playing?: string; _tok?: number; _fb?: ReturnType<typeof setTimeout> };
  if (el._busy) {
    if (!force) return;
    if (el._playing && ICO_PAYOFFS.has(el._playing)) return;
  }
  clearTimeout(el._fb);
  ICO_PLAYS.forEach(c => el.classList.remove(c));
  void el.getBoundingClientRect();
  el._busy = '1'; el._playing = cls;
  el.classList.add(cls);
  const tok = ++icoTok; el._tok = tok;
  const done = () => {
    if (el._tok !== tok) return;
    clearTimeout(el._fb);
    el.classList.remove(cls);
    el._fb = setTimeout(() => { if (el._tok === tok) { delete el._busy; delete el._playing; } }, 180);
  };
  el.addEventListener('animationend', (e) => { if (e.target === el) done(); }, { once: true });
  el._fb = setTimeout(done, 1400);
}

/**
 * Wire the guide's button physics onto a `.clb` wrapper: cursor glowspot,
 * seat-and-bulge press (`dn`), crush-and-bloom on release, and the
 * meaning-matched icon animation (`data-anim`). Returns a cleanup fn.
 */
export function wireClButton(wrapper: HTMLElement): () => void {
  // Dual-mode: the verbatim guide kit uses .cap/.bloom/.ico/.dn/.dis; the
  // legacy prefixed markup (still on a few un-migrated screens) uses
  // .cl-cap/.cl-bloom/.cl-ico/.is-down/.is-disabled/.is-loading. Detect which.
  const isNew = !!wrapper.querySelector('.cap');
  const capSel = isNew ? '.cap' : '.cl-cap';
  const bloomSel = isNew ? '.bloom' : '.cl-bloom';
  const icoSel = isNew ? '.ico' : '.cl-ico';
  const DOWN = isNew ? 'dn' : 'is-down';
  const DIS = isNew ? 'dis' : 'is-disabled';
  const LOAD = isNew ? 'load' : 'is-loading';

  const cap = wrapper.querySelector<HTMLElement>(capSel);
  if (!cap || wrapper.classList.contains(LOAD)) return () => {};
  const bloom = cap.querySelector<HTMLElement>(bloomSel);
  const disabled = () => wrapper.classList.contains(DIS);

  const onMove = (e: MouseEvent) => {
    if (reduced || disabled()) return;
    const r = cap.getBoundingClientRect();
    cap.style.setProperty('--mx', `${e.clientX - r.left}px`);
    cap.style.setProperty('--my', `${e.clientY - r.top}px`);
  };
  const onLeave = () => {
    cap.style.setProperty('--mx', '-60px');
    cap.style.setProperty('--my', '-60px');
  };
  const onDown = (e: PointerEvent) => {
    if (disabled()) return;
    wrapper.classList.add(DOWN);
    if (bloom) {
      const r = cap.getBoundingClientRect();
      bloom.style.left = `${e.clientX - r.left - 6}px`;
      bloom.style.top = `${e.clientY - r.top - 6}px`;
    }
  };
  const onUp = () => {
    if (disabled()) return;
    wrapper.classList.remove(DOWN);
    if (bloom && !reduced) {
      bloom.classList.remove('go');
      void bloom.offsetWidth;
      bloom.classList.add('go');
    }
    const anim = cap.dataset.anim;
    if (anim) playIco(cap.querySelector<HTMLElement>(icoSel), `play-${anim}`);
  };
  const onPointerLeave = () => wrapper.classList.remove(DOWN);

  cap.addEventListener('mousemove', onMove);
  cap.addEventListener('mouseleave', onLeave);
  cap.addEventListener('pointerdown', onDown);
  cap.addEventListener('pointerup', onUp);
  cap.addEventListener('pointerleave', onPointerLeave);

  return () => {
    cap.removeEventListener('mousemove', onMove);
    cap.removeEventListener('mouseleave', onLeave);
    cap.removeEventListener('pointerdown', onDown);
    cap.removeEventListener('pointerup', onUp);
    cap.removeEventListener('pointerleave', onPointerLeave);
  };
}

/* Haptics — a firm tick on a genuine button/slider press. Firing on
 * the raw pointerdown (as this did verbatim from the design guide) means
 * a finger merely landing on a button while scrolling past it — no tap
 * intended — still buzzes, since pointerdown fires before the browser
 * knows whether this is a tap or the start of a scroll. This module is
 * shared into the website build too (apps/website's Vite alias pulls in
 * ClButton -> clPhysics), so the bug is live on real Android phones
 * (the only mobile browser that implements navigator.vibrate) scrolling
 * the marketing site, not just the desktop app.
 *
 * Same fix shape as the mobile app's PrimaryButton phantom-vibration fix:
 * gate the tick behind a short timer started on pointerdown, and cancel
 * it on real finger movement or on release. A genuine tap holds still
 * and keeps the pointer down for at least that long; a scroll moves the
 * finger or hands off the touch well inside the window. */
if (typeof document !== 'undefined' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
  const HAPTIC_DELAY_MS = 70;
  const MOVE_CANCEL_PX = 6;
  // The web Vibration API only takes an on-duration — no amplitude/sharpness
  // control like a native haptic engine. At the original 8ms, a phone's
  // vibration motor (especially the cheaper ERM motors most Android phones
  // use, not the fancier LRA ones) barely has time to spin up before being
  // told to stop, so it reads as a weak flutter rather than a felt click.
  // ~18ms gives the motor enough time to actually reach a felt amplitude
  // while staying short enough to read as one discrete tick, not a buzz.
  const HAPTIC_TICK_MS = 18;
  let hapticTimer: ReturnType<typeof setTimeout> | null = null;
  let origin: { x: number; y: number } | null = null;

  const cancelHaptic = () => {
    if (hapticTimer) { clearTimeout(hapticTimer); hapticTimer = null; }
    origin = null;
  };

  document.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || !t.closest('button,.cls')) return;
    origin = { x: e.clientX, y: e.clientY };
    hapticTimer = setTimeout(() => {
      hapticTimer = null;
      navigator.vibrate(HAPTIC_TICK_MS);
    }, HAPTIC_DELAY_MS);
  });
  document.addEventListener('pointermove', (e) => {
    if (!origin) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_CANCEL_PX) cancelHaptic();
  });
  document.addEventListener('pointerup', cancelHaptic);
  document.addEventListener('pointercancel', cancelHaptic);
}
