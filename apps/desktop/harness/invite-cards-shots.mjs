// Invite cards: the REAL ChatPane feed with server-invite messages, in real Chromium.
//
//   npx vite --config harness/invite-cards.vite.config.ts   (serves :5331)
//   node harness/invite-cards-shots.mjs                       (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Shots: the four card states (valid, loading, couldn't load + Retry, expired) and the
// sender's own invite-only messages, at 1000x720 / 1366x768 / 1920x1080 / 1280x800@1.5.
// Checks: every card shows something of what was sent; only a 404/400 says expired;
// a long channel of invites behind a 60-a-minute budget never shows expired or gives up.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5331/harness/invite-cards.html';
const OUT = process.env.OUT ?? '/tmp/invite-cards-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const cards = (page) => page.$$eval('[data-invite-state]', els => els.map(e => ({
    state: e.getAttribute('data-invite-state'),
    text: e.textContent.replace(/\s+/g, ' ').trim(),
    h: Math.round(e.getBoundingClientRect().height),
})));

async function open(qs, size, scale = 1) {
    const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    page.setDefaultTimeout(120000);
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(`${BASE}?${qs}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__booted);
    await page.waitForSelector('[data-invite-state]');
    return { ctx, page };
}
/** Scroll the feed so the last card is in view (the newest rows are at the bottom). */
const toBottom = (page) => page.evaluate(() => {
    let f = document.querySelector('[data-invite-state]');
    while (f && !(f.scrollHeight > f.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(f).overflowY))) f = f.parentElement;
    if (f) f.scrollTop = f.scrollHeight;
});

const SIZES = [
    ['1000x720', { width: 1000, height: 720 }, 1],
    ['1366x768', { width: 1366, height: 768 }, 1],
    ['1920x1080', { width: 1920, height: 1080 }, 1],
    ['1280x800@1.5', { width: 1280, height: 800 }, 1.5],
];

// ── 1. The four states (boom500 needs its quiet retries: 2 + 5 + 12 s) ──────────
{
    const { ctx, page } = await open('scene=states', SIZES[1][1]);
    await page.waitForTimeout(21_000);
    const c = await cards(page);
    console.log(JSON.stringify(c.map(x => x.state)));
    check('states: valid / loading / error / invalid', JSON.stringify(c.map(x => x.state)) === JSON.stringify(['valid', 'loading', 'error', 'invalid']));
    check('loading card shows the link', /Loading invite.*cipherline\.chat\/invite\/slow/.test(c[1]?.text ?? ''), c[1]?.text);
    check('error card: Couldn\'t load + link + Retry, no "expired"', /Couldn’t load this invite.*cipherline\.chat\/invite\/boom500.*Retry/.test(c[2]?.text ?? '') && !/expired/i.test(c[2]?.text ?? ''), c[2]?.text);
    check('only the 404 card says expired', c.filter(x => /expired/i.test(x.text)).length === 1 && /expired/i.test(c[3]?.text ?? ''));
    for (const [name, size, scale] of SIZES) {
        await page.setViewportSize(size);
        if (scale !== 1) continue; // the @1.5 shot needs its own context (below)
        await toBottom(page); await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/states-${name}.png` });
    }
    await ctx.close();
    const hi = await open('scene=states', SIZES[3][1], 1.5);
    await hi.page.waitForTimeout(21_000);
    await toBottom(hi.page); await hi.page.waitForTimeout(300);
    await hi.page.screenshot({ path: `${OUT}/states-1280x800@1.5.png` });
    await hi.ctx.close();
}

// ── 2. The sender's own invite-only messages (server channel and DM) ─────────────
for (const view of ['server', 'dm']) {
    for (const [name, size] of SIZES.slice(0, 2)) {
        const { ctx, page } = await open(`scene=sender&view=${view}`, size);
        await page.waitForTimeout(21_000);
        await toBottom(page); await page.waitForTimeout(300);
        const c = await cards(page);
        if (name === '1000x720') {
            console.log(view, JSON.stringify(c.map(x => x.state)));
            // s2 okOther, s3 okGuild (your own server), s4 boom500, s5 slow (never answers), s6 gone404, s7 Mira's okOther
            check(`${view}: sender's own cards = valid, joined, error, loading, invalid (+ Mira's valid)`,
                JSON.stringify(c.map(x => x.state)) === JSON.stringify(['valid', 'joined', 'error', 'loading', 'invalid', 'valid']));
            check(`${view}: every card has text and height`, c.every(x => x.text.length > 10 && x.h >= 40), JSON.stringify(c.map(x => [x.h, x.text.slice(0, 30)])));
            check(`${view}: no card that is not a server shows without its link`, c.filter(x => x.state !== 'valid' && x.state !== 'joined').every(x => /cipherline\.chat\/invite\//.test(x.text)));
        }
        await page.screenshot({ path: `${OUT}/sender-${view}-${name}.png` });
        await ctx.close();
    }
}

// ── 3. Send through the real composer: a bare invite link, sender's view ────────
{
    const { ctx, page } = await open('scene=states', SIZES[0][1]);
    const ta = page.locator('[data-chat-input]');
    await ta.click();
    await page.keyboard.type('https://cipherline.chat/invite/boom500', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await toBottom(page);
    let c = await cards(page);
    check('just sent: the sender sees his invite-only message at once, with the link', c.length === 5 && /cipherline\.chat\/invite\/boom500/.test(c[4]?.text ?? ''), c[4]?.text);
    await page.screenshot({ path: `${OUT}/sender-just-sent-loading-1000x720.png` });
    await page.waitForTimeout(21_000);
    c = await cards(page);
    check('...and when its lookup fails: still there, "Couldn\'t load" + link', c[4]?.state === 'error' && /cipherline\.chat\/invite\/boom500/.test(c[4]?.text ?? ''), c[4]?.text);
    await toBottom(page); await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/sender-just-sent-error-1000x720.png` });
    await ctx.close();
}

// ── 4. A long channel of invites behind a 60-a-minute budget ────────────────────
{
    const { ctx, page } = await open('scene=long', SIZES[1][1]);
    const seen = new Set();
    // Scroll up through the whole history (each page of 20 mounts as it is reached).
    for (let i = 0; i < 12; i++) {
        await page.evaluate(() => {
            let f = document.querySelector('[data-invite-state]');
            while (f && !(f.scrollHeight > f.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(f).overflowY))) f = f.parentElement;
            if (f) f.scrollTop = 0;
        });
        await page.waitForTimeout(1500);
        for (const x of await cards(page)) seen.add(x.state);
    }
    await page.screenshot({ path: `${OUT}/long-rate-limited-1366x768.png` });
    // The server window reopens: every card that was waiting fills in.
    await page.waitForTimeout(65_000);
    const after = await cards(page);
    for (const x of after) seen.add(x.state);
    const before = (await cards(page)).length;
    check('long: after the window reopens the waiting cards fill in (more than the 10 that fit the budget), none expired',
        after.filter(x => x.state === 'valid').length > 10 && after.every(x => x.state === 'valid' || x.state === 'loading'),
        `${after.filter(x => x.state === 'valid').length} valid of ${before}: ${[...new Set(after.map(x => x.state))].join(',')}`);
    const counts = await page.evaluate(() => window.__previewCalls);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const c = await cards(page);
    console.log('long: cards', c.length, 'requests', total, 'states seen', [...seen].join(','));
    check('long: no card ever says expired', !seen.has('invalid'));
    check('long: no card gave up ("couldn\'t load")', !seen.has('error'));
    check('long: hit the limit, then at most one request per code plus a few 429s', total > Object.keys(counts).length - 1 && total <= Object.keys(counts).length + 8, `${total} for ${Object.keys(counts).length} codes`);
    await page.screenshot({ path: `${OUT}/long-scrolled-1366x768.png` });
    await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
