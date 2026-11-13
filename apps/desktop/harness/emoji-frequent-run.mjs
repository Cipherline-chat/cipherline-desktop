// npx vite --config harness/emoji-frequent.vite.config.ts   then   node harness/emoji-frequent-run.mjs   (env OUT=<dir>)
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/home/antigravity/Cipherline/node_modules/playwright-core');
const b = await chromium.launch({ executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1247/chrome-linux64/chrome` });
const OUT = process.env.OUT ?? '/tmp';
let bad = 0;
for (const fix of [0, 1]) {
    const p = await (await b.newContext({ viewport: { width: 420, height: 460 } })).newPage();
    await p.goto(`http://127.0.0.1:5499/harness/emoji-frequent.html?fix=${fix}`);
    await p.waitForTimeout(2500);
    const state = () => p.evaluate(() => {
        const root = document.querySelector('em-emoji-picker')?.shadowRoot;
        const imgs = [...(root?.querySelectorAll('img') ?? [])].map(i => i.getAttribute('src') ?? '');
        return { tiles: imgs.length, waiting: imgs.filter(s => s.includes('%3Crect')).length, real: imgs.filter(s => s.includes('%3Ccircle')).length };
    });
    const s = await state();
    await p.screenshot({ path: `${OUT}/emoji-frequent-fix${fix}.png`, clip: { x: 0, y: 0, width: 420, height: 180 } });
    const ok = fix ? s.waiting === 0 && s.real > 0 : s.waiting > 0;
    if (!ok) bad++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  fix=${fix} without hovering: ${JSON.stringify(s)}`);
}
await b.close();
process.exit(bad ? 1 : 0);
