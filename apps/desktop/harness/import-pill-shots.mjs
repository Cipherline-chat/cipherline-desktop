// Import-pill screenshots + geometry check: the REAL title bar (light-theme
// harness drift shell + TitleBarWordmark) with the REAL DiscordImportHost /
// ImportPill in every state, every theme, the owner's window sizes, plus
// close-ups (3x) of each state and its hover / keyboard focus / pressed look.
//
//   LT_PORT=5452 npx vite --config harness/import-pill.vite.config.ts      (another shell)
//   node harness/import-pill-shots.mjs --out=<dir> [--themes=dark,light,midnight,hc-dark] [--sizes=min,laptop,large,hidpi]
//        [--states=run,...] [--closeups=1] [--broken=1]
//
// Files: <out>/strip-<state>-<theme>-<size>.png (the top 96 px, full window width),
//        <out>/full-<state>-<theme>-<size>.png (running state only), <out>/close-<state>[-hover|-focus|-pressed]-<theme>.png
// Every shot is checked: the pill is 28 px tall with even room in the 34 px bar, centred, a no-drag click target,
// clear (>= 8 px) of the wordmark and the stand-in native caption buttons, and its tail (the % / action) not clipped.
// --broken=1 removes the width cap (deliberately broken control: the long states must FAIL at 1000 px).
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5452}/harness/light-theme.html`;
const out = arg('out', '/tmp/import-pill-shots');
const THEMES = arg('themes', 'dark,light,midnight,hc-dark').split(',').filter(Boolean);
const ALL_SIZES = {
    min: { width: 1000, height: 720, dsf: 1 },
    laptop: { width: 1366, height: 768, dsf: 1 },
    large: { width: 1920, height: 1080, dsf: 1 },
    hidpi: { width: 1280, height: 800, dsf: 1.5 },
};
const SIZES = arg('sizes', 'min,laptop,large,hidpi').split(',').filter(Boolean);
const STATES = arg('states', 'run,run_start,run_late,copy,finishing,stopping,done,failed_retry,failed,issues,stopped,history_failed,structure_failed,long,long_done').split(',').filter(Boolean);
const CLOSEUPS = arg('closeups', '1') === '1';
const BROKEN = arg('broken', '0') === '1';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
const errors = [];
const fails = [];
let checks = 0;

async function open(ctx, state, theme) {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${state}/${theme}: ${e.message}`));
    await page.goto(`${BASE}?theme=${theme}&view=server&caption=win&pill=${state}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
    await page.waitForSelector('[data-testid="import-pill"]', { timeout: 15000 });
    if (BROKEN) await page.addStyleTag({ content: '.cl-import-pill{max-width:none!important}' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    return page;
}

async function geometry(page) {
    return page.evaluate(() => {
        const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
        const pill = document.querySelector('[data-testid="import-pill"]');
        const tail = pill.querySelector('[data-testid="import-pill-tail"]');
        const name = pill.querySelector('[data-testid="import-pill-name"]');
        const p = r(pill);
        const at = document.elementFromPoint(p.l + p.w / 2, p.t + p.h / 2);
        const cs = getComputedStyle(pill);
        return {
            vw: innerWidth, pill: p, tail: r(tail), name: r(name),
            nameClipped: name.scrollWidth > name.clientWidth + 1,
            wordmark: r(document.querySelector('[data-testid="titlebar-wordmark"]')),
            caption: r(document.querySelector('[data-testid="caption-standin"]')),
            hitIsPill: !!at && pill.contains(at),
            appRegion: cs.getPropertyValue('-webkit-app-region') || cs.getPropertyValue('app-region'),
            barRegion: getComputedStyle(document.querySelector('.drag-region')).getPropertyValue('-webkit-app-region'),
            scrollX: document.documentElement.scrollWidth > innerWidth,
        };
    });
}

function check(g, label) {
    checks++;
    const bad = [];
    const { pill } = g;
    if (Math.abs(pill.h - 28) > 0.6) bad.push(`height ${pill.h}`);
    if (Math.abs(pill.t - 3) > 0.6 || Math.abs(34 - pill.b - 3) > 0.6) bad.push(`room top ${pill.t} bottom ${34 - pill.b}`);
    if (Math.abs((pill.l + pill.r) / 2 - g.vw / 2) > 1) bad.push(`off centre ${(pill.l + pill.r) / 2} vs ${g.vw / 2}`);
    if (g.wordmark && pill.l - g.wordmark.r < 8) bad.push(`meets wordmark (gap ${(pill.l - g.wordmark.r).toFixed(1)})`);
    if (g.caption && g.caption.l - pill.r < 8) bad.push(`meets caption buttons (gap ${(g.caption.l - pill.r).toFixed(1)})`);
    if (g.tail.r > pill.r - 2 || g.tail.l < pill.l) bad.push('tail clipped');
    if (!g.hitIsPill) bad.push('centre click does not hit the pill');
    if (g.appRegion && g.appRegion !== 'no-drag') bad.push(`app-region ${g.appRegion}`);
    if (g.scrollX) bad.push('sideways scroll');
    if (bad.length) fails.push(`${label}: ${bad.join('; ')}`);
    return bad.length === 0;
}

try {
    for (const sizeId of SIZES) {
        const s = ALL_SIZES[sizeId];
        for (const theme of THEMES) {
            const ctx = await browser.newContext({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: s.dsf, reducedMotion: 'no-preference' });
            await ctx.addInitScript(() => { window.__pw = true; });
            for (const state of STATES) {
                const page = await open(ctx, state, theme);
                const g = await geometry(page);
                const ok = check(g, `${state}/${theme}/${sizeId}`);
                if (!BROKEN) {
                    await page.screenshot({ path: path.join(out, `strip-${state}-${theme}-${sizeId}.png`), clip: { x: 0, y: 0, width: s.width, height: 96 } });
                    if (state === 'run') await page.screenshot({ path: path.join(out, `full-${state}-${theme}-${sizeId}.png`) });
                }
                console.log(ok ? 'PASS' : 'FAIL', state, theme, sizeId, `pill ${g.pill.w.toFixed(0)}x${g.pill.h} @${g.pill.l.toFixed(0)}`, g.nameClipped ? '(name ellipsised)' : '');
                await page.close();
            }
            await ctx.close();
        }
    }
    if (CLOSEUPS && !BROKEN) {
        for (const theme of [...new Set([...THEMES, 'hc-light'])]) {
            const ctx = await browser.newContext({ viewport: { width: 1000, height: 720 }, deviceScaleFactor: 3, reducedMotion: 'reduce' });
            for (const state of STATES) {
                const page = await open(ctx, state, theme);
                const pill = page.locator('[data-testid="import-pill"]');
                const b = await pill.boundingBox();
                const clip = { x: Math.max(0, b.x - 14), y: 0, width: b.width + 28, height: 34 };
                await page.screenshot({ path: path.join(out, `close-${state}-${theme}.png`), clip });
                if (['run', 'done', 'failed_retry'].includes(state)) {
                    const wide = { x: Math.max(0, b.x - 14), y: 0, width: b.width + 28, height: 40 };
                    // keyboard focus first (Tab into the page, then the pill, no pointer since => :focus-visible)
                    await page.keyboard.press('Tab');
                    await pill.focus();
                    await page.waitForTimeout(300);
                    const fv = await pill.evaluate((el) => el.matches(':focus-visible'));
                    if (!fv) fails.push(`${state}/${theme}: focus ring not shown (:focus-visible false)`);
                    await page.screenshot({ path: path.join(out, `close-${state}-focus-${theme}.png`), clip: wide });
                    await pill.evaluate((el) => el.blur());
                    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
                    await page.waitForTimeout(300);
                    await page.screenshot({ path: path.join(out, `close-${state}-hover-${theme}.png`), clip: wide });
                    await page.mouse.down();
                    await page.waitForTimeout(250);
                    await page.screenshot({ path: path.join(out, `close-${state}-pressed-${theme}.png`), clip: wide });
                    // releasing is the click: the import's view opens and the pill steps aside (behaviour unchanged)
                    await page.mouse.up();
                    await page.waitForTimeout(500);
                    const after = await page.evaluate(() => ({ pill: !!document.querySelector('[data-testid="import-pill"]'), dialog: !!document.querySelector('[role="dialog"]') }));
                    if (after.pill || !after.dialog) fails.push(`${state}/${theme}: click did not open the import view (${JSON.stringify(after)})`);
                }
                await page.close();
            }
            await ctx.close();
        }
        // Reduce motion really stops the shimmer and the spinner (computed, not just present in the CSS).
        for (const motion of ['reduce', 'no-preference']) {
            const ctx = await browser.newContext({ viewport: { width: 1000, height: 720 }, reducedMotion: motion });
            const page = await open(ctx, 'finishing', 'dark');
            const anim = await page.evaluate(() => ({
                shimmer: getComputedStyle(document.querySelector('.cl-import-pill-fill'), '::after').animationName,
                spin: getComputedStyle(document.querySelector('.cl-import-pill-spin')).animationName,
            }));
            console.log(`motion=${motion}`, JSON.stringify(anim));
            const still = anim.shimmer === 'none' && anim.spin === 'none';
            if ((motion === 'reduce') !== still) fails.push(`motion=${motion}: ${JSON.stringify(anim)}`);
            await ctx.close();
        }
    }
} finally {
    await browser.close();
}
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
console.log(`\n${checks} geometry checks, ${fails.length} failures`);
for (const f of fails) console.log('  FAIL', f);
process.exitCode = fails.length ? 1 : 0;
