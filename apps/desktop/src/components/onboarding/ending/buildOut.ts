/* ============================================================
   The build-out: the dots condense onto the REAL Home that is already
   mounted under the onboarding overlay, then hand over to it.
   Port of ob6/js/main.js assembledShape() / reveal().

   The Home is never replicated: every piece is found by a stable
   `data-ob-anchor` attribute on the real Dashboard / HomePanel /
   rail markup and measured where it is on screen.

     rail-track        each rail deck (top: DMs/Groups/servers/add; bottom: Friends/Settings)
     rail-logo         the brand mark at the top of the rail
     rail-me           your avatar at the bottom of the rail
     home-pane         the Home card (app-pane-solo)
     home-eyebrow      the date line
     home-greeting     "Good afternoon, <name>."
     home-subline      "Quiet since you left." (or what moved)
     home-keys         Keys, the mascot
     home-tile         each deck tile
     home-floor        the status line under the deck
     onboarding-checklist  the "Finish setting up" card

   The rail buttons are the children of each rail-track (minus the
   sliding indicator), so a server joined during the ending is picked up
   without its own anchor.
   ============================================================ */
import * as S from '../dots/shapes';
import { COL, stitch } from '../dots/scenes';
import type { OutlineRect, PointShape, Rgb } from '../dots/shapes';
import type { Shape } from '../dots';

export type RevealGroup = 'pane' | 'track' | 'logo' | 'icon' | 'tile' | 'line' | 'keys' | 'me' | 'checklist';

/** [group, start ms after the dissolve begins, stagger per element ms] — the
 *  prototype's REVEAL order (pane, rail, icons, tiles, greeting, Keys, you),
 *  plus the checklist card last. */
export const REVEAL: ReadonlyArray<readonly [RevealGroup, number, number]> = [
    ['pane', 0, 0], ['track', 40, 0], ['logo', 60, 0], ['icon', 80, 30], ['tile', 120, 50],
    ['line', 160, 30], ['keys', 200, 0], ['me', 220, 0], ['checklist', 260, 0],
];

const anchors = (name: string, root: ParentNode = document): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(`[data-ob-anchor="${name}"]`));

/** On screen and big enough to draw. */
function onScreen(r: DOMRect): boolean {
    return r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0
        && r.left < window.innerWidth && r.top < window.innerHeight;
}

/** The rail buttons: each rail deck's children, minus its sliding indicator. */
function railButtons(): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const track of anchors('rail-track')) {
        for (const c of Array.from(track.children) as HTMLElement[]) {
            if (c.classList.contains('cl-rail-indicator')) continue;
            const r = c.getBoundingClientRect();
            if (r.width >= 20 && r.height >= 20) out.push(c);
        }
    }
    return out;
}

/** Every real Home element the hand-over fades in, by group. */
export function collectReveal(): Map<RevealGroup, HTMLElement[]> {
    const m = new Map<RevealGroup, HTMLElement[]>();
    m.set('pane', anchors('home-pane'));
    m.set('track', anchors('rail-track'));
    m.set('logo', anchors('rail-logo'));
    m.set('icon', railButtons());
    m.set('tile', anchors('home-tile'));
    m.set('line', [...anchors('home-eyebrow'), ...anchors('home-greeting'), ...anchors('home-subline'), ...anchors('home-floor')]);
    m.set('keys', anchors('home-keys'));
    m.set('me', anchors('rail-me'));
    m.set('checklist', anchors('onboarding-checklist'));
    return m;
}

/** The greeting for the dot type: the real h1's text, with the name the
 *  profile step just saved (in case /auth/me has not re-rendered it yet). */
export function greetingText(real: string, name: string | null | undefined): string {
    const t = real.replace(/\s+/g, ' ').trim();
    if (!name) return t;
    const m = /^(.*?),\s.*\.$/.exec(t);
    if (!m) return t;
    const first = name.split(' ')[0] || name;
    return `${m[1]}, ${first}.`;
}

/**
 * The cloud the dots condense into: the real Home, measured. World units
 * match the dot engine's projection at offX = offY = 0, scale 1, no yaw /
 * pitch, cam 3.2 (the build-out tweens to exactly that).
 */
export function assembledShape(N: number, name: string | null | undefined): PointShape {
    const W = window.innerWidth, H = window.innerHeight, asp = W / H, cam = 3.2;
    const toW = (x: number, y: number): [number, number] => [((x / W) * 2 - 1) * asp * cam / 2.2, (1 - (y / H) * 2) * cam / 2.2];
    const pxW = (2 * cam) / (2.2 * H);
    const parts: Shape[] = [];
    const rects: OutlineRect[] = [];
    let used = 0;
    const add = (sh: PointShape): void => { parts.push(sh); used += sh.N; };

    const box = (els: HTMLElement[], o: Partial<OutlineRect> = {}): void => {
        for (const n of els) {
            const r = n.getBoundingClientRect();
            if (!onScreen(r)) continue;
            const [x, y] = toW(r.left, r.top), [x2, y2] = toW(r.right, Math.min(r.bottom, H));
            rects.push({ x, y, w: x2 - x, h: y - y2, ...o });
        }
    };
    const line = (els: Element[], o: Partial<OutlineRect> = {}): void => {
        for (const n of els) {
            const rg = document.createRange();
            rg.selectNodeContents(n);
            const r = rg.getBoundingClientRect();
            if (!onScreen(r)) continue;
            const [x, y] = toW(r.left, r.top + r.height / 2), [x2] = toW(r.right, 0);
            rects.push({ kind: 'line', x, y, w: x2 - x, h: Math.max(0.012, r.height * pxW * 0.5), ...o });
        }
    };
    const within = (sel: string): Element[] => anchors('home-tile').flatMap((t) => Array.from(t.querySelectorAll(sel)));

    // Pane and tile edges, the rail decks, and text-line strips.
    box(anchors('home-pane'), { weight: 0.55 });
    box(anchors('rail-track'), { weight: 0.9, color: S.C.ice });
    box(anchors('home-tile'), { weight: 0.8 });
    line(anchors('home-subline'), { weight: 1.6, color: S.C.white, bright: 0.55 });
    line(anchors('home-eyebrow'), { weight: 1.1, color: S.C.white, bright: 0.5 });
    line(within('h2'), { weight: 0.9, color: S.C.white, bright: 0.45 });
    line(within('.hd-clear strong'), { weight: 0.9, color: S.C.white, bright: 0.5 });
    line(within('.hd-addcard span'), { weight: 0.5, color: S.C.white, bright: 0.35 });
    if (rects.length) add(S.outlines(2400, rects, { count: 2400, dark: true }));

    // The greeting in dot type.
    const h1 = anchors('home-greeting')[0];
    if (h1) {
        const rg = document.createRange(); rg.selectNodeContents(h1);
        const r = rg.getBoundingClientRect();
        if (onScreen(r)) {
            const cs = getComputedStyle(h1);
            const fs = parseFloat(cs.fontSize) || 36;
            const [cx, cy] = toW(r.left + r.width / 2, r.top + r.height / 2);
            add(S.text(1500, greetingText(h1.textContent || '', name), {
                height: fs * pxW, maxW: r.width * pxW * 1.02, x: cx, y: cy, count: 1500, dark: true,
                color: COL.white, depth: 0.02, font: cs.fontFamily, weight: cs.fontWeight,
            }));
        }
    }

    // Keys on Home as a dot mascot, and the rail logo.
    const keysAt = (n: number, el: Element | undefined): void => {
        if (!el) return;
        const r = (el.querySelector('svg, img') ?? el).getBoundingClientRect();
        if (!onScreen(r)) return;
        const [cx, cy] = toW(r.left + r.width / 2, r.top + r.height * 0.52);
        add(S.keys(n, { size: (r.width * pxW) * 45 / 70, x: cx, y: cy, count: n, dark: true, color: COL.lume }));
    };
    keysAt(1100, anchors('home-keys')[0]);
    keysAt(220, anchors('rail-logo')[0]);

    // Your avatar as a gold disc.
    const me = anchors('rail-me')[0];
    if (me) {
        const r = me.getBoundingClientRect();
        if (onScreen(r)) {
            const n = 380, [cx, cy] = toW(r.left + r.width / 2, r.top + r.height / 2);
            const rad = (Math.min(r.width, r.height) / 2) * pxW * 0.92;
            const s = S.blank(n), rr = S.rng(9);
            const col: Rgb = [COL.gold[0] * 1.1, COL.gold[1] * 1.1, COL.gold[2] * 1.1];
            for (let i = 0; i < n; i++) { const a = rr() * Math.PI * 2, d = Math.sqrt(rr()) * rad; S.put(s, i, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, col); }
            add(s);
        }
    }

    // Each rail button as a small cluster (as many as the budget allows).
    const btns = railButtons().filter((b) => onScreen(b.getBoundingClientRect()));
    const per = btns.length ? Math.max(12, Math.min(70, Math.floor((N - used) / btns.length))) : 0;
    btns.forEach((b, i) => {
        const r = b.getBoundingClientRect();
        const [cx, cy] = toW(r.left + r.width / 2, r.top + r.height / 2);
        const s = S.blank(per), rr = S.rng(40 + i);
        for (let j = 0; j < per; j++) { const a = rr() * 6.283, d = Math.sqrt(rr()) * 11 * pxW; S.put(s, j, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, [0.45, 0.702, 0.9]); }
        add(s);
    });

    return stitch(N, parts);
}

/* ---- the hand-over on the real elements ----
   Attributes, not classes, so a React re-render of the Dashboard (which
   rewrites className) can never strip them mid-dissolve. */
export function markForBuild(groups: Map<RevealGroup, HTMLElement[]>): HTMLElement[] {
    const marked: HTMLElement[] = [];
    for (const [g, els] of groups) for (const el of els) { el.setAttribute('data-ob-bp', g); marked.push(el); }
    document.documentElement.setAttribute('data-ob-build', '');
    return marked;
}

/** The hand-over starts: from here on the pieces transition (hiding them was instant). */
export function startHandover(): void { document.documentElement.setAttribute('data-ob-handover', ''); }

export function revealEl(el: HTMLElement): void { el.setAttribute('data-ob-in', ''); }

/** Remove every trace of the build-out from the real Dashboard. */
export function clearBuildMarks(marked: readonly HTMLElement[]): void {
    for (const el of marked) { el.removeAttribute('data-ob-bp'); el.removeAttribute('data-ob-in'); }
    document.documentElement.removeAttribute('data-ob-build');
    document.documentElement.removeAttribute('data-ob-handover');
}
