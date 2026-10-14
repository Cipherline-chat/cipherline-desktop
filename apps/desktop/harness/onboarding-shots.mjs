// Onboarding invite LinkBox centring + privacy pointer parallax, in real Chromium.
//
//   npx vite --config harness/onboarding.vite.config.ts      (serves :5391)
//   node harness/onboarding-shots.mjs                        (env: OUT=<dir> BASE=<origin> PW_CHROMIUM_EXE=<path> MEASURE_ONLY=1)
//
// Widths: 1280 (normal), 1000 (the window's minWidth in electron/main.ts), 760 (below the minimum; measure only).
// Geometry: the visible Copy-link button (cap plus its two depth sheets) is
// centred on the .lbox row's content box, in the "Copy link" / "Copied" /
// loading-skeleton states, at normal and narrow widths. Parallax: moving the
// pointer left vs right over the privacy step changes the rendered dots;
// hovering a toggle does not re-run the entrance. Reduced motion: no change.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5391';
const OUT = process.env.OUT ?? '/tmp/ob-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

/** Vertical offsets, in CSS px, between the row's content-box centre and the visible button. */
async function measure(page) {
    return page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const box = q('[data-ob-link] .lbox');
        const clb = box.querySelector('.clb');
        const cap = clb.querySelector('.cap');
        const lay = [...clb.querySelectorAll('.l')].filter((l) => getComputedStyle(l).display !== 'none');
        const inner = cap.querySelector('.ob-inv-btn');
        const r = (el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, mid: (b.top + b.bottom) / 2 }; };
        const bx = r(box), cs = getComputedStyle(box);
        const padT = parseFloat(cs.paddingTop), padB = parseFloat(cs.paddingBottom), bw = parseFloat(cs.borderTopWidth);
        const contentMid = (bx.top + bw + padT + bx.bottom - bw - padB) / 2;
        const capR = r(cap);
        const lowest = Math.max(capR.bottom, ...lay.map((l) => r(l).bottom));
        const visMid = (capR.top + lowest) / 2;
        const url = r(box.querySelector('.lbox-url'));
        const sp = (a, b) => ({ iconMid: a, textMid: b });
        const svg = inner && inner.querySelector('svg');
        return {
            row: bx, capR, lowest, contentMid,
            capOffset: capR.mid - contentMid,          // the cap alone vs the row
            visibleOffset: visMid - contentMid,        // cap + depth sheets vs the row
            urlOffset: url.mid - contentMid,
            innerOffset: inner ? r(inner).mid - capR.mid : null,
            iconOffset: svg ? r(svg).mid - r(inner).mid : null,
            display: inner && getComputedStyle(inner).display,
            alignItems: cs.alignItems,
            clbDisplay: getComputedStyle(clb).display,
        };
    });
}

try {
    // ---------------- invite LinkBox ----------------
    const states = [['copy', 'Copy link'], ['copied', 'Copied'], ['loading', 'loading skeleton']];
    if (!process.env.PRIVACY_ONLY) for (const [label, width] of [['normal', 1280], ['narrow', 1000], ['squeezed', 760]]) {
        for (const [state] of states) {
            const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
            const page = await ctx.newPage();
            page.setDefaultTimeout(180000);
            await page.goto(`${BASE}/?ob-harness=invite${state === 'loading' ? '&referral=pending' : ''}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-ob-link] .lbox .clb', { state: 'attached' });
            await sleep(1500);
            if (state === 'copied') {
                // (a script click: below the app's 1000px minimum window width the viz column overlaps the copy column)
                await page.evaluate(() => document.querySelector('[data-ob-link] .clb .cap').click());
                await page.waitForSelector('[data-ob-link] .clb.is-done');
                await page.mouse.move(2, 2);
                await sleep(800);
            }
            const m = await measure(page);
            const tag = `${label}/${state}`;
            console.log(tag, JSON.stringify({ cap: m.capOffset.toFixed(2), visible: m.visibleOffset.toFixed(2), url: m.urlOffset.toFixed(2), inner: m.innerOffset?.toFixed(2), icon: m.iconOffset?.toFixed(2), rowH: m.row.h.toFixed(1) }));
            check(`${tag}: visible button (cap + ledge) centred in the row (within 0.75px)`, Math.abs(m.visibleOffset) <= 0.75, `off=${m.visibleOffset.toFixed(2)}`);
            check(`${tag}: URL text centred (within 1px)`, Math.abs(m.urlOffset) <= 1, `off=${m.urlOffset.toFixed(2)}`);
            check(`${tag}: icon + label centred in the cap (within 1px)`, Math.abs(m.innerOffset ?? 99) <= 1 && Math.abs(m.iconOffset ?? 99) <= 1);
            await page.locator('[data-ob-link]').screenshot({ path: `${OUT}/invite-linkbox-${state}-${label}.png` });
            await ctx.close();
        }
    }

    // ---------------- privacy: pointer parallax ----------------
    if (!process.env.LINKBOX_ONLY) {
        const privacyPage = async (query) => {
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
            const page = await ctx.newPage();
            page.setDefaultTimeout(180000);
            // count GPU buffer uploads: a morph / snap (a scene being (re)started) uploads; the camera does not
            await page.addInitScript(() => {
                window.__uploads = 0;
                const orig = WebGLRenderingContext.prototype.bufferSubData;
                WebGLRenderingContext.prototype.bufferSubData = function (...a) { window.__uploads++; return orig.apply(this, a); };
            });
            await page.goto(`${BASE}/?ob-harness=privacy${query}`, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('[data-ob-step="privacy"] .viz');
            await sleep(4500);   // the entrance morph (1.5 s) + tags (0.9 s) + settle
            return { ctx, page };
        };
        const uploads = (page) => page.evaluate(() => window.__uploads);
        // the dot column only: the left column's hover styles must not count as a pointer reaction
        // The dot tags are projected from the camera every frame (DotTagLayer -> field.project), so their
        // screen positions are an exact, noise-free read of the cloud's tilt. (Raw screenshots are never
        // identical twice: the shell has ambient animation of its own.)
        const grab = async (page) => page.evaluate(() => [...document.querySelectorAll('.tag3d')]
            .map((el) => { const r = el.getBoundingClientRect(); return [el.dataset.t, +r.left.toFixed(2), +r.top.toFixed(2)]; }));
        const moved = (a, b) => a.length > 0 && a.length === b.length && a.some((t, i) => Math.abs(t[1] - b[i][1]) > 2 || Math.abs(t[2] - b[i][2]) > 2);

        // normal motion: left vs right differ; hovering the toggles restarts nothing
        {
            const { ctx, page } = await privacyPage('');
            const u0 = await uploads(page);
            await page.mouse.move(80, 400, { steps: 12 }); await sleep(4500);
            await page.screenshot({ path: `${OUT}/privacy-pointer-left.png` });
            const left = await grab(page);
            await page.mouse.move(1200, 400, { steps: 12 }); await sleep(4500);
            await page.screenshot({ path: `${OUT}/privacy-pointer-right.png` });
            const right = await grab(page);
            check('privacy: dots tilt with the pointer (tag anchors move left vs right)', moved(left, right), JSON.stringify([left[0], right[0]]));
            check('privacy: pointer movement alone uploads no scene (0 buffer uploads)', (await uploads(page)) === u0, `uploads ${u0} -> ${await uploads(page)}`);
            // sweep over every toggle, hover, no click
            const toggles = await page.locator('[data-ob-step="privacy"] .row').all();
            for (const t of toggles) { await t.hover(); await sleep(150); await page.mouse.move(660, 300, { steps: 6 }); }
            await sleep(800);
            check('privacy: hovering the toggle rows restarts / reloads nothing (still 0 uploads)', (await uploads(page)) === u0, `uploads ${u0} -> ${await uploads(page)}`);
            // positive control: a real toggle press DOES morph the scene
            await page.locator('[data-ob-step="privacy"] [data-row="receipts"] [role="switch"], [data-ob-step="privacy"] [data-row="receipts"] button').first().click();
            await sleep(1200);
            check('privacy: positive control, pressing a toggle does change the scene (uploads grew)', (await uploads(page)) > u0, `uploads ${u0} -> ${await uploads(page)}`);
            await ctx.close();
        }
        // reduced motion: the pointer moves nothing
        {
            const { ctx, page } = await privacyPage('&rm=1');
            await page.mouse.move(80, 400, { steps: 12 }); await sleep(4500);
            const left = await grab(page);
            await page.mouse.move(1200, 400, { steps: 12 }); await sleep(4500);
            const right = await grab(page);
            check('privacy + reduced motion: no pointer reaction (tag anchors do not move)', left.length > 0 && !moved(left, right), JSON.stringify([left[0], right[0]]));
            await ctx.close();
        }
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
