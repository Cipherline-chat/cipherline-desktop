// Headless Chromium: does the Firewall worker draw one frame per page rAF during a run, and which GL context did it get?
// Start `npx vite --config harness/firewall-rate.vite.config.ts` first. ENV: POWER (high-performance|low-power|''), WAIT (ms).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5244/harness/firewall-rate.html';
const POWER = process.env.POWER ?? '';
const WAIT = Number(process.env.WAIT ?? 12000);
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(`${BASE}${POWER ? `?power=${POWER}` : ''}`, { timeout: 180000 });
await page.waitForFunction(() => window.__fw?.rate, null, { timeout: WAIT + 60000, polling: 250 }).catch(() => {});
const r = await page.evaluate(() => window.__fw);
console.log(JSON.stringify({ power: POWER || '(default)', ...r }, null, 1));
await browser.close();
