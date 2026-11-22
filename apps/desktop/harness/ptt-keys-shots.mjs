// Screenshots of the push-to-talk background-key hints (Settings → Voice & Video row, Settings → Keybinds row,
// the in-call elevated-game toast) at the four window sizes, Dark and Light, with overflow checks.
//   PTT_PORT=5331 npx vite --config harness/ptt-keys.vite.config.ts      (another shell)
//   OUT=<dir> node harness/ptt-keys-shots.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PTT_PORT ?? 5331}/harness/ptt-keys.html`;
const OUT = process.env.OUT ?? '/tmp/ptt-keys-shots';
mkdirSync(OUT, { recursive: true });
const sizes = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];
const scenes = [
    ['voice', 'unmapped', true], ['voice', 'wayland', true], ['voice', 'ok', false],
    ['keybinds', 'macos', true], ['keybinds', 'mouse', false],
    ['toast', 'ok', false],
];
let failures = 0;
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    for (const theme of ['dark', 'light']) {
        for (const [name, w, h, dsf] of sizes) {
            const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf });
            const page = await ctx.newPage();
            page.on('pageerror', e => { failures++; console.log('FAIL pageerror ' + e.message); });
            for (const [pane, state, hintExpected] of scenes) {
                await page.goto(`${BASE}?pane=${pane}&state=${state}&theme=${theme}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
                await page.waitForTimeout(1800);
                if (pane !== 'toast') {
                    const row = pane === 'voice'
                        ? page.locator('.vv-row').filter({ hasText: 'Push to talk' }).first()
                        : page.locator('[data-testid=ptt-keybind-row]');
                    await row.scrollIntoViewIfNeeded();
                    await page.evaluate(() => window.scrollBy(0, -120));
                    const hints = await page.locator('[data-testid=ptt-background-hint]').count();
                    const ok = hintExpected ? hints === 1 : hints === 0;
                    if (!ok) failures++;
                    console.log(`${ok ? 'PASS' : 'FAIL'} ${theme} ${name} ${pane}/${state}: hint ${hints ? 'shown' : 'absent'}`);
                    const caps = (await row.locator('.sd-kbd').first().innerText()).replace(/\s+/g, ' ');
                    console.log(`     keycap: ${caps}`);
                } else {
                    const t = await page.getByText('runs as administrator').count();
                    if (t !== 1) failures++;
                    console.log(`${t === 1 ? 'PASS' : 'FAIL'} ${theme} ${name} toast shown`);
                }
                const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
                if (over) { failures++; console.log(`FAIL horizontal overflow ${theme} ${name} ${pane}/${state}`); }
                await page.screenshot({ path: `${OUT}/${pane}-${state}-${theme}-${name}.png` });
            }
            await ctx.close();
        }
    }
} finally { await browser.close(); }
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
