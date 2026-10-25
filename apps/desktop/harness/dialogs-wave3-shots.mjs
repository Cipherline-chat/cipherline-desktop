// Wave-3 dialogs: screenshots (full page 1280x800 + 2x clip of the dialog card) and contact sheets.
//   LABEL=before|after OUT=<dir> node harness/dialogs-wave3-shots.mjs [dialogKey ...]
// Output: <OUT>/<LABEL>/<dialog>--<state>.png (full) and <dialog>--<state>.card.png (2x card clip).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5327/harness/dialogs-wave3.html';
const LABEL = process.env.LABEL ?? 'before';
const OUT = (process.env.OUT ?? '/tmp/dialogs-wave3') + '/' + LABEL;
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = [];

async function scene(dialog, state, query, actions = async () => {}, opts = {}) {
    if (only.length && !only.includes(dialog)) return;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    try {
        await page.goto(`${BASE}?d=${dialog}${query ? '&' + query : ''}`, { timeout: 90000 });
        await page.waitForSelector('[role=dialog], .mcard', { timeout: 20000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(900);
        await actions(page);
        await page.mouse.move(3, 3);
        await page.waitForTimeout(700);
        const base = `${OUT}/${dialog}--${state}`;
        await page.screenshot({ path: `${base}.png` });
        const card = page.locator('.mcard').last();
        if (await card.count()) {
            const bb = await card.boundingBox();
            if (bb) await page.screenshot({ path: `${base}.card.png`, clip: { x: Math.max(0, bb.x - 24), y: Math.max(0, bb.y - 24), width: Math.min(1280, bb.width + 48), height: Math.min(800, bb.height + 48) } });
        }
        const info = await page.evaluate(() => {
            const c = document.querySelector('.mcard');
            const r = c?.getBoundingClientRect();
            return { card: r ? [Math.round(r.width), Math.round(r.height)] : null, foot: [...document.querySelectorAll('.mcard button')].map(b => b.textContent.trim()).filter(Boolean).slice(-4) };
        });
        results.push({ dialog, state, errs, ...info });
        console.log(`shot ${dialog}--${state}`, JSON.stringify(info), errs.length ? 'PAGEERRORS ' + errs.join(' | ') : '');
    } catch (e) {
        console.log(`FAILED ${dialog}--${state}: ${e.message.split('\n')[0]}`);
        try { await page.screenshot({ path: `${OUT}/${dialog}--${state}.FAILED.png` }); } catch {}
    } finally { await ctx.close(); }
}

const digits = async (page, s) => { await page.locator('.mcard input').first().focus(); await page.keyboard.type(s, { delay: 60 }); await page.waitForTimeout(500); };
const click = async (page, t) => { await page.locator(`button:has-text("${t}")`).first().click(); await page.waitForTimeout(500); };

// ── account / security ──
await scene('stepup', 'password', '');
await scene('stepup', 'totp-error', 'method=totp&err=1');
await scene('stepup', 'busy', 'busy=1');
await scene('restore', 'default', '');
await scene('restore', 'error-saved-pw', 'err=1&cur=1');
await scene('restore', 'busy', 'busy=1');
await scene('stale', 'default', '');
await scene('storage', 'default', '');
await scene('storage', 'error', 'err=1', async p => { await click(p, 'Save'); });
await scene('changepw', 'verify-email', '');
await scene('changepw', 'verify-totp', 'totp=1');
await scene('changepw', 'new-password', '', async p => { await p.waitForTimeout(600); await digits(p, '123456'); await p.waitForTimeout(1200);
    const v = p.locator('button:has-text("Verify")'); if (await v.count() && await v.first().isEnabled()) { await v.first().click(); await p.waitForTimeout(1200); } });
await scene('totp', 'email-code', '');
await scene('totp', 'qr', '', async p => { await p.waitForTimeout(500); await digits(p, '123456'); await p.waitForTimeout(1200); });
await scene('totp', 'enter-code', '', async p => { await p.waitForTimeout(500); await digits(p, '123456'); await p.waitForTimeout(1200); await click(p, 'scanned'); });
await scene('totp', 'warning', '', async p => { await p.waitForTimeout(500); await digits(p, '123456'); await p.waitForTimeout(1200); await click(p, 'scanned'); await p.waitForTimeout(300); await digits(p, '654321'); await p.waitForTimeout(1500); });
await scene('totp', 'backup-codes', '', async p => { await p.waitForTimeout(500); await digits(p, '123456'); await p.waitForTimeout(1200); await click(p, 'scanned'); await p.waitForTimeout(300); await digits(p, '654321'); await p.waitForTimeout(1500); await click(p, 'understand'); await p.waitForTimeout(600); });
await scene('safety', 'default', '');
await scene('safety', 'error', 'fail=1');
await scene('devapprove', 'default', '');
await scene('devapprove', 'reset-requested', 'reset=1');
await scene('devapprove', 'code-mismatch', '', async p => { await p.waitForTimeout(400); await digits(p, '111111'); await click(p, 'Approve'); await p.waitForTimeout(900); });
await scene('devremoved', 'default', '');
await scene('history', 'ready', '');
await scene('history', 'checking', 'verdict=checking');
await scene('history', 'refused', 'verdict=refused');
await scene('history', 'error', 'verdict=error');
await scene('screenlock', 'choose-length', '', async p => { await click(p, 'Set up'); });
await scene('screenlock', 'enter-pin', '', async p => { await click(p, 'Set up'); await p.locator(".mcard button[role=tab]").first().click(); await p.waitForTimeout(500); });
await scene('screenlock', 'disable', 'enabled=1', async p => { await click(p, 'Turn off'); });

// ── calls / other ──
await scene('picker', 'windows-screens', '');
await scene('picker', 'windows-windows', 'tab=window');
await scene('picker', 'mac-permission-note', 'platform=darwin');
await scene('picker', 'linux-grid', 'platform=linux');
await scene('upgradeRequired', 'default', '');
await scene('upgradeRequired', 'restart-failed', 'quitfail=1', async p => { await click(p, 'Restart'); await p.waitForTimeout(500); });

await browser.close();
console.log(`\n${results.length} scenes captured -> ${OUT}`);
