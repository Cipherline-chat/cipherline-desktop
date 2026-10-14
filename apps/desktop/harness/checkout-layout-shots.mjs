// In-app checkout layout: geometry checks + screenshots in real Chromium.
//
//   npx vite --config harness/checkout-layout.vite.config.ts      (serves :5251)
//   node harness/checkout-layout-shots.mjs                        (env: OUT=<dir> BASE=... CDP=http://127.0.0.1:9510)
//
// Connects over CDP when CDP is set (reuse ONE headless shell; see CLAUDE.md
// "Headless Chrome cleanup"), else launches its own and closes it.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5251/harness/checkout-layout.html';
const OUT = process.env.OUT ?? '/tmp/checkout-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = process.env.CDP
    ? await chromium.connectOverCDP(process.env.CDP)
    : await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function open(w, h, query = '') {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(150000); // first load runs Vite's dep optimiser
    page.on('pageerror', (e) => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await page.goto(`${BASE}${query}`);
    await page.waitForSelector('[data-testid="stripe-stub"]');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(2200); // the card's spring-in + the summary bubble settling
    return { ctx, page };
}

/** Rects + scroll facts for one layout. */
const measure = (page) => page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
    const q = (s) => document.querySelector(s);
    const layout = q('.ckt');
    const scroller = layout.dataset.layout === 'wide' ? q('.ckt-scroll') : layout;
    return {
        vw: innerWidth, vh: innerHeight, layout: layout.dataset.layout,
        card: r(q('.mcard.ckt-card')), footer: r(q('.ckt-footer')), summary: r(q('.ckt-summary')),
        form: r(q('.ckt-form')), stub: r(q('[data-testid="stripe-stub"]')),
        pay: r([...document.querySelectorAll('.ckt-footer button')].find((b) => /Pay|Confirm/.test(b.textContent))),
        close: r(q('.ckt-close')),
        unlock: r(q('[data-testid="checkout-unlock"]')),
        scroller: { sh: scroller.scrollHeight, ch: scroller.clientHeight, ov: getComputedStyle(scroller).overflowY },
        bodyScroll: document.documentElement.scrollHeight > innerHeight,
    };
});
const inView = (rc, m) => rc && rc.t >= -0.5 && rc.b <= m.vh + 0.5 && rc.l >= -0.5 && rc.r <= m.vw + 0.5;
const scrollEnd = (page) => page.evaluate(() => {
    const layout = document.querySelector('.ckt');
    const s = layout.dataset.layout === 'wide' ? document.querySelector('.ckt-scroll') : layout;
    s.scrollTop = s.scrollHeight;
});

const SIZES = [[1280, 800], [1080, 935], [900, 560]];
try {
    for (const [w, h] of SIZES) {
        const tag = `${w}x${h}`;
        // ---- collapsed Link ----
        {
            const { ctx, page } = await open(w, h);
            const m = await measure(page);
            check(`${tag}: two-column`, m.layout === 'wide');
            check(`${tag}: card fully inside the viewport (nothing clipped top/bottom)`, inView(m.card, m), JSON.stringify(m.card));
            check(`${tag}: Pay button + footer reachable on screen`, inView(m.pay, m) && inView(m.footer, m), `pay.b=${m.pay?.b} footer.b=${m.footer?.b} vh=${m.vh}`);
            check(`${tag}: Close button on screen`, inView(m.close, m));
            check(`${tag}: "Everything unlocks" line on screen (the pill the owner saw clipped)`, inView(m.unlock, m) && m.unlock.t >= m.card.t, JSON.stringify(m.unlock));
            check(`${tag}: form capped at 440px`, m.form.w <= 440.5, `w=${m.form.w}`);
            check(`${tag}: page itself does not scroll`, !m.bodyScroll);
            check(`${tag}: form scroll region is overflow-y:auto`, m.scroller.ov === 'auto', m.scroller.ov);
            await page.screenshot({ path: `${OUT}/checkout-${tag}.png` });
            await ctx.close();
        }
        // ---- Link expanded ("Save my information" open) ----
        {
            const { ctx, page } = await open(w, h, '?link=expanded');
            const m = await measure(page);
            check(`${tag} expanded: card inside the viewport`, inView(m.card, m), JSON.stringify(m.card));
            check(`${tag} expanded: Pay still on screen`, inView(m.pay, m) && inView(m.footer, m), `pay.b=${m.pay?.b} vh=${m.vh}`);
            const grew = m.scroller.sh > m.scroller.ch;
            console.log(`INFO  ${tag} expanded: scroller ${m.scroller.sh}px content in ${m.scroller.ch}px viewport (${grew ? 'scrolls' : 'fits'})`);
            await page.screenshot({ path: `${OUT}/checkout-${tag}-link-expanded.png` });
            await scrollEnd(page);
            await page.waitForTimeout(80);
            const end = await page.evaluate(() => {
                const el = document.querySelector('[data-testid="stub-link-expanded"]').getBoundingClientRect();
                const f = document.querySelector('.ckt-footer').getBoundingClientRect();
                return { elBottom: el.bottom, footerTop: f.top, footerBottom: f.bottom, vh: innerHeight };
            });
            check(`${tag} expanded: scrolled to the end, the whole Link box is above the footer and visible`, end.elBottom <= end.footerTop + 0.5, JSON.stringify(end));
            check(`${tag} expanded: footer did not move off-screen`, end.footerBottom <= end.vh + 0.5);
            await page.screenshot({ path: `${OUT}/checkout-${tag}-link-expanded-scrolled.png` });
            await ctx.close();
        }
    }

    // ---- narrow: one column, summary compact on top ----
    for (const [w, h] of [[700, 800], [520, 560]]) {
        const tag = `${w}x${h}`;
        const { ctx, page } = await open(w, h, '?link=expanded');
        const m = await measure(page);
        check(`${tag}: one column`, m.layout === 'narrow' && m.summary.w >= m.form.w && m.summary.b <= m.form.t + 1);
        check(`${tag}: card inside the viewport`, inView(m.card, m), JSON.stringify(m.card));
        check(`${tag}: sticky footer (Pay) on screen with the form taller than the window`, inView(m.pay, m) && m.scroller.sh > m.scroller.ch, `pay.b=${m.pay?.b} sh=${m.scroller.sh} ch=${m.scroller.ch}`);
        check(`${tag}: whole body is the scroller`, m.scroller.ov === 'auto');
        await page.screenshot({ path: `${OUT}/checkout-${tag}-narrow.png` });
        await scrollEnd(page);
        await page.waitForTimeout(80);
        const m2 = await measure(page);
        check(`${tag}: Pay still on screen after scrolling to the end`, inView(m2.pay, m2), `pay.b=${m2.pay?.b}`);
        await page.screenshot({ path: `${OUT}/checkout-${tag}-narrow-scrolled.png` });
        await ctx.close();
    }

    // ---- tax-confirm step ----
    for (const [w, h] of [[1080, 935], [900, 560]]) {
        const tag = `${w}x${h}`;
        const { ctx, page } = await open(w, h);
        await page.click('.ckt-footer button:has-text("Pay")');
        await page.waitForSelector('[data-testid="tax-confirm"]');
        await page.waitForTimeout(250);
        const m = await measure(page);
        check(`${tag} tax step: Confirm button and total on screen`, inView(m.pay, m) && inView(m.footer, m), `pay.b=${m.pay?.b} vh=${m.vh}`);
        const price = await page.$eval('[data-testid="checkout-price"]', (e) => e.textContent);
        check(`${tag} tax step: summary shows the exact total`, price === '$2.68/mo', price);
        await page.screenshot({ path: `${OUT}/checkout-${tag}-tax-confirm.png` });
        await ctx.close();
    }

    // ---- keyboard ----
    {
        const { ctx, page } = await open(1080, 935);
        const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.id || a.getAttribute('aria-label') || a.textContent?.trim().slice(0, 24) || a.tagName) : null; });
        check('focus lands in the card field once Stripe is ready', (await active()) === 'stub-card', await active());
        const order = [];
        for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); order.push(await active()); }
        console.log('INFO  Tab order from the card field: ' + JSON.stringify(order));
        check('Tab stays trapped in the dialog (never reaches the page behind)', order.every((x) => x !== 'opener'));
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        check('Esc closes the checkout', (await page.evaluate(() => window.__chk.closed)) === 1);
        await ctx.close();
    }
    {
        const { ctx, page } = await open(1080, 935);
        await page.evaluate(() => window.__stripeStub.escape());
        await page.waitForTimeout(200);
        check("Stripe's own Escape event closes the checkout too", (await page.evaluate(() => window.__chk.closed)) === 1);
        await ctx.close();
    }
} finally {
    if (!process.env.CDP) await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
