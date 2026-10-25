// Easter eggs: behaviour checks + screenshots, real Chromium at 1280x800 @2x.
//
//   npx vite --config harness/easter-eggs.vite.config.ts      (serves :5419)
//   node harness/easter-eggs-shots.mjs                        (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// Add a scene = add an entry to SCENES below and to easter-eggs-main.tsx.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5419/harness/easter-eggs.html';
const OUT = process.env.OUT ?? '/tmp/easter-eggs-shots';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

async function open(query, opts = {}) {
    const ctx = await browser.newContext({
        viewport: opts.viewport ?? { width: 1280, height: 800 },
        deviceScaleFactor: 2,
        reducedMotion: opts.reducedMotion ?? 'no-preference',
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.TIMEOUT ?? 120000));
    page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
    await page.goto(BASE + query, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(opts.settle ?? 900);
    return { ctx, page };
}

const SCENES = {
    async keys() {
        for (const [name, date] of [['keys-halloween', '2026-10-31T12:00:00'], ['keys-newyear', '2027-01-01T12:00:00']]) {
            const { ctx, page } = await open(`?scene=keys&date=${date}`, { viewport: { width: 760, height: 520 } });
            const hats = await page.evaluate(() => [...document.querySelectorAll('g.k2-costume')].map(g => g.getAttribute('data-costume')));
            check(`${name}: six explicit hats rendered (3 sizes x witch+party)`, hats.length === 6, hats.join(','));
            await page.screenshot({ path: `${OUT}/${name}.png` });
            await ctx.close();
        }
    },
    async gauge() {
        for (const [name, date] of [['halloween', '2026-10-31T12:00:00'], ['birthday', '2027-04-30T12:00:00']]) {
            const { ctx, page } = await open(`?scene=gauge&date=${date}`, { viewport: { width: 360, height: 860 } });
            const zones = await page.evaluate(() => [...document.querySelectorAll('.sd-zlab b')].map(b => b.textContent));
            if (name === 'halloween') check('Halloween zone names', zones.join('|') === 'Surface|Twilight|The Witching Hour|The Haunted Abyss', zones.join('|'));
            else check('birthday line in the footer', (await page.textContent('.sd-bday'))?.length > 0, await page.textContent('.sd-bday'));
            await page.screenshot({ path: `${OUT}/gauge-${name}.png` });
            await ctx.close();
        }
        const { ctx, page } = await open('?scene=gauge', { viewport: { width: 360, height: 860 } });
        await page.fill('input[aria-label="Find a setting"]', 'octopus');
        await page.waitForTimeout(400);
        const note = await page.textContent('.cl-fmsg');
        check('octopus → a note', note.length > 0, note);
        await page.screenshot({ path: `${OUT}/gauge-search-octopus.png` });
        await ctx.close();
        const off = await open('?scene=gauge&eggs=off', { viewport: { width: 360, height: 860 } });
        await off.page.fill('input[aria-label="Find a setting"]', 'octopus');
        await off.page.waitForTimeout(300);
        check('octopus with the switch off → no note', (await off.page.textContent('.cl-fmsg')) === '');
        await off.ctx.close();
    },
    async appearance() {
        const { ctx, page } = await open('?scene=appearance', { viewport: { width: 900, height: 700 } });
        const row = page.locator('.sd-row', { hasText: 'Easter eggs & playful touches' });
        check('toggle row present', (await row.count()) === 1);
        await row.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${OUT}/appearance-toggle.png` });
        const tog = row.locator('[role=switch], button, input').first();
        await tog.click();
        await page.waitForTimeout(300);
        const stored = await page.evaluate(async () => (await import('/src/utils/secureLocalStore.ts')).secureLocalStore.getItem('cipherline_easter_eggs'));
        check('turning it off stores "0"', stored === '0', String(stored));
        await ctx.close();
    },
    async status() {
        const { ctx, page } = await open('?scene=status', { viewport: { width: 520, height: 520 } });
        await page.click('button[title^="Status"]');
        await page.waitForTimeout(500);
        for (const n of ['Idle', 'Online', 'DND', 'Online', 'Offline', 'Online']) {
            await page.click(`button:has-text("${n}")`);
            await page.waitForTimeout(150);
        }
        const lab = await page.evaluate(() => [...document.querySelectorAll('p')].map(p => p.textContent).find(t => /deciding|dizzy|Whiplash|Decisions/.test(t ?? '')));
        check('label swapped for a pool line', !!lab, lab);
        await page.screenshot({ path: `${OUT}/status-flap.png` });
        await page.waitForTimeout(4300);
        check('label reverts', (await page.evaluate(() => [...document.querySelectorAll('p')].some(p => p.textContent === 'Status'))));
        await ctx.close();
    },
    async version() {
        const { ctx, page } = await open('?scene=version', { viewport: { width: 760, height: 280 } });
        for (let i = 0; i < 4; i++) { await page.click('#chip'); await page.waitForTimeout(120); }
        check('countdown after 4 taps', (await page.textContent('[role=status]')).includes('3 more taps to go…'));
        await page.screenshot({ path: `${OUT}/version-taps-countdown.png` });
        for (let i = 0; i < 3; i++) { await page.click('#chip'); await page.waitForTimeout(120); }
        await page.waitForSelector('[data-testid=keys-dev-badge]');
        check('badge after 7', true);
        await page.screenshot({ path: `${OUT}/version-taps-dev-mode.png` });
        await ctx.close();
        const off = await open('?scene=version&eggs=off', { viewport: { width: 760, height: 280 } });
        for (let i = 0; i < 8; i++) { await off.page.click('#chip'); await off.page.waitForTimeout(100); }
        check('switch off: no badge, no note', (await off.page.$('[data-testid=keys-dev-badge]')) === null && (await off.page.textContent('[role=status]')) === '');
        await off.ctx.close();
    },
    async composer() {
        const ph = async (q) => {
            const { ctx, page } = await open(`?scene=composer${q}`, { viewport: { width: 820, height: 320 } });
            const v = await page.getAttribute('textarea', 'placeholder');
            return { ctx, page, v };
        };
        const night = await ph('&date=2026-10-20T03:30:00');
        check('03:30 → late-night line', night.v === 'Shouldn’t you be asleep?' || /small hours|Still up|Sleep is also/.test(night.v), night.v);
        await night.page.screenshot({ path: `${OUT}/composer-late-night.png` });
        await night.ctx.close();
        const noon = await ph('&date=2026-10-20T12:30:00');
        check('12:30 → plain', noon.v === 'Message…', noon.v);
        await noon.ctx.close();
        const off = await ph('&date=2026-10-20T03:30:00&eggs=off');
        check('03:30 with the switch off → plain', off.v === 'Message…', off.v);
        await off.ctx.close();
    },
    async alone() {
        const ctx = await browser.newContext({ viewport: { width: 520, height: 300 }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        page.setDefaultTimeout(Number(process.env.TIMEOUT ?? 120000));
        page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
        await page.clock.install();
        await page.goto(BASE + '?scene=alone', { waitUntil: 'domcontentloaded' });
        await page.evaluate(() => document.fonts.ready);
        await page.clock.runFor(200);
        check('nothing at first', (await page.$('[data-testid=alone-echo]')) === null);
        await page.clock.runFor(4 * 60 * 1000 + 500);
        await page.waitForSelector('[data-testid=alone-echo]');
        check('opener', (await page.textContent('[data-testid=alone-echo]')).includes('…echo… echo…'));
        await page.screenshot({ path: `${OUT}/alone-echo-1.png` });
        await page.clock.runFor(6500 * 2);
        check('third line', (await page.textContent('[data-testid=alone-echo]')).includes('very quiet'));
        await page.screenshot({ path: `${OUT}/alone-echo-3.png` });
        await page.click('[data-testid=alone-echo] button');
        check('dismissed', (await page.$('[data-testid=alone-echo]')) === null);
        await ctx.close();
    },
    async konami() {
        const KON = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
        const { ctx, page } = await open('?scene=konami');
        check('nothing before the code', (await page.$('[data-testid=keys-party]')) === null);
        for (const k of KON) await page.keyboard.press(k);
        await page.waitForSelector('[data-testid=keys-party]');
        await page.waitForTimeout(2300);
        await page.screenshot({ path: `${OUT}/konami-party.png` });
        const where = await page.evaluate(() => document.querySelector('.egg-party-swimmer')?.getBoundingClientRect().left ?? -1);
        check('Keys is mid-swim (moved off the left edge)', where > 100, String(Math.round(where)));
        await page.waitForTimeout(4500);
        check('party removed itself', (await page.$('[data-testid=keys-party]')) === null);
        await ctx.close();

        const r = await open('?scene=konami', { reducedMotion: 'reduce' });
        for (const k of KON) await r.page.keyboard.press(k);
        await r.page.waitForSelector('[data-testid=keys-party]');
        await r.page.waitForTimeout(400);
        check('reduced motion: still variant, no swimmer', (await r.page.$('.egg-party--still')) !== null && (await r.page.$('.egg-party-swimmer')) === null);
        await r.page.screenshot({ path: `${OUT}/konami-reduced-motion.png` });
        await r.ctx.close();
    },
    async 'group-of-two'() {
        const { ctx, page } = await open('?scene=group-of-two');
        await page.fill('#create-group-name', 'Squad');
        await page.waitForTimeout(250);
        await page.screenshot({ path: `${OUT}/group-of-two-0-form.png` });
        await page.click('button[type=submit]');
        await page.waitForSelector('text=Open DM with Mira');
        await page.waitForTimeout(700);
        const t = await page.evaluate(() => document.body.innerText);
        check('dialog shows the owner copy', t.includes('That’s… a DM with extra steps.'));
        check('primary + secondary buttons', t.includes('Open DM with Mira') && t.includes('Make the group anyway'));
        const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
        check('focus is on the primary', /Open DM with Mira/.test(focused), focused);
        await page.screenshot({ path: `${OUT}/group-of-two-1-dialog.png` });
        await page.click('text=Open DM with Mira');
        await page.waitForTimeout(900);
        const st = await page.evaluate(() => ({ calls: window.__calls, opened: window.__opened, created: window.__created }));
        check('Open DM → POST dm only, host got the chat', st.calls.length === 1 && /POST dm/.test(st.calls[0]) && st.opened?.id === 'c-dm-new' && !st.created, JSON.stringify(st));
        await ctx.close();

        const b = await open('?scene=group-of-two');
        await b.page.fill('#create-group-name', 'Squad');
        await b.page.click('button[type=submit]');
        await b.page.waitForSelector('text=Make the group anyway');
        await b.page.click('text=Make the group anyway');
        await b.page.waitForTimeout(900);
        const st2 = await b.page.evaluate(() => ({ calls: window.__calls, opened: window.__opened, created: window.__created }));
        check('anyway → POST group only', st2.calls.length === 1 && /POST group/.test(st2.calls[0]) && !st2.opened && st2.created?.id === 'g-new', JSON.stringify(st2));
        await b.ctx.close();

        const c = await open('?scene=group-of-two&openfail=1');
        await c.page.fill('#create-group-name', 'Squad');
        await c.page.click('button[type=submit]');
        await c.page.waitForSelector('text=Open DM with Mira');
        await c.page.click('text=Open DM with Mira');
        await c.page.waitForSelector('[role=alert]');
        await c.page.waitForTimeout(500);
        check('failed DM: inline error, dialog still up', (await c.page.evaluate(() => document.body.innerText)).includes('Make the group anyway'));
        await c.page.screenshot({ path: `${OUT}/group-of-two-2-error.png` });
        await c.ctx.close();

        const d = await open('?scene=group-of-two', { reducedMotion: 'reduce' });
        await d.page.fill('#create-group-name', 'Squad');
        await d.page.click('button[type=submit]');
        await d.page.waitForSelector('text=Open DM with Mira');
        await d.page.waitForTimeout(500);
        await d.page.screenshot({ path: `${OUT}/group-of-two-3-reduced-motion.png` });
        await d.ctx.close();
    },
};

try {
    for (const [name, fn] of Object.entries(SCENES)) {
        if (ONLY && !ONLY.has(name)) continue;
        console.log('--- ' + name);
        await fn();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
