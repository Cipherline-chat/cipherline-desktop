// Previewing-theme bar placement shots (claude/theme-preview-bar-corner). Reuses the light-theme
// harness with ?preview=<preset> (the REAL ThemePreviewBar over the real panes).
//   LT_PORT=5431 npx vite --config harness/light-theme.vite.config.ts   (another shell)
//   node harness/theme-preview-bar-corner-shots.mjs --out=<dir> [--left=16px] [--tag=optA-]
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';
const BASE = `http://127.0.0.1:${process.env.LT_PORT ?? 5431}/harness/light-theme.html`;
const out = arg('out', '/tmp/tlp-shots');
const left = arg('left', '');
const tag = arg('tag', '');
const SIZES = [['1000x720', 1000, 720, 1], ['1366x768', 1366, 768, 1], ['1920x1080', 1920, 1080, 1], ['1280x800@1.5', 1280, 800, 1.5]];
const VIEWS = [['server', 'view=server&msgs=theme'], ['dm', 'view=dm&msgs=theme'], ['settings', 'view=settings&tab=appearance&lib=1']];
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--font-render-hinting=none', '--disable-gpu'] });
try {
  for (const [label, w, h, dsf] of SIZES) for (const theme of ['dark', 'light']) for (const [vn, vq] of VIEWS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('ERR', e.message));
    await page.clock.setFixedTime(new Date('2026-11-20T17:00:00'));
    await page.goto(`${BASE}?${vq}&theme=${theme}&preview=ocean${left ? `&tlpleft=${left}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__booted === true, null, { timeout: 120000 });
    await page.waitForTimeout(1800);
    const r = await page.evaluate(() => { const b = document.querySelector('.tlp')?.getBoundingClientRect(); return b && { l: b.left, b: innerHeight - b.bottom, top: b.top, comp: document.querySelector('.cl-composer')?.getBoundingClientRect().top }; });
    await page.screenshot({ path: path.join(out, `${tag}${vn}-${theme}-${label}.png`) });
    console.log(`${tag}${vn}-${theme}-${label}`, JSON.stringify(r));
    await ctx.close();
  }
} finally { await browser.close(); }
