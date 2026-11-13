// Settings merge (Activity & Style, Steam under Profile): screenshots of the REAL SettingsScreen.
//
//   npx vite --config harness/settings-merge.vite.config.ts        (serves :5391)
//   node harness/settings-merge-shots.mjs <outDir> <prefix> <shot,shot,...>
//
// A shot is name=tab[+action...]; actions:
//   showcase      click Settings > Profile's Showcase tab
//   q:<text>      type <text> into the gauge search (the nav is shot)
//   w:<px>        viewport width (default 1280; < 1080 = fullscreen Descent)
//   nav           shoot only the gauge (.sd-gauge)
//   full          also shoot the whole pane unrolled (<name>-full.png)
//   scroll:<sel>  scroll this element into view before the window shot
// Prints the nav labels and the pane title for each shot (proof in text too).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5391/harness/settings-merge.html';
const OUT = process.argv[2] ?? '/tmp/settings-merge';
const PREFIX = process.argv[3] ?? 'after';
const SHOTS = (process.argv[4] ?? 'nav=profile+nav').split(',');
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UNROLL = `.sd-root.sd-win{height:calc(100vh - 80px)!important}`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=gl-egl', '--ignore-gpu-blocklist'] });
const errors = [];
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(180000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 300)); });
    for (const spec of SHOTS) {
        const [name, rest] = spec.split('=');
        const [tab, ...actions] = rest.split('+');
        const width = Number((actions.find(a => a.startsWith('w:')) ?? 'w:1280').slice(2));
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${BASE}?tab=${tab}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForFunction(() => window.__booted === true, null, { timeout: 180000 });
        await page.waitForSelector('.sd-pane', { timeout: 180000 });
        await page.evaluate(() => document.fonts.ready);
        await sleep(1800);
        if (actions.includes('showcase')) {
            await page.click('[data-testid="profile-pane-tab-showcase"]');
            await sleep(600);
        }
        const q = actions.find(a => a.startsWith('q:'));
        if (q) {
            await page.fill('[aria-label="Find a setting"]', q.slice(2));
            await sleep(500);
        }
        const sc = actions.find(a => a.startsWith('scroll:'));
        if (sc) {
            await page.locator(sc.slice(7)).first().scrollIntoViewIfNeeded();
            await sleep(500);
        }
        const info = await page.evaluate(() => ({
            title: document.querySelector('.sd-chead h1')?.textContent,
            nav: [...document.querySelectorAll('.sd-nitem')].map(b => b.textContent.trim()),
            groups: [...document.querySelectorAll('.sd-pane h2, .sd-pane .sx-disc-head b, .sd-pane [role=region][aria-label]')].map(e => e.getAttribute('aria-label') ?? e.textContent.trim()),
            steamHere: !!document.querySelector('.sd-pane [data-testid="steam-linked"], .sd-pane [data-testid="steam-connect"]'),
        }));
        console.log(`${PREFIX}-${name}: title=${JSON.stringify(info.title)} steamInPane=${info.steamHere}\n   nav=${JSON.stringify(info.nav)}\n   sections=${JSON.stringify(info.groups)}`);
        if (actions.includes('nav')) {
            await page.locator('.sd-gauge').screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
        } else {
            await page.screenshot({ path: `${OUT}/${PREFIX}-${name}.png` });
        }
        if (actions.includes('full')) {
            const tall = await page.evaluate(() => document.querySelector('.sd-main').scrollHeight);
            await page.setViewportSize({ width, height: Math.min(9000, tall + 160) });
            const style = await page.addStyleTag({ content: UNROLL });
            await sleep(900);
            await page.screenshot({ path: `${OUT}/${PREFIX}-${name}-full.png` });
            await style.evaluate(n => n.remove());
        }
        console.log('SHOT', `${OUT}/${PREFIX}-${name}.png`);
    }
} finally {
    if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
    await browser.close();
}
