// The website's light pages (the reference for the app's Light theme), shot at the
// same size as the app shots so they can sit side by side.
//   node harness/light-theme-website-shot.mjs --out=<dir> [--base=https://cipherline.chat]
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import path from 'path';
import fs from 'fs';

const out = arg('out', '/tmp/light-theme-shots');
const base = arg('base', 'https://cipherline.chat');
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: exe, args: ['--disable-gpu'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    for (const [name, url] of [['website-landing', '/'], ['website-login', '/login']]) {
        const page = await ctx.newPage();
        await page.goto(base + url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.screenshot({ path: path.join(out, `${name}-light-laptop.png`) });
        console.log('shot', name);
        await page.close();
    }
} finally {
    await browser.close();
}
