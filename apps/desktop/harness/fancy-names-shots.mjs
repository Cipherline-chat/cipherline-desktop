// Fancy server / role names screenshots.
//   LT_PORT=5461 npx vite --config harness/light-theme.vite.config.ts     (server view)
//   FR_PORT=5471 npx vite --config harness/fancy-roles.vite.config.ts     (roles editor, create dialog)
//   OUT=<dir> node harness/fancy-names-shots.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const LT = `http://127.0.0.1:${process.env.LT_PORT ?? 5461}/harness/light-theme.html`;
const FR = `http://127.0.0.1:${process.env.FR_PORT ?? 5471}/harness/fancy-roles.html`;
const out = process.env.OUT ?? '/tmp/fancy-names';
mkdirSync(out, { recursive: true });
const SIZES = { '1366x768': [1366, 768], '1000x720': [1000, 720] };
const VIEWS = {
  // whole server view: rail tile, channel-list header, member list with role groups
  // (the rail tile's tooltip is the browser-native `title`, which a screenshot cannot draw:
  // the prep asserts the full decorative name is what it carries)
  server: {
    url: `${LT}?view=server&fancy=1`, wait: 'booted',
    prep: async (page) => {
      const t = await page.locator('button[title*="Moonlit"]').first().getAttribute('title');
      if (t !== '✦ ꒰ Moonlit Café ꒱ ✦') throw new Error(`rail tooltip title is ${JSON.stringify(t)}`);
      console.log('rail tile title ok:', t);
    },
  },
  roles_editor: { url: `${FR}?scene=roles`, wait: 'booted' },
  create_server: { url: `${FR}?scene=create`, wait: 'booted', prep: async (page) => {
    await page.keyboard.type('✦ ꒰ Moonlit Café ꒱ ✦');
    await page.waitForTimeout(400);
  } },
  create_server_rejected: { url: `${FR}?scene=create`, wait: 'booted', prep: async (page) => {
    await page.keyboard.type('Moon‮Club');
    await page.waitForTimeout(400);
  } },
};
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
const errors = [];
try {
  for (const [sid, [w, h]] of Object.entries(SIZES)) {
    for (const theme of ['dark', 'light']) {
      for (const [name, spec] of Object.entries(VIEWS)) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
        const page = await ctx.newPage();
        await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
        page.on('pageerror', e => errors.push(`${name}/${theme}/${sid}: ${e.message}`));
        await page.goto(`${spec.url}&theme=${theme}`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__booted === true, null, { timeout: 30000 });
        await page.waitForTimeout(1800);
        if (spec.prep) await spec.prep(page);
        const file = path.join(out, `${name}-${theme}-${sid}.png`);
        await page.screenshot({ path: file });
        console.log('shot', file);
        await ctx.close();
      }
    }
  }
} finally { await browser.close(); }
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].join('\n'));
