// New Message dialog: behaviour checks + screenshots, real Chromium at 1280x800 @2x.
//
//   npx vite --config harness/new-message.vite.config.ts      (serves :5311)
//   node harness/new-message-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Shots: 01 default · 02 search · 03 keyboard highlight · 04 single pick + group link · 05 empty search ·
//        06 no friends · 07 load error · 08 reduced motion (default state, no animation)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5311/harness/new-message.html';
const OUT = process.env.OUT ?? '/tmp/new-message-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const INPUT = 'input[role=combobox]';

async function open(query = '', opts = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, reducedMotion: opts.reducedMotion ?? 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query);
    await page.waitForSelector('[role=dialog]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(900);
    return { ctx, page };
}
const state = (page) => page.evaluate(() => {
    const input = document.querySelector('input[role=combobox]');
    const active = input?.getAttribute('aria-activedescendant');
    const opt = active ? document.getElementById(active) : null;
    return {
        focused: document.activeElement === input,
        activeName: opt?.querySelector('.pp-name')?.textContent ?? null,
        heads: [...document.querySelectorAll('.pp-section-head')].map(h => h.textContent),
        names: [...document.querySelectorAll('[role=option] .pp-name')].map(n => n.textContent),
        chips: [...document.querySelectorAll('.pp-chip-label')].map(n => n.textContent),
        selected: [...document.querySelectorAll('[role=option][aria-selected=true] .pp-name')].map(n => n.textContent),
        primary: [...document.querySelectorAll('.dlg-foot-actions button')].map(b => b.textContent.trim()),
        hint: document.querySelector('.dlg-foot-hint')?.textContent ?? '',
        empty: document.querySelector('.pp-empty-title')?.textContent ?? null,
        placeholder: input?.getAttribute('placeholder'),
        calls: window.__calls, started: window.__started ?? null, group: window.__group ?? null,
    };
});

try {
    // ---- 01 default ----------------------------------------------------------
    {
        const { ctx, page } = await open();
        const s = await state(page);
        check('search autofocused', s.focused);
        check('placeholder is short + complete', s.placeholder === 'Search friends', s.placeholder);
        check('sections Recent → Online → Offline', s.heads.join('|').replace(/\d+/g, '#') === 'Recent#|Online#|Offline#', s.heads.join('|'));
        check('recent ordered by last message (Mira, tobias.k, Jun, Elena, leif)', s.names.slice(0, 5).join(',') === 'Mira,tobias.k,Jun,Elena,leif', s.names.slice(0, 5).join(','));
        check('first row highlighted', s.activeName === 'Mira');
        const tagged = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] *')]
            .filter(el => !el.closest('.sr-only') && [...el.childNodes].some(n => n.nodeType === 3 && /existing chat/i.test(n.textContent))).length);
        check('no visible "existing chat" tag (it is screen-reader-only now)', tagged === 0, String(tagged));
        check('footer = Cancel + disabled Open chat; group link on the left; no E2EE line', s.primary.join('|') === 'Cancel|Open chat' && /Start a group chat/.test(s.hint) && !/encrypted/i.test(s.hint), s.primary.join('|') + ' / ' + s.hint);
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/01-default.png` });
        // hover a row → action pill on that row
        await page.hover('[role=option][data-user-id="u-sana"]');
        await page.waitForTimeout(250);
        const pill = await page.locator('[data-user-id="u-sana"] .pp-action').textContent();
        check('hover shows "Start chat" on a friend with no chat', pill?.trim() === 'Start chat', pill);
        await page.hover('[role=option][data-user-id="u-mira"]');
        await page.waitForTimeout(250);
        const pill2 = await page.locator('[data-user-id="u-mira"] .pp-action').textContent();
        check('hover shows "Open chat" on a friend with a chat', pill2?.trim() === 'Open chat', pill2);
        await page.screenshot({ path: `${OUT}/01b-hover-open-chat.png` });
        await ctx.close();
    }
    // ---- 02 search -------------------------------------------------------------
    {
        const { ctx, page } = await open();
        await page.keyboard.type('an');
        await page.waitForTimeout(300);
        const s = await state(page);
        check('search: one flat list, prefix match ranked first (Ana before Sana)', s.heads.length === 0 && s.names.join(',') === 'Ana,Sana', s.names.join(','));
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/02-search.png` });
        await ctx.close();
    }
    // ---- 03 keyboard highlight + Enter opens (same call) -----------------------
    {
        const { ctx, page } = await open();
        await page.mouse.move(5, 5);
        for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(250);
        const s = await state(page);
        check('ArrowDown x6 lands on the 7th row', s.activeName === s.names[6], `${s.activeName} vs ${s.names[6]}`);
        await page.screenshot({ path: `${OUT}/03-keyboard-highlight.png` });
        await page.keyboard.press('ArrowUp');
        const up = await state(page);
        check('ArrowUp moves back one', up.activeName === s.names[5]);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(700);
        const after = await state(page);
        check('Enter opens via POST /conversations/dm {other_user_id}', after.calls.length === 1 && /\/conversations\/dm \{"other_user_id":"u-/.test(after.calls[0]), JSON.stringify(after.calls));
        check('onDMStarted got the chat', after.started?.type === 'dm' && after.started?.title === up.activeName, JSON.stringify(after.started));
        await ctx.close();
    }
    // ---- 04 single pick + group link ---------------------------------------------
    {
        const { ctx, page } = await open();
        await page.click('[role=option][data-user-id="u-mira"]');
        let s = await state(page);
        check('click picks (aria-selected), no chips/checkboxes, no network', s.chips.length === 0 && s.selected.join(',') === 'Mira' && s.calls.length === 0 && (await page.locator('.pp-check').count()) === 0);
        check('picked → primary "Open chat" enabled', s.primary[1] === 'Open chat' && !(await page.locator('.dlg-foot-actions button').nth(1).isDisabled()), s.primary.join('|'));
        await page.click('[role=option][data-user-id="u-jun"]');
        s = await state(page);
        check('a second pick replaces the first', s.selected.join(',') === 'Jun', s.selected.join(','));
        await page.hover('.dlg-foot-link');
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${OUT}/04-picked-group-link-hover.png` });
        await page.click('.dlg-foot-link');
        await page.waitForTimeout(300);
        s = await state(page);
        check('group link hands the picked friend to onStartGroup (no DM call)', Array.isArray(s.group) && s.group.map(g => g.username).join(',') === 'Jun' && s.calls.length === 0, JSON.stringify(s.group));
        await ctx.close();
    }
    // ---- 05 empty search ---------------------------------------------------------
    {
        const { ctx, page } = await open();
        await page.keyboard.type('zzq');
        await page.waitForTimeout(300);
        const s = await state(page);
        check('no-results state', s.empty?.includes('No friends match') && s.names.length === 0, s.empty);
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/05-empty-search.png` });
        await ctx.close();
    }
    // ---- 06 no friends ------------------------------------------------------------
    {
        const { ctx, page } = await open('?friends=none');
        const s = await state(page);
        check('no-friends state + "Add a friend" primary', s.empty === 'No friends yet' && s.primary.join('|') === 'Cancel|Add a friend', s.primary.join('|'));
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/06-no-friends.png` });
        await page.click('.dlg-foot-actions button:has-text("Add a friend")');
        await page.waitForTimeout(600);
        const dialogs = await page.locator('[role=dialog]').count();
        check('"Add a friend" opens the Add Friend dialog on top', dialogs === 2, String(dialogs));
        await ctx.close();
    }
    // ---- 07 load error --------------------------------------------------------------
    {
        const { ctx, page } = await open('?fail=1');
        const s = await state(page);
        check('load failure shows an error with retry (not "No friends")', s.empty === "Couldn't load your friends", s.empty);
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/07-load-error.png` });
        await ctx.close();
    }
    // ---- 08 reduced motion ---------------------------------------------------------------
    {
        const { ctx, page } = await open('', { reducedMotion: 'reduce' });
        await page.click('[role=option][data-user-id="u-jun"]');
        const vis = await page.evaluate(() => ({ card: getComputedStyle(document.querySelector('.mcard')).opacity, link: getComputedStyle(document.querySelector('.dlg-foot-link')).transitionDuration }));
        check('reduced motion: card fully visible at rest, group link has no transition', vis.card === '1' && /^0s$/.test(vis.link), JSON.stringify(vis));
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/08-reduced-motion.png` });
        await ctx.close();
    }
    // ---- 09 open failure ---------------------------------------------------------------------
    {
        const { ctx, page } = await open('?openfail=1');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(800);
        const err = await page.locator('[role=alert]').textContent().catch(() => null);
        check('open failure shows an inline error and keeps the dialog', !!err && /Couldn't open your chat with Mira/.test(err), err);
        await page.mouse.move(5, 5);
        await page.screenshot({ path: `${OUT}/09-open-error.png` });
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
