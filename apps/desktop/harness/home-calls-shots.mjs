// Home "Happening now" screenshots + live checks (real Chromium). Needs the harness server:
//   npx vite --config harness/home-calls.vite.config.ts      (serves :5341, HC_PORT to change)
//   node harness/home-calls-shots.mjs <outDir>
//     env: BASE, PW_CORE, PW_CHROMIUM_EXE
// Writes <width>-n<count>[-mine][-expanded].png (full window) and the same with
// -tile (the tile alone), at 1280 and 1920 window widths, and checks: one tile
// whatever the call count, <= the fold limit of rows collapsed, "+N more"
// expands in place and collapses back, row height, server truncates before the
// call name, no horizontal overflow, reduced motion has no reveal animation.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5341/harness/home-calls.html';
const OUT = process.argv[2] ?? '/tmp/home-calls-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    async function open(width, query, reducedMotion = 'no-preference') {
        const height = width >= 1920 ? 1080 : 800;
        const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion, colorScheme: 'dark' });
        const page = await ctx.newPage();
        page.setDefaultTimeout(120000);
        page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
        await page.goto(`${BASE}?${query}`);
        await page.waitForFunction(() => window.__booted === true);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForSelector('.hd-deck');
        await page.waitForTimeout(1800); // deck entry animations
        return { ctx, page };
    }
    const facts = page => page.evaluate(() => {
        const tiles = document.querySelectorAll('[data-testid="home-calls-tile"]');
        const rows = [...document.querySelectorAll('[data-testid="home-call-row"]')];
        const more = document.querySelector('[data-testid="home-calls-more"]');
        const list = document.querySelector('.hd-calls');
        const host = document.querySelector('.hd-host');
        const tile = tiles[0];
        return {
            tiles: tiles.length,
            heads: tile ? tile.querySelectorAll('h2').length : 0,
            rows: rows.length,
            rowH: rows.map(r => Math.round(r.getBoundingClientRect().height)),
            names: rows.map(r => r.querySelector('.hd-call-name')?.textContent),
            more: more?.textContent ?? null,
            cols: list?.getAttribute('data-cols') ?? null,
            listW: list ? Math.round(list.getBoundingClientRect().width) : 0,
            tileH: tile ? Math.round(tile.getBoundingClientRect().height) : 0,
            tileW: tile ? Math.round(tile.getBoundingClientRect().width) : 0,
            deckW: Math.round(document.querySelector('.hd-deck').getBoundingClientRect().width),
            // Not host.scrollWidth: the mascot rig's ink already pokes past the
            // host's padding (clipped by its overflow-x:hidden) with no calls at all.
            hostOverflow: tile ? Math.round(tile.getBoundingClientRect().right - document.querySelector('.hd-deck').getBoundingClientRect().right) : 0,
            rowOverflow: rows.filter(r => r.scrollWidth > r.clientWidth + 1).map(r => `${r.scrollWidth}>${r.clientWidth}`),
            trunc: rows.map(r => {
                const n = r.querySelector('.hd-call-name'); const s = r.querySelector('.hd-call-srv');
                return { name: n.scrollWidth > n.clientWidth, srv: s.scrollWidth > s.clientWidth, srvW: s.clientWidth, title: r.querySelector('.hd-call-open').title };
            }),
            solo: rows.length === 1 && rows[0].classList.contains('hd-call--solo'),
            rowBg: rows.map(r => getComputedStyle(r).backgroundColor),
            // Avatar slot: avatars start at the slot's left edge, and the slot
            // is never wider than the widest stack actually drawn.
            stackGap: (() => {
                const ext = rows.map(r => {
                    const kids = [...r.querySelector('.hd-call-stack').children];
                    if (!kids.length) return 0;
                    return kids[kids.length - 1].getBoundingClientRect().right - kids[0].getBoundingClientRect().left;
                });
                const maxExt = Math.max(0, ...ext);
                return rows.map((r, i) => {
                    const s = r.querySelector('.hd-call-stack').getBoundingClientRect();
                    const first = r.querySelector('.hd-call-stack').children[0]?.getBoundingClientRect();
                    const name = r.querySelector('.hd-call-name').getBoundingClientRect();
                    const pad = Math.round(s.width - ext[i]);
                    const gapToName = Math.round(name.left - (s.left + ext[i]));
                    const ok = (!first || Math.abs(first.left - s.left) <= 1) && s.width <= maxExt + 1
                        && (rows.length > 1 || pad <= 1);
                    return { ok, slot: Math.round(s.width), ext: Math.round(ext[i]), pad, gapToName };
                });
            })(),
            mineFirst: rows[0]?.getAttribute('data-mine') === 'true',
            mineHasJoin: !!document.querySelector('[data-mine] button.hd-btn'),
            pinnedTop: Math.round(document.querySelector('.hd-a--lavender')?.getBoundingClientRect().top ?? 0),
        };
    });
    const tileShot = (page, path) => page.locator('[data-testid="home-calls-tile"]').screenshot({ path });

    for (const width of [1280, 1920]) {
        for (const [n, mine] of [[1, 0], [3, 0], [8, 0], [8, 1]]) {
            const tag = `${width}-n${n}${mine ? '-mine' : ''}`;
            const { ctx, page } = await open(width, `n=${n}&mine=${mine}`);
            const f = await facts(page);
            console.log(tag, JSON.stringify({ rows: f.rows, rowH: f.rowH, more: f.more, cols: f.cols, listW: f.listW, tileW: f.tileW, deckW: f.deckW, tileH: f.tileH, pinnedTop: f.pinnedTop }));
            check(`${tag}: exactly one calls tile, one header`, f.tiles === 1 && f.heads === 1);
            const limit = f.cols === '2' ? 4 : 3;
            check(`${tag}: two columns only when wide and > 3 calls`, (f.cols === '2') === (f.listW >= 1240 && n > 3), `cols ${f.cols} listW ${f.listW}`);
            check(`${tag}: collapsed rows <= ${limit}`, f.rows === Math.min(n, limit), `${f.rows} rows`);
            if (n === 1) check(`${tag}: single call uses the two-line solo row (44-56px)`, f.solo && f.rowH.every(h => h >= 44 && h <= 56), f.rowH.join(','));
            else check(`${tag}: row height 32-36px`, f.rowH.every(h => h >= 32 && h <= 36), f.rowH.join(','));
            check(`${tag}: no filled band on any row`, f.rowBg.every(b => b === 'rgba(0, 0, 0, 0)'), f.rowBg.join(' '));
            check(`${tag}: avatars flush to the name (no dead slot)`, f.stackGap.every(g => g.ok), JSON.stringify(f.stackGap));
            check(`${tag}: no horizontal overflow`, f.hostOverflow <= 0 && f.rowOverflow.length === 0, `host +${f.hostOverflow} rows ${f.rowOverflow.join(' ')}`);
            check(`${tag}: tile spans the deck (no backup nudge here)`, Math.abs(f.tileW - f.deckW) <= 1, `${f.tileW} vs ${f.deckW}`);
            if (mine) {
                check(`${tag}: your call first, no Join on it`, f.mineFirst && !f.mineHasJoin, f.names[0]);
            }
            await page.screenshot({ path: `${OUT}/${tag}.png` });
            await tileShot(page, `${OUT}/${tag}-tile.png`);
            if (n > limit) {
                check(`${tag}: "+${n - limit} more"`, f.more?.includes(`+${n - limit} more`), f.more ?? '');
                await page.click('[data-testid="home-calls-more"]');
                await page.waitForTimeout(400);
                const e = await facts(page);
                check(`${tag}: expanded shows all ${n} in place`, e.rows === n && e.tiles === 1 && e.more?.includes('Show less'), `${e.rows} rows`);
                check(`${tag}: expanded rows 32-36px`, e.rowH.every(h => h >= 32 && h <= 36));
                const longRow = e.trunc.find(t => t.title.startsWith('late night chill') && (t.srv || t.name));
                if (longRow) check(`${tag}: long row truncates with full tooltip`, (longRow.srv || longRow.name) && longRow.title.includes('An Extremely Long Server'), JSON.stringify(longRow));
                console.log(`${tag}-expanded`, JSON.stringify({ rows: e.rows, cols: e.cols, tileH: e.tileH, pinnedTop: e.pinnedTop }));
                await page.screenshot({ path: `${OUT}/${tag}-expanded.png` });
                await tileShot(page, `${OUT}/${tag}-expanded-tile.png`);
                // Keyboard: the toggle is a real button; Enter collapses back.
                await page.focus('[data-testid="home-calls-more"]');
                await page.keyboard.press('Enter');
                await page.waitForTimeout(200);
                const c = await facts(page);
                check(`${tag}: Enter collapses back`, c.rows === limit && c.more?.includes('more'));
            }
            await ctx.close();
        }
    }

    // Single call (owner 2026-11-16: "when it is just one call going it could
    // look better"): the two-line solo row, your call and someone else's, at
    // 1280 / 1920 / a 480px pane, with and without the backup nudge beside it.
    // Named shots for the owner; checks: one solo row, 44-56px, no filled
    // band, avatars flush to the name, Join / "In call" vertically centred,
    // nothing overflows, name in the display face.
    {
        const SOLO = [
            ['single-mine-1280', 1280, 'only=solo-mine&mine=1'],
            ['single-other-1280', 1280, 'only=movie'],
            ['single-mine-1920', 1920, 'only=solo-mine&mine=1'],
            ['single-other-1920', 1920, 'only=movie'],
            ['single-mine-build-1280', 1280, 'only=build&mine=1'],
            ['single-other-2people-1280', 1280, 'only=private'],
            ['single-narrow-480', 1280, 'only=movie&chrome=800'],
            ['single-narrow-480-mine', 1280, 'only=solo-mine&mine=1&chrome=800'],
            ['single-other-1280-backup', 1280, 'only=movie&backup=1'],
            ['single-mine-1280-backup', 1280, 'only=solo-mine&mine=1&backup=1'],
            ['single-other-1920-backup', 1920, 'only=movie&backup=1'],
        ];
        for (const [tag, width, query] of SOLO) {
            const { ctx, page } = await open(width, query);
            const f = await facts(page);
            const g = await page.evaluate(() => {
                const row = document.querySelector('[data-testid="home-call-row"]');
                const r = row.getBoundingClientRect();
                const act = row.querySelector('.hd-call-act')?.getBoundingClientRect();
                const name = row.querySelector('.hd-call-name');
                return {
                    actCentreOff: act ? Math.round(Math.abs((act.top + act.height / 2) - (r.top + r.height / 2))) : null,
                    nameFont: getComputedStyle(name).fontFamily,
                    nameTrunc: name.scrollWidth > name.clientWidth,
                    discs: row.querySelector('.hd-call-stack').children.length,
                    more: row.querySelector('.hd-call-stackmore')?.textContent ?? null,
                    tag: row.querySelector('.hd-call-here')?.textContent ?? null,
                    join: !!row.querySelector('button.hd-btn'),
                };
            });
            console.log(tag, JSON.stringify({ rowH: f.rowH, tileH: f.tileH, tileW: f.tileW, deckW: f.deckW, stack: f.stackGap[0], ...g }));
            check(`${tag}: one solo row 44-56px`, f.tiles === 1 && f.solo && f.rowH.every(h => h >= 44 && h <= 56), f.rowH.join(','));
            check(`${tag}: no filled band`, f.rowBg.every(b => b === 'rgba(0, 0, 0, 0)'), f.rowBg.join(' '));
            check(`${tag}: avatars flush, no dead slot`, f.stackGap[0].ok && f.stackGap[0].pad <= 1, JSON.stringify(f.stackGap[0]));
            check(`${tag}: action vertically centred`, g.actCentreOff !== null && g.actCentreOff <= 1, String(g.actCentreOff));
            check(`${tag}: name in the display face`, /Fredoka/.test(g.nameFont), g.nameFont);
            check(`${tag}: ≤ 4 discs`, g.discs <= 4, `${g.discs} ${g.more ?? ''}`);
            check(`${tag}: mine shows "In call" and no Join; other shows Join`,
                query.includes('mine=1') ? (g.tag?.includes('In call') && !g.join) : (g.join && !g.tag), JSON.stringify(g));
            check(`${tag}: no horizontal overflow`, f.hostOverflow <= 0 && f.rowOverflow.length === 0, `host +${f.hostOverflow} rows ${f.rowOverflow.join(' ')}`);
            await page.screenshot({ path: `${OUT}/${tag}.png` });
            await tileShot(page, `${OUT}/${tag}-tile.png`);
            await ctx.close();
        }
        // Multi-call reference shot for the owner (3 calls, rows unchanged
        // apart from the band and the avatar slot).
        for (const [tag, width, query] of [['multi-3-1280', 1280, 'n=3'], ['multi-8-mine-1280', 1280, 'n=8&mine=1']]) {
            const { ctx, page } = await open(width, query);
            const f = await facts(page);
            console.log(tag, JSON.stringify({ rowH: f.rowH, stack: f.stackGap }));
            check(`${tag}: names aligned down the list`, new Set(await page.evaluate(() =>
                [...document.querySelectorAll('.hd-call-name')].slice(0, 3).map(n => Math.round(n.getBoundingClientRect().left)))).size === 1);
            check(`${tag}: slot = widest stack shown`, f.stackGap.every(s => s.ok), JSON.stringify(f.stackGap));
            await page.screenshot({ path: `${OUT}/${tag}.png` });
            await tileShot(page, `${OUT}/${tag}-tile.png`);
            await ctx.close();
        }
    }

    // With the backup nudge: the calls tile pairs two-across with it (the
    // deck's existing alerts rule, data-alerts="2"), rows still one line.
    {
        const { ctx, page } = await open(1280, 'n=8&backup=1');
        const f = await facts(page);
        check('with backup nudge: one tile, rows one line', f.tiles === 1 && f.rowH.every(h => h >= 32 && h <= 36), `${f.tileW}/${f.deckW}`);
        await page.screenshot({ path: `${OUT}/1280-n8-with-backup-nudge.png` });
        await ctx.close();
    }
    // Reduced motion: revealed rows carry no animation.
    {
        const { ctx, page } = await open(1280, 'n=8', 'reduce');
        await page.click('[data-testid="home-calls-more"]');
        const anim = await page.evaluate(() => [...document.querySelectorAll('.hd-call--extra')].map(r => getComputedStyle(r).animationName));
        check('reduced motion: no reveal animation', anim.length > 0 && anim.every(a => a === 'none'), anim.join(','));
        await ctx.close();
    }
    // Narrow pane: still one line per row, server gives way first.
    {
        const { ctx, page } = await open(1280, 'n=8&chrome=800');
        const f = await facts(page);
        check('narrow (480px pane): rows stay one line', f.rowH.every(h => h >= 32 && h <= 36), f.rowH.join(','));
        check('narrow: no horizontal overflow', f.hostOverflow <= 0 && f.rowOverflow.length === 0, `host +${f.hostOverflow} rows ${f.rowOverflow.join(' ')}`);
        await page.click('[data-testid="home-calls-more"]');
        await page.waitForTimeout(400);
        const e = await facts(page);
        const long = e.trunc.find(t => t.title.startsWith('late night chill'));
        check('narrow: long row truncates the server first, full text in the tooltip',
            !!long && long.srv && long.title.includes('An Extremely Long Server'), JSON.stringify(long));
        check('narrow: a short call name is never cut', e.trunc.filter(t => !t.title.startsWith('late night')).every(t => !t.name));
        await page.screenshot({ path: `${OUT}/narrow-480-n8-expanded.png` });
        await ctx.close();
    }
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
