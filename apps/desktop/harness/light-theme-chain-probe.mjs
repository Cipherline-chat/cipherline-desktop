// Ancestor-chain probe (Light theme polish): for a selector, print it and each
// ancestor up to <body> with the paint-relevant computed styles, so the
// element painting a square behind a rounded panel can be named.
//   node harness/light-theme-chain-probe.mjs --theme=light --view=server --sel=.app-pane2-sheet
//   node harness/light-theme-chain-probe.mjs --theme=light --view=server --point=76,42   (elementsFromPoint)
import { chromium, exe, arg } from './reaction-center-measure.mjs';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const VIEWS = {
    home: 'view=home', server: 'view=server', dm: 'view=dm', friends: 'view=friends',
    appearance: 'view=settings&tab=appearance', modal: 'view=modal',
};
const theme = arg('theme', 'light');
const view = arg('view', 'server');
const sel = arg('sel', '');
const point = arg('point', '');

const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
try {
    const ctx = await browser.newContext({ viewport: { width: Number(arg('w', '1366')), height: Number(arg('h', '768')) }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
    await page.goto(`${BASE}?theme=${theme}&${VIEWS[view] ?? view}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const out = await page.evaluate(({ sel, point }) => {
        const info = (el) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const c = typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '';
            return {
                el: `${el.tagName.toLowerCase()}.${c.trim().split(/\s+/).join('.')}`.slice(0, 140),
                box: [r.left, r.top, r.width, r.height].map(Math.round).join(','),
                bg: s.backgroundColor, img: s.backgroundImage.slice(0, 90), radius: s.borderRadius,
                shadow: s.boxShadow.slice(0, 90), filter: s.filter, backdrop: s.backdropFilter, overflow: s.overflow,
                border: `${s.borderTopWidth} ${s.borderTopColor}`, outline: s.outlineStyle, clip: s.clipPath,
            };
        };
        if (point) {
            const [x, y] = point.split(',').map(Number);
            return document.elementsFromPoint(x, y).map(info);
        }
        const chain = [];
        for (let el = document.querySelector(sel); el && el !== document.documentElement; el = el.parentElement) chain.push(info(el));
        return chain;
    }, { sel, point });
    for (const o of out) console.log(JSON.stringify(o));
    await ctx.close();
} finally {
    await browser.close();
}
