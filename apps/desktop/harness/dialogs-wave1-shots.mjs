// Dialogs wave 1: screenshots of every dialog in the batch, real Chromium at 1280x800.
//
//   npx vite --config harness/dialogs-wave1.vite.config.ts    (serves :5312)
//   OUT=<dir>/before node harness/dialogs-wave1-shots.mjs     (env: BASE=... PW_CHROMIUM_EXE=... ONLY=name,name)
//
// Writes <OUT>/<scenario>.png (full page, dimmed app backdrop). Compose "before | after" sheets with
// harness/dialogs-wave1-sheets.mjs. Scenario names are stable between the before and after runs, so the
// actions below only use selectors / text that exist in both the old and the redesigned dialogs.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5312/harness/dialogs-wave1.html';
const OUT = process.env.OUT ?? '/tmp/dialogs-wave1-shots';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failures = 0;

/** [name, query, action(page)] */
const SCENARIOS = [
    ['addfriend', 'd=addfriend', null],
    ['addfriend-error', 'd=addfriend', async (p) => { await p.keyboard.type('nohash'); await p.keyboard.press('Enter'); }],
    ['creategroup', 'd=creategroup&pre=1', async (p) => { await p.locator('#create-group-name, input[aria-label="Group name"]').first().fill('Weekend Crew'); }],
    ['creategroup-empty', 'd=creategroup', null],
    ['addmembers', 'd=addmembers', null],
    ['addmembers-selected', 'd=addmembers', async (p) => { await p.getByText('Okoye', { exact: true }).first().click(); await p.getByText('Priya', { exact: true }).first().click(); }],
    ['addtogroup', 'd=addtogroup', null],
    ['shared-links', 'd=shared-links', null],
    ['shared-files', 'd=shared-files', null],
    ['shared-media', 'd=shared-media', null],
    ['closechat-dm', 'd=closechat-dm', null],
    ['closechat-group', 'd=closechat-group', null],
    ['unsaved', 'd=unsaved', null],
    ['confirmdialog', 'd=confirmdialog', null],
    ['solokick', 'd=solokick', null],
    ['crash', 'd=crash', null],
    ['gpu', 'd=gpu', null],
    ['purge', 'd=purge', null],
    ['purge-all', 'd=purge-all', null],
    ['purge-empty', 'd=purge-empty', null],
    ['danger-delete', 'd=danger', async (p) => { await p.getByText('Delete my account', { exact: false }).first().click(); }],
    ['danger-delete-totp', 'd=danger&totp=1', async (p) => { await p.getByText('Delete my account', { exact: false }).first().click(); await p.waitForTimeout(500); await p.locator('input[type=password]').fill('hunter2-correct-horse'); }],
    ['clconfirm-danger', 'd=clconfirm-danger', null],
    ['clconfirm-plain', 'd=clconfirm-plain', null],
    ['clconfirm-body', 'd=clconfirm-body', null],
    ['legacy', 'd=legacy', null],
];

try {
    for (const [name, query, action] of SCENARIOS) {
        if (ONLY && !ONLY.has(name)) continue;
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        page.setDefaultTimeout(60000);
        page.on('pageerror', e => { failures++; console.log(`PAGEERROR [${name}]`, e.message); });
        try {
            await page.goto(`${BASE}?${query}`);
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(1100);
            if (action) { await action(page); await page.waitForTimeout(900); }
            await page.mouse.move(2, 2);
            await page.screenshot({ path: `${OUT}/${name}.png` });
            console.log('shot', name);
        } catch (e) {
            failures++;
            console.log(`FAIL [${name}]`, String(e.message).split('\n')[0]);
            await page.screenshot({ path: `${OUT}/${name}.FAILED.png` }).catch(() => {});
        }
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL SHOT');
process.exit(failures ? 1 : 0);
