// Gift Pro UI: behaviour checks + stills + frame sequences, in real Chromium.
//
//   npx vite --config harness/gifts.vite.config.ts      (serves :5617)
//   node harness/gifts-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Launches its own headless shell and closes it at the end (prints the PID so you
// can confirm nothing survives). Frames are deterministic: JS timers run on
// Playwright's fake clock and every CSS animation is paused + seeked by hand.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5617/harness/gifts.html';
const OUT = process.env.OUT ?? '/tmp/gift-shots';
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
console.log('BROWSER PID ' + (browser.process?.()?.pid ?? '?'));

async function open(query, { size = [480, 380], dpr = 2, reduced = false, clock = false } = {}) {
    const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, deviceScaleFactor: dpr, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000); // first load runs Vite's dep optimiser
    page.on('pageerror', (e) => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) console.log('console.error ' + m.text()); });
    // Belt and braces: nothing in this harness may reach a real API or Stripe.
    await page.route(/api\.cipherline\.chat|js\.stripe\.com|stripe\.network/, (r) => r.abort());
    if (clock) await page.clock.install();
    await page.goto(`${BASE}?${query}`);
    await page.evaluate(() => document.fonts.ready);
    return { ctx, page };
}
const shot = async (page, name, opts = {}) => { const f = `${OUT}/${name}.png`; await page.screenshot({ path: f, ...opts }); console.log('SHOT  ' + f); return f; };
const settle = (page, ms = 120) => page.waitForTimeout(ms);

try {
    // ---------- 1. every card state -----------------------------------------
    {
        const { ctx, page } = await open('scene=cards', { size: [1330, 1010], dpr: 1.5 });
        await page.waitForSelector('[data-kind="unopened"]');
        await page.waitForSelector('[data-kind="unavailable"]');
        await page.waitForSelector('[data-kind="error"]');
        await settle(page, 400);
        await page.evaluate(() => window.__gifts.seek(0, '.gb'));
        const kinds = await page.$$eval('[data-testid="gift-card"]', (els) => els.map((e) => e.dataset.kind));
        check('all eleven card states render', JSON.stringify(kinds) === JSON.stringify(['unopened', 'opened', 'opened', 'sent_waiting', 'sent_accepted', 'refunded', 'unavailable', 'error', 'loading', 'expired', 'expired']), kinds.join(','));
        const expiredTitles = await page.$$eval('[data-kind="expired"]', (els) => els.map((e) => e.textContent));
        check('expired: recipient card says it expired and was refunded', /This gift expired and was refunded/.test(expiredTitles[0] ?? ''), expiredTitles[0]);
        check('expired: sender card says refunded, not opened in 90 days', /Refunded — not opened in 90 days/.test(expiredTitles[1] ?? ''), expiredTitles[1]);
        const width = await page.$eval('[data-testid="gift-card"]', (e) => e.getBoundingClientRect().width);
        check('card is 340px wide', Math.round(width) === 340, String(width));
        const animated = await page.evaluate(() => [...new Set(document.getAnimations().flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)));
        check('card animations touch only transform/opacity (+ skeleton bg)', animated.every((p) => ['transform', 'opacity', 'backgroundPositionX', 'backgroundPositionY'].includes(p)), animated.join(','));
        await shot(page, '01-all-card-states', { fullPage: true });
        await ctx.close();
    }

    // ---------- 2. unopened close-ups: still, shimmer, wiggle -----------------
    {
        const { ctx, page } = await open('scene=unwrap', { size: [440, 330] });
        await page.waitForSelector('[data-kind="unopened"]');
        await settle(page, 300);
        await page.evaluate(() => window.__gifts.seek(0, '.gb'));
        await shot(page, '02-unopened-card');
        // shine sweep: 4.2 s delay, then ~1.3 s across
        for (const [t, n] of [[4200 + 380, 'a'], [4200 + 700, 'b']]) {
            await page.evaluate((ms) => window.__gifts.seek(ms, '.gb'), t);
            await settle(page, 60);
            await shot(page, `03-unopened-shimmer-${n}`, { clip: { x: 60, y: 30, width: 360, height: 150 } });
        }
        // wiggle peak: 1.2 s delay + 87% of 6 s
        await page.evaluate(() => window.__gifts.seek(1200 + 5220, '.gb'));
        await settle(page, 60);
        await shot(page, '04-unopened-wiggle', { clip: { x: 60, y: 30, width: 360, height: 150 } });
        // keyboard: Accept is reachable and shows a focus ring
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
        check('Tab reaches "Accept gift"', /Accept gift/.test(focused ?? ''), focused);
        const label = await page.$eval('[data-testid="gift-card"]', (e) => `${e.getAttribute('role')}|${e.getAttribute('aria-label')}`);
        check('card is a labelled group', label === 'group|Cipherline Pro gift', label);
        await ctx.close();
    }

    // ---------- 3. unwrap sequence ------------------------------------------
    {
        const { ctx, page } = await open('scene=unwrap', { size: [440, 330], clock: true });
        await page.waitForSelector('[data-kind="unopened"]');
        // install() lets time flow; freeze it so the 1.3 s settle timer waits for us.
        await page.clock.pauseAt(Date.now() + 60_000);
        await page.evaluate(() => window.__gifts.seek(0, '.gb'));
        const btn = await page.$('[data-testid="gift-card"] button');
        await btn.dblclick(); // double-click must redeem once
        // The welcome now waits for the unwrap's real animationend, which the fake
        // clock does not hold back: freeze the box's animations as soon as it starts.
        await page.waitForSelector('.gb[data-state="unwrapping"]');
        await page.evaluate(() => { for (const a of document.querySelector('.gb').getAnimations({ subtree: true })) a.pause(); });
        await page.click('[data-testid="gift-card"] button', { timeout: 500 }).catch(() => {});
        check('double/triple click redeems exactly once', (await page.evaluate(() => window.__gifts.redeemCalls)) === 1, String(await page.evaluate(() => window.__gifts.redeemCalls)));
        const dir = `${OUT}/unwrap-frames`;
        mkdirSync(dir, { recursive: true });
        const times = [0, 160, 300, 440, 580, 760, 940, 1300];
        const frames = [];
        for (const t of times) {
            if (t === 1300) {
                // Every frame before the last keyframe ends: nothing unlocked yet.
                check('refresh() not called before the unwrap finishes', (await page.evaluate(() => window.__refreshes)) === 0);
                check('Pro welcome NOT requested while the box is unwrapping', (await page.evaluate(() => window.__celebrations)) === 0);
            }
            await page.evaluate((ms) => window.__gifts.seek(ms, '.gb'), t);
            await settle(page, 50);
            frames.push(await shot(page, `unwrap-frames/u${String(t).padStart(4, '0')}`, { clip: { x: 60, y: 10, width: 360, height: 175 } }));
        }
        try {
            execFileSync('montage', [...frames, '-tile', '4x', '-geometry', '+4+4', '-background', '#05070d', `${OUT}/05-unwrap-strip.png`]);
            console.log('STRIP ' + `${OUT}/05-unwrap-strip.png`);
        } catch (e) { console.log('(montage unavailable: ' + e.message + ')'); }
        // Seeking to the end IS the unwrap ending: its animationend (not the
        // frozen fallback timer) is what asks for the welcome.
        await settle(page, 200);
        check('Pro welcome requested once the unwrap actually ended (animationend, clock frozen)', (await page.evaluate(() => window.__celebrations)) === 1);
        await page.clock.runFor(1800);
        await page.waitForSelector('[data-kind="opened"]');
        await settle(page, 700); // the text reveal (real time)
        await page.evaluate(() => window.__gifts.seek(0, '.gb-halo'));
        check('subscription refreshed after the unwrap (Pro unlocks)', (await page.evaluate(() => window.__refreshes)) === 1);
        check('Pro welcome requested exactly once, after the unwrap', (await page.evaluate(() => window.__celebrations)) === 1);
        const announced = await page.$eval('[role="status"]', (e) => e.textContent);
        check('accept is announced to screen readers', /Gift accepted\. Pro until/.test(announced ?? ''), announced);
        await shot(page, '06-opened-card');
        // a gift:updated push re-reads (state stays opened, no second animation)
        await page.evaluate((gid) => window.__gifts.emit(gid), '11111111-1111-4111-8111-000000000001');
        await settle(page, 200);
        check('gift:updated refetch keeps the opened state', (await page.$eval('.gb', (e) => e.dataset.state)) === 'open');
        check('a refetch does not replay the Pro welcome', (await page.evaluate(() => window.__celebrations)) === 1);
        await ctx.close();
    }

    // ---------- 4. purchase success burst -----------------------------------
    {
        const { ctx, page } = await open('scene=success&card=sent', { size: [760, 640], dpr: 1.5 });
        await page.waitForSelector('[data-testid="gift-success"]');
        await settle(page, 600); // modal spring-in transition
        const dir = `${OUT}/success-frames`;
        mkdirSync(dir, { recursive: true });
        const frames = [];
        for (const t of [0, 180, 360, 540, 700, 860, 1040, 1250, 1500]) {
            await page.evaluate((ms) => window.__gifts.seek(ms, '.gft-done'), t);
            await settle(page, 50);
            frames.push(await shot(page, `success-frames/s${String(t).padStart(4, '0')}`));
        }
        try {
            execFileSync('montage', [...frames.slice(0, 8), '-tile', '4x', '-geometry', '380x320+4+4', '-background', '#05070d', `${OUT}/07-success-strip.png`]);
            console.log('STRIP ' + `${OUT}/07-success-strip.png`);
        } catch (e) { console.log('(montage unavailable: ' + e.message + ')'); }
        await page.evaluate(() => window.__gifts.seek(3000, '.gft-done'));
        await settle(page, 60);
        await shot(page, '08-success-rest');
        await ctx.close();
    }
    {
        const { ctx, page } = await open('scene=success&card=failed', { size: [760, 640], dpr: 1.5 });
        await page.waitForSelector('[data-testid="gift-success"]');
        await settle(page, 600);
        await page.evaluate(() => window.__gifts.seek(3000, '.gft-done'));
        await settle(page, 60);
        await shot(page, '09-success-card-failed');
        await ctx.close();
    }
    {
        const { ctx, page } = await open('scene=slow', { size: [760, 560], dpr: 1.5 });
        await page.waitForSelector('.gft-wait');
        await settle(page, 600);
        await shot(page, '10-slow-finishing-up');
        await ctx.close();
    }

    // ---------- 5. Settings section -----------------------------------------
    {
        const { ctx, page } = await open('scene=section', { size: [820, 760], dpr: 1.5 });
        await page.waitForSelector('[data-testid="gift-row"]');
        await settle(page, 300);
        const rows = await page.$$eval('[data-testid="gift-row"]', (els) => els.length);
        check('section lists 4 sent + 2 received', rows === 6, String(rows));
        const resend = await page.$$eval('[data-testid="gift-row"] button', (els) => els.map((e) => e.textContent.trim()).filter((t) => /Resend/.test(t)).length);
        check('only the waiting sent gift offers "Resend card"', resend === 1, String(resend));
        const chips = await page.$$eval('[data-testid="gifts-section"]', (els) => els.map((e) => e.textContent).join(' '));
        check('Settings: Sent shows "Refunded — not opened in 90 days"', chips.includes('Refunded — not opened in 90 days'));
        await shot(page, '11-settings-section', { fullPage: true });
        await page.click('text=Resend card');
        await page.waitForSelector('.gft-resend-note--ok');
        check('Resend card calls sendGiftCard', (await page.evaluate(() => window.__gifts.sendCalls)) === 1);
        await ctx.close();
    }
    // GIFTS_ENABLED off on the server: no "Gift Pro" button; with nothing sent or
    // received the whole section stays hidden.
    {
        const { ctx, page } = await open('scene=section&gifts=off', { size: [820, 760], dpr: 1.5 });
        await page.waitForSelector('[data-testid="gift-row"]');
        await settle(page, 300);
        check('gifts off: no "Gift Pro to a friend" button', (await page.$$('text=Gift Pro to a friend')).length === 0);
        await ctx.close();
        const e = await open('scene=section&gifts=off&data=empty', { size: [820, 360], dpr: 1.5 });
        await settle(e.page, 900);
        check('gifts off + nothing to list: section hidden', (await e.page.$$('[data-testid="gifts-section"]')).length === 0);
        await e.ctx.close();
    }
    for (const data of ['empty', 'error', 'loading']) {
        const { ctx, page } = await open(`scene=section&data=${data}`, { size: [820, 360], dpr: 1.5 });
        await page.waitForSelector('[data-testid="gifts-section"]');
        await settle(page, 400);
        await shot(page, `12-settings-section-${data}`);
        await ctx.close();
    }

    // ---------- 6. purchase modal, pick step --------------------------------
    {
        const { ctx, page } = await open('scene=pick', { size: [900, 860], dpr: 1.5 });
        await page.waitForSelector('[data-testid="gift-lengths"]');
        await settle(page, 600);
        const cont = await page.$eval('.gft-m-foot button', (b) => b.disabled);
        check('Continue disabled until a friend is picked', cont === true);
        await shot(page, '13-pick-empty');
        await page.fill('input[aria-label="Search friends"]', 'a');
        await page.click('.gft-friend:has-text("Alex")');
        await page.click('.gft-len-opt:has-text("12 months")');
        await settle(page, 300);
        const label = await page.$eval('.gft-m-foot button', (b) => b.textContent.trim());
        check('Continue quotes the 12-month price + tax', /\$49\.99 \+ tax/.test(label), label);
        const fine = await page.$eval('.gft-fine', (e) => e.textContent);
        check('fine print names the friend, says one-time, promises the 90-day refund', fine === 'One-time payment. Nothing renews. Alex can accept it from your DM. If it isn’t opened within 90 days, you’ll be refunded automatically.', fine);
        await shot(page, '14-pick-selected');
        // Esc on the pick step closes (nothing in flight)
        await page.keyboard.press('Escape');
        await settle(page, 400);
        check('Esc closes the modal when nothing is in flight', (await page.$('.gft-modal')) === null);
        await ctx.close();
    }

    // ---------- 7. reduced motion --------------------------------------------
    {
        const { ctx, page } = await open('scene=unwrap', { size: [440, 330], reduced: true, clock: true });
        await page.waitForSelector('[data-kind="unopened"]');
        await page.clock.pauseAt(Date.now() + 60_000);
        const idle = await page.evaluate(() => document.querySelector('.gb').getAnimations({ subtree: true }).length);
        check('reduced motion: the unopened box does not move', idle === 0, String(idle));
        await page.click('[data-testid="gift-card"] button');
        // Owner 2026-11-18: reduced motion still shows the box opening first, as an
        // opacity-only cross-fade, and only then unlocks + asks for the welcome.
        await page.waitForSelector('.gb[data-state="unwrapping"][data-motion="fade"]', { timeout: 2000 });
        await page.evaluate(() => { for (const a of document.querySelector('.gb').getAnimations({ subtree: true })) a.pause(); });
        const props = await page.evaluate(() => [...new Set(document.querySelector('.gb').getAnimations({ subtree: true }).flatMap((a) => a.effect.getKeyframes().flatMap((k) => Object.keys(k))))].filter((k) => !['offset', 'computedOffset', 'easing', 'composite'].includes(k)));
        check('reduced motion: the unwrap is a cross-fade that animates opacity only', props.length > 0 && props.every((p) => p === 'opacity'), props.join(','));
        check('reduced motion: Pro welcome NOT requested during the fade', (await page.evaluate(() => window.__celebrations)) === 0);
        await page.evaluate(() => window.__gifts.seek(450, '.gb'));
        await settle(page, 60);
        await shot(page, '15a-reduced-motion-fade-mid');
        await page.evaluate(() => { for (const a of document.querySelector('.gb').getAnimations({ subtree: true })) a.play(); });
        await page.clock.runFor(1400);
        await page.waitForSelector('[data-kind="opened"]', { timeout: 3000 });
        check('reduced motion: Pro unlocks after the fade', (await page.evaluate(() => window.__refreshes)) === 1);
        check('reduced motion: Pro welcome requested once, after the fade', (await page.evaluate(() => window.__celebrations)) === 1);
        await shot(page, '15-reduced-motion-opened');
        await ctx.close();
    }
    {
        const { ctx, page } = await open('scene=success&card=sent', { size: [760, 640], dpr: 1.5, reduced: true });
        await page.waitForSelector('[data-testid="gift-success"]');
        await settle(page, 600);
        const conf = await page.$$eval('.gb-c', (e) => e.length);
        check('reduced motion: no confetti', conf === 0, String(conf));
        await shot(page, '16-reduced-motion-success');
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
