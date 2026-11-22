// Corner probe (Light theme polish, 2026-11-20): finds the two ways a rounded
// card in this app grows a SQUARE corner.
//
//   A. "clipped shadow": a rounded element casts a box-shadow, and the
//      nearest ancestor that clips (overflow != visible) has a SQUARE edge
//      within the shadow's reach of that corner. The shadow then paints only
//      in the gap between the curve and the square clip: a square of
//      shadow-tint behind the rounded corner. (The owner's left-panel bug:
//      .app-pane2-sheet's shadow clipped by the square .app-pane2.)
//   B. "poking child": a descendant that paints (background / shadow) sits
//      in a rounded ancestor's corner with a smaller radius, and nothing on
//      the way clips it to the curve (sticky headers / footers do this).
//
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts      (another shell)
//   node harness/light-theme-corner-probe.mjs [--themes=dark,light] [--views=...] [--scroll=1] [--w=1366 --h=768]
//
// Prints one line per suspect; "0 suspect(s)" per view/theme is the pass.
import { chromium, exe, arg } from './reaction-center-measure.mjs';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const THEMES = arg('themes', 'dark,light').split(',').filter(Boolean);
const VIEWS = {
    home: 'view=home', server: 'view=server', dm: 'view=dm', friends: 'view=friends',
    appearance: 'view=settings&tab=appearance', accessibility: 'view=settings&tab=accessibility',
    set_profile: 'view=settings&tab=profile', modal: 'view=modal', menu: 'view=menu',
};
const views = arg('views', Object.keys(VIEWS).join(',')).split(',').filter(Boolean);
const W = Number(arg('w', '1366')), H = Number(arg('h', '768'));
const scrollAll = arg('scroll', '0') === '1';

let total = 0;
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
try {
    for (const theme of THEMES) {
        for (const v of views) {
            const ctx = await browser.newContext({ viewport: { width: W, height: H }, reducedMotion: 'reduce' });
            const page = await ctx.newPage();
            await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
            await page.goto(`${BASE}?theme=${theme}&${VIEWS[v] ?? v}`, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
            await page.waitForTimeout(1500);
            if (scrollAll) {
                await page.evaluate(() => {
                    for (const el of document.querySelectorAll('*')) {
                        if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = Math.min(160, el.scrollHeight);
                    }
                });
                await page.waitForTimeout(500);
            }
            const found = await page.evaluate(() => {
                const desc = (el) => {
                    const c = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '';
                    return `${el.tagName.toLowerCase()}.${c.trim().split(/\s+/).slice(0, 3).join('.')}`;
                };
                const transparent = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
                const shadowReach = (sh) => {
                    // max(|x|,|y|) + blur + spread over every non-inset, non-transparent layer
                    if (!sh || sh === 'none') return 0;
                    let reach = 0;
                    for (const layer of sh.split(/,(?![^(]*\))/)) {
                        if (/inset/.test(layer)) continue;
                        const col = (layer.match(/rgba?\([^)]*\)/) ?? [''])[0];
                        if (transparent(col)) continue;
                        const n = layer.replace(/rgba?\([^)]*\)/, '').trim().split(/\s+/).map(parseFloat).filter((x) => !Number.isNaN(x));
                        const [x = 0, y = 0, b = 0, s = 0] = n;
                        reach = Math.max(reach, Math.max(Math.abs(x), Math.abs(y)) + b + s);
                    }
                    return reach;
                };
                const rad = (s) => parseFloat(s.borderTopLeftRadius) || 0;
                const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
                const out = [];
                const all = [...document.querySelectorAll('body *')];
                for (const el of all) {
                    if (!visible(el)) continue;
                    const s = getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    const R = rad(s);
                    // A. clipped shadow
                    const reach = shadowReach(s.boxShadow);
                    if (R >= 6 && reach > 2 && r.width > 40 && r.height > 30) {
                        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                            const as = getComputedStyle(a);
                            if (as.overflowX === 'visible' && as.overflowY === 'visible' && as.contain.indexOf('paint') < 0) continue;
                            const ar = a.getBoundingClientRect();
                            const near = (ar.left > r.left - reach) || (ar.top > r.top - reach) || (ar.right < r.right + reach) || (ar.bottom < r.bottom + reach);
                            const aR = rad(as);
                            // a clip that is the WINDOW-sized page (the app root) is the window edge: fine
                            const isPage = ar.width >= innerWidth - 4 && ar.height >= innerHeight - 40;
                            if (near && !isPage && aR < R - 1) out.push({ kind: 'A clipped-shadow', el: desc(el), radius: R, reach: Math.round(reach), clip: desc(a), clipRadius: aR, box: [r.left, r.top, r.width, r.height].map(Math.round).join(',') });
                            break;
                        }
                    }
                    // B. poking child: el paints, and a rounded ancestor (not clipping) has el in its corner
                    const paints = !transparent(s.backgroundColor) || s.backgroundImage !== 'none';
                    if (paints && r.width > 20 && r.height > 12) {
                        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
                            const as = getComputedStyle(a);
                            const clips = !(as.overflowX === 'visible' && as.overflowY === 'visible');
                            const aR = rad(as);
                            const ar = a.getBoundingClientRect();
                            if (aR >= 8 && !clips) {
                                const tl = Math.abs(r.left - ar.left) < 2 && Math.abs(r.top - ar.top) < 2;
                                const br = Math.abs(r.right - ar.right) < 2 && Math.abs(r.bottom - ar.bottom) < 2;
                                const tr = Math.abs(r.right - ar.right) < 2 && Math.abs(r.top - ar.top) < 2;
                                const bl = Math.abs(r.left - ar.left) < 2 && Math.abs(r.bottom - ar.bottom) < 2;
                                const corners = [tl && 'TL', tr && 'TR', bl && 'BL', br && 'BR'].filter(Boolean);
                                const myR = Math.min(...['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius'].map((k) => parseFloat(s[k]) || 0));
                                const parentPaints = !transparent(as.backgroundColor) || as.backgroundImage !== 'none' || as.boxShadow !== 'none' || as.borderTopWidth !== '0px';
                                if (corners.length && myR < aR - 1 && parentPaints) out.push({ kind: 'B poking-child', el: desc(el), corners: corners.join('+'), radius: myR, parent: desc(a), parentRadius: aR, bg: s.backgroundColor });
                            }
                            if (clips) break;
                        }
                    }
                }
                return out;
            });
            total += found.length;
            console.log(`== ${v} / ${theme}${scrollAll ? ' (scrolled)' : ''}: ${found.length} suspect(s)`);
            for (const f of found) console.log('   ' + JSON.stringify(f));
            await ctx.close();
        }
    }
} finally {
    await browser.close();
}
console.log(`TOTAL ${total}`);
