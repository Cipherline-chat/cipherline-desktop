// Text formatting: behaviour checks + screenshots of the REAL components in headless Chromium.
//
//   npx vite --config harness/text-formatting.vite.config.ts      (serves :5341)
//   node harness/text-formatting-shots.mjs                         (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// One browser for the whole run, closed at the end (see CLAUDE.md "Headless Chrome cleanup").
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5341/harness/text-formatting.html';
const OUT = process.env.OUT ?? '/tmp/text-formatting-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 2 });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error') console.log('console.error: ' + m.text()); });
    const load = async (qs, sel = '[data-row]') => {
        await page.goto(`${BASE}${qs}`);
        await page.waitForSelector(sel);
        await page.evaluate(() => document.fonts.ready);
        await sleep(400);
    };
    const shot = async (name, clip) => {
        const path = `${OUT}/${name}`;
        if (clip) await page.screenshot({ path, clip }); else await page.screenshot({ path, fullPage: true });
        console.log(`SHOT  ${path}`);
    };
    const boxOf = async (sel) => page.locator(sel).first().boundingBox();

    // ---------- 1. every format ----------------------------------------------------------------------------
    await load('?scene=feed');
    const f = await page.evaluate(() => {
        const row = (id) => document.querySelector(`[data-row="${id}"]`);
        const fs = (el) => el ? getComputedStyle(el).fontSize : null;
        const body = row('f2').querySelector('.cl-fmt');
        const heads = [...row('f2').querySelectorAll('[role="heading"]')];
        const spoil = row('f1').querySelector('.cl-fmt-spoiler-inner');
        return {
            strong: !!row('f1').querySelector('strong.cl-fmt-b'), em: !!row('f1').querySelector('em'), u: !!row('f1').querySelector('u'),
            s: !!row('f1').querySelector('s'), code: !!row('f1').querySelector('code.cl-fmt-code'),
            maskedHref: row('f1').querySelector('.cl-fmt-link')?.getAttribute('data-href'),
            headSizes: heads.map(fs), bodySize: fs(body), headWeights: heads.map(h => getComputedStyle(h).fontWeight),
            spoilerFilter: spoil ? getComputedStyle(spoil).filter : null,
            lists: row('f2').querySelectorAll('ul.cl-fmt-list').length, ol: row('f2').querySelector('ol.cl-fmt-list')?.getAttribute('start'),
            quote: !!row('f2').querySelector('blockquote.cl-fmt-quote'),
            fonts: ['f4', 'f5', 'f6', 'f7'].map(id => getComputedStyle(row(id).querySelector('.whitespace-pre-wrap')).fontFamily),
            mentionInBold: !!row('f1').querySelector('strong .rounded'),
            imgs: document.querySelectorAll('[data-feed] img').length,
        };
    });
    check('bold / italic / underline / strike / code render as elements', f.strong && f.em && f.u && f.s && f.code);
    check('masked link carries its real destination', f.maskedHref === 'https://example.com/docs', f.maskedHref);
    check('headings are the SAME font size as the body (structure, not size)', f.headSizes.length === 3 && f.headSizes.every(x => x === f.bodySize), JSON.stringify({ heads: f.headSizes, body: f.bodySize }));
    check('…and heavier than it', f.headWeights.every(w => Number(w) >= 600), JSON.stringify(f.headWeights));
    check('spoiler content is blurred until revealed', /blur/.test(f.spoilerFilter ?? ''), f.spoilerFilter);
    check('nested bullet list + numbered list + quote', f.lists === 2 && f.ol === '1' && f.quote);
    check('mention pill still renders inside bold', f.mentionInBold);
    check('fonts: default / serif / mono / handwritten', /Nunito/.test(f.fonts[0]) && /Cipherline Lora/.test(f.fonts[1]) && /JetBrains/.test(f.fonts[2]) && /Cipherline Caveat/.test(f.fonts[3]), JSON.stringify(f.fonts));
    check('no sender HTML became an <img>', f.imgs === 0);

    const r1 = await boxOf('[data-row="f1"]');
    const r2 = await boxOf('[data-row="f2"]');
    await shot('01-every-format.png', { x: 0, y: r1.y - 8, width: 880, height: r2.y + r2.height - r1.y + 16 });

    // Reveal the spoiler and hover the masked link: the real destination shows.
    await page.locator('[data-row="f1"] .cl-fmt-spoiler').first().click();
    await page.locator('[data-row="f1"] .cl-fmt-link').first().hover();
    await sleep(900);
    const tip = await page.evaluate(() => [...document.querySelectorAll('body > *')].map(e => e.textContent).find(t => t?.includes('https://example.com/docs')) ?? null);
    check('hovering a masked link shows its destination', !!tip, tip ?? '');
    const revealed = await page.evaluate(() => document.querySelector('[data-row="f1"] .cl-fmt-spoiler[data-revealed]')?.textContent);
    check('clicking a spoiler reveals it', revealed === 'spoiler', revealed);
    await shot('01b-spoiler-revealed-link-hover.png', { x: 0, y: r1.y - 8, width: 880, height: r1.height + 70 });

    const fb = await boxOf('[data-row="f4"]');
    const fe = await boxOf('[data-row="f7d"]');
    await shot('07-message-fonts.png', { x: 0, y: fb.y - 8, width: 880, height: fe.y + fe.height - fb.y + 16 });

    // Phishing-shaped masked link -> warning dialog.
    await page.locator('[data-row="f8"] .cl-fmt-link').click();
    await page.waitForSelector('[role="dialog"]');
    await sleep(500);
    const dlg = await page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? '');
    check('deceptive masked link warns and names both hosts', dlg.includes("isn't what it says") && dlg.includes('paypal.com') && dlg.includes('paypa1-secure.example'), dlg.slice(0, 160));
    await shot('06-masked-link-warning.png');
    await page.keyboard.press('Escape');
    await sleep(300);

    // ---------- 2. toolbar open ----------------------------------------------------------------------------
    await ctx.close().catch(() => {});
    const ctx2 = await browser.newContext({ viewport: { width: 880, height: 360 }, deviceScaleFactor: 2 });
    await ctx2.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    const load2 = async (qs) => {
        await p2.goto(`${BASE}${qs}`);
        await p2.waitForSelector('[data-chat-input]');
        await p2.evaluate(() => document.fonts.ready);
        await sleep(400);
    };
    const shot2 = async (name) => { await p2.screenshot({ path: `${OUT}/${name}` }); console.log(`SHOT  ${OUT}/${name}`); };

    await load2('?scene=composer&bar=1&text=' + encodeURIComponent('ship it tonight, we are ready') + '&sel=8,15');
    const bar = await p2.evaluate(() => ({
        role: document.querySelector('.fmt-bar')?.getAttribute('role'),
        n: document.querySelectorAll('.fmt-bar .fmt-btn').length,
        expanded: document.querySelector('.fmt-toggle')?.getAttribute('aria-expanded'),
    }));
    check('the Aa toggle opens a role=toolbar bar with 12 tools + font', bar.role === 'toolbar' && bar.n === 13 && bar.expanded === 'true', JSON.stringify(bar));
    await p2.locator('[data-action="bold"]').click();
    await sleep(150);
    let v = await p2.evaluate(() => window.__tf.value());
    check('Bold wraps the selection (selection kept through the click)', v === 'ship it **tonight**, we are ready', v);
    await p2.mouse.move(400, 40);
    await sleep(200);
    await p2.locator('[data-action="bold"]').hover();
    await sleep(900);
    await shot2('02-toolbar-open.png');

    // Shortcuts on the real textarea.
    await p2.evaluate(() => window.__tf.select(24, 27));
    await p2.keyboard.press('Control+i');
    await sleep(100);
    v = await p2.evaluate(() => window.__tf.value());
    check('Ctrl+I italicises the selection', v === 'ship it **tonight**, we *are* ready', v);
    await p2.keyboard.press('Control+z');
    await sleep(100);

    // List continuation on the newline key.
    await load2('?scene=composer&text=' + encodeURIComponent('- milk') + '&sel=6,6');
    await p2.keyboard.press('Shift+Enter');
    await sleep(100);
    await p2.keyboard.type('eggs');
    await p2.keyboard.press('Shift+Enter');
    await sleep(100);
    await p2.keyboard.press('Shift+Enter');
    await sleep(100);
    v = await p2.evaluate(() => window.__tf.value());
    check('Shift+Enter continues a list; on an empty item it ends it', v === '- milk\n- eggs\n', JSON.stringify(v));

    // ---------- 3. font picker -----------------------------------------------------------------------------
    await load2('?scene=composer&bar=1&font=serif&text=' + encodeURIComponent('Dear team, a short note in serif.'));
    await p2.locator('[data-font-button]').click();
    await p2.waitForSelector('[role="menu"]');
    await sleep(400);
    const menu = await p2.evaluate(() => [...document.querySelectorAll('[role="menuitemradio"]')].map(i => `${i.getAttribute('data-font-id')}:${i.getAttribute('aria-checked')}`));
    check('font menu lists the seven fonts with serif checked', menu.join(',') === 'default:false,serif:true,mono:false,hand:false,typewriter:false,marker:false,readable:false', menu.join(','));
    await shot2('03-font-picker.png');

    // ---------- 4. markdown paste --------------------------------------------------------------------------
    await load2('?scene=composer');
    const sample = await p2.evaluate(() => window.__tf.sample);
    await p2.evaluate((t) => navigator.clipboard.writeText(t), sample);
    await p2.locator('[data-chat-input]').focus();
    await p2.keyboard.press('Control+v');
    await p2.waitForSelector('[data-md-paste-prompt]', { timeout: 5000 }).catch(() => {});
    await sleep(400);
    const prompt = await p2.evaluate(() => !!document.querySelector('[data-md-paste-prompt]'));
    check('pasting ChatGPT-style Markdown offers "Paste as formatted text?"', prompt);
    await shot2('04-markdown-paste-prompt.png');
    if (prompt) {
        await p2.locator('[data-md-paste-prompt] button', { hasText: 'Format' }).click();
        await sleep(300);
        v = await p2.evaluate(() => window.__tf.value());
        check('Format converts it (GFM __bold__ -> **bold**, table -> code block)', v.includes('**CLI**') && v.includes('│') && !v.includes('|:---'), v.slice(0, 80));
        await shot2('04b-markdown-paste-converted.png');
    }
    // A plain paste never asks.
    await load2('?scene=composer');
    await p2.evaluate(() => navigator.clipboard.writeText('I *really* mean it, 2 * 3 = 6'));
    await p2.locator('[data-chat-input]').focus();
    await p2.keyboard.press('Control+v');
    await sleep(500);
    check('a plain paste with asterisks does not ask', !(await p2.evaluate(() => !!document.querySelector('[data-md-paste-prompt]'))));

    // ---------- 5. code blocks + the converted paste as a message -----------------------------------------
    await ctx2.close().catch(() => {});
    const ctx3 = await browser.newContext({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 2 });
    const p3 = await ctx3.newPage();
    p3.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await p3.goto(`${BASE}?scene=code`);
    await p3.waitForSelector('[data-row]');
    await p3.evaluate(() => document.fonts.ready);
    await sleep(400);
    const hl = await p3.evaluate(() => ({
        kw: document.querySelectorAll('.cl-hl-kw').length, str: document.querySelectorAll('.cl-hl-str').length,
        com: document.querySelectorAll('.cl-hl-com').length, blocks: document.querySelectorAll('.cl-fmt-pre').length,
        wrap: getComputedStyle(document.querySelector('.cl-fmt-pre code')).whiteSpace,
    }));
    check('code blocks are highlighted (keywords, strings, comments) and never wrap', hl.blocks === 5 && hl.kw > 5 && hl.str >= 2 && hl.com > 1 && hl.wrap === 'pre', JSON.stringify(hl));
    await p3.screenshot({ path: `${OUT}/05-code-blocks.png`, fullPage: true });
    console.log(`SHOT  ${OUT}/05-code-blocks.png`);
    await p3.goto(`${BASE}?scene=pasted`);
    await p3.waitForSelector('[data-row]');
    await p3.evaluate(() => document.fonts.ready);
    await sleep(400);
    await p3.screenshot({ path: `${OUT}/04c-pasted-markdown-as-message.png`, fullPage: true });
    console.log(`SHOT  ${OUT}/04c-pasted-markdown-as-message.png`);
    await ctx3.close().catch(() => {});

    // ---------- 6. a long code message: collapsed / expanded / full screen --------------------------------
    const ctx4 = await browser.newContext({ viewport: { width: 880, height: 640 }, deviceScaleFactor: 2 });
    const p4 = await ctx4.newPage();
    p4.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await p4.goto(`${BASE}?scene=long`);
    await p4.waitForSelector('[data-long-message]');
    await p4.evaluate(() => document.fonts.ready);
    await sleep(400);
    const lc = await p4.evaluate(() => {
        const lm = document.querySelector('[data-long-message]');
        const pre = lm.querySelector('.cl-fmt-pre');
        return {
            state: lm.getAttribute('data-state'), clipped: pre?.hasAttribute('data-clipped'),
            lines: pre?.querySelector('code')?.textContent.split('\n').length, copy: !!pre?.querySelector('.cl-fmt-pre-copy'),
            ticks: lm.textContent.includes('```'), meta: lm.querySelector('.lm-meta')?.textContent,
            bold: lm.querySelector('strong')?.textContent,
        };
    });
    check('a 67-line, <5,000-character code message collapses (line rule) to a clipped code block preview', lc.state === 'collapsed' && /67 lines/.test(lc.meta) && lc.clipped && lc.lines >= 3 && lc.lines < 12 && !lc.copy && !lc.ticks && lc.bold === 'careful', JSON.stringify(lc));
    await p4.screenshot({ path: `${OUT}/09-long-code-collapsed.png` });
    console.log(`SHOT  ${OUT}/09-long-code-collapsed.png`);
    await p4.locator('[data-long-message] button', { hasText: 'Expand' }).click();
    await sleep(300);
    const ex = await p4.evaluate(() => {
        const pre = document.querySelector('[data-long-message] .cl-fmt-pre');
        return { lines: pre.querySelector('code').textContent.split('\n').length, copy: !!pre.querySelector('.cl-fmt-pre-copy'), kw: pre.querySelectorAll('.cl-hl-kw').length };
    });
    check('Expand shows all 64 lines, highlighted, with the copy button', ex.lines === 64 && ex.copy && ex.kw > 20, JSON.stringify(ex));
    await p4.screenshot({ path: `${OUT}/10-long-code-expanded.png`, fullPage: true });
    console.log(`SHOT  ${OUT}/10-long-code-expanded.png`);
    await p4.locator('[data-long-message] button', { hasText: 'Collapse' }).click();
    await sleep(200);
    await p4.locator('[data-long-message] button', { hasText: 'Open full screen' }).click();
    await p4.waitForSelector('[role="dialog"] .lm-reader-text .cl-fmt-pre');
    await sleep(500);
    const rd = await p4.evaluate(() => {
        const r = document.querySelector('[role="dialog"] .lm-reader-text');
        return { lines: r.querySelector('.cl-fmt-pre code').textContent.split('\n').length, bold: r.querySelector('strong')?.textContent };
    });
    check('the full-screen reader renders the formatting and the whole block', rd.lines === 64 && rd.bold === 'careful', JSON.stringify(rd));
    await p4.screenshot({ path: `${OUT}/11-long-code-reader.png` });
    console.log(`SHOT  ${OUT}/11-long-code-reader.png`);
    await ctx4.close().catch(() => {});

    // ---------- 7. code paste prompt ----------------------------------------------------------------------
    const ctx5 = await browser.newContext({ viewport: { width: 880, height: 420 }, deviceScaleFactor: 2 });
    await ctx5.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    const p5 = await ctx5.newPage();
    p5.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    await p5.goto(`${BASE}?scene=composer`);
    await p5.waitForSelector('[data-chat-input]');
    await p5.evaluate(() => document.fonts.ready);
    const py = await p5.evaluate(() => window.__tf.py);
    await p5.evaluate((t) => navigator.clipboard.writeText(t), py);
    await p5.locator('[data-chat-input]').focus();
    await p5.keyboard.press('Control+v');
    await p5.waitForSelector('[data-md-paste-prompt]', { timeout: 5000 }).catch(() => {});
    await sleep(300);
    const cp = await p5.evaluate(() => {
        const g = document.querySelector('[data-md-paste-prompt]');
        return g ? { kind: g.getAttribute('data-kind'), text: g.textContent, n: document.querySelectorAll('[data-md-paste-prompt]').length } : null;
    });
    check('pasting Python offers ONE prompt: "Paste as a code block?" (python)', cp?.kind === 'code' && cp.n === 1 && cp.text.includes('Paste as a code block?') && cp.text.includes('python'), JSON.stringify(cp));
    await p5.screenshot({ path: `${OUT}/12-code-paste-prompt.png` });
    console.log(`SHOT  ${OUT}/12-code-paste-prompt.png`);
    await p5.locator('[data-md-paste-prompt] button', { hasText: 'Format' }).click();
    await sleep(300);
    const fv = await p5.evaluate(() => window.__tf.value());
    check('Format fences exactly the pasted code as ```python', fv === '```python\n' + py.replace(/\n+$/, '') + '\n```', JSON.stringify(fv.slice(0, 40)));
    await p5.screenshot({ path: `${OUT}/12b-code-paste-formatted.png` });
    console.log(`SHOT  ${OUT}/12b-code-paste-formatted.png`);
    await ctx5.close().catch(() => {});

    // ---------- 8. fonts: bundled, lazy, and seven distinct looks -----------------------------------------
    const ctx6 = await browser.newContext({ viewport: { width: 880, height: 900 }, deviceScaleFactor: 2 });
    const p6 = await ctx6.newPage();
    p6.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    const fontReqs = [];
    p6.on('request', r => { if (/\.woff2(\?|$)/.test(r.url())) fontReqs.push(r.url()); });
    await p6.goto(`${BASE}?scene=code`);
    await p6.waitForSelector('[data-row]');
    await p6.evaluate(() => document.fonts.ready);
    await sleep(500);
    const ours = (u) => /\/assets\/fonts\//.test(u);
    check('no message font is loaded until something uses it', fontReqs.filter(ours).length === 0, fontReqs.filter(ours).join(' '));
    fontReqs.length = 0;
    await p6.goto(`${BASE}?scene=fonts&bar=1`);
    await p6.waitForSelector('[data-row]');
    await p6.locator('[data-font-button]').click();
    await p6.waitForSelector('[role="menu"]');
    await p6.evaluate(() => document.fonts.ready);
    await sleep(800);
    const loaded = await p6.evaluate(async () => {
        const fams = ['Cipherline Lora', 'Cipherline Caveat', 'Cipherline Special Elite', 'Cipherline Permanent Marker', 'Cipherline Atkinson Hyperlegible'];
        return fams.map(f => `${f}:${document.fonts.check(`15px '${f}'`)}`);
    });
    const remote = fontReqs.filter(u => ours(u) && !u.startsWith(new URL(BASE).origin));
    check('the bundled faces load from the app itself (same origin), once used', loaded.every(x => x.endsWith(':true')) && fontReqs.filter(ours).length >= 5 && remote.length === 0, JSON.stringify({ loaded, n: fontReqs.filter(ours).length, remote }));
    const sizes = await p6.evaluate(() => [...document.querySelectorAll('[data-msg-font] .cl-fmt-code, [data-row] .whitespace-pre-wrap')].slice(0, 12).map(e => getComputedStyle(e).fontSize));
    check('no message font changes the font size (code included)', sizes.every(x => x === '15px' || x === '12.9px' || /^12\.\d+px$/.test(x)), JSON.stringify(sizes));
    const codeFam = await p6.evaluate(() => [...document.querySelectorAll('[data-msg-font] .cl-fmt-code')].map(e => getComputedStyle(e).fontFamily));
    check('code stays monospace in every message font', codeFam.length >= 2 && codeFam.every(f => /JetBrains/.test(f)), JSON.stringify(codeFam));
    await p6.screenshot({ path: `${OUT}/08-fonts-variety.png` });
    console.log(`SHOT  ${OUT}/08-fonts-variety.png`);
    await ctx6.close().catch(() => {});
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
