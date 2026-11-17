// WYSIWYG composer: behaviour checks + screenshots of the REAL components in headless Chromium,
// typed with real key events (so Chromium's own beforeinput / composition path is what runs).
//
//   npx vite --config harness/composer-wysiwyg.vite.config.ts      (serves :5347)
//   node harness/composer-wysiwyg-shots.mjs                       (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
//
// One browser for the whole run, closed at the end (see CLAUDE.md "Headless Chrome cleanup").
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5347/harness/composer-wysiwyg.html';
const OUT = process.env.OUT ?? '/tmp/composer-wysiwyg-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
    const ctx = await browser.newContext({ viewport: { width: 760, height: 560 }, deviceScaleFactor: 2 });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => { failures++; console.log('FAIL  pageerror ' + e.message); });
    page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('DBG')) console.log('console: ' + m.text()); });
    const box = '[data-rich-composer]';
    const load = async (qs) => {
        await page.goto(`${BASE}${qs}`);
        await page.waitForSelector(qs.includes('sizes') ? '[data-row]' : box);
        await page.evaluate(() => document.fonts.ready);
        await sleep(300);
        if (!qs.includes('sizes')) await page.click(box);
    };
    const shot = async (name, full = false) => {
        const path = `${OUT}/${name}`;
        if (full) await page.screenshot({ path, fullPage: true });
        else await page.screenshot({ path, clip: { x: 0, y: 220, width: 760, height: 340 } });
        console.log(`SHOT  ${path}`);
    };
    const boxText = () => page.$eval(box, el => el.textContent);
    const value = () => page.evaluate(() => window.__cw.value());
    const openBar = async () => { if (!(await page.$('.fmt-bar'))) await page.click('.fmt-toggle'); };
    const send = async () => { await page.keyboard.press('Enter'); await sleep(150); };

    // ---------- 1. typed shortcuts, undo, toolbar: bold / italic / underline ----------
    await load('?scene=composer');
    await page.keyboard.type('Shipping **today** ');
    check('typed **today** + space shows bold, no markers', await page.$eval(box, el => el.querySelector('strong')?.textContent) === 'today' && !(await boxText()).includes('*'));
    check('...and sends as **today**', (await value()) === 'Shipping **today** ');
    await page.keyboard.press('Control+z');
    check('Ctrl+Z right after brings the literal markers back', (await boxText()) === 'Shipping **today** ' && !(await page.$(`${box} strong`)));
    await page.keyboard.press('Control+y');
    check('Ctrl+Y converts again', await page.$eval(box, el => el.querySelector('strong')?.textContent) === 'today');
    await page.keyboard.type('*really* and __properly__ ');
    const inl = await page.$eval(box, el => ({ em: el.querySelector('em')?.textContent, u: el.querySelector('u')?.textContent, t: el.textContent }));
    check('*really* -> italic, __properly__ -> underline', inl.em === 'really' && inl.u === 'properly' && !/[*_]/.test(inl.t), JSON.stringify(inl));
    await openBar();
    await page.keyboard.press('Control+b');
    await page.keyboard.type('done');
    check('Ctrl+B with nothing selected: what you type next is bold', (await value()).endsWith('**done**'));
    await sleep(120);
    check('the Bold button shows pressed at the caret', await page.$eval('[data-action="bold"]', b => b.getAttribute('aria-pressed')) === 'true');
    await shot('01-bold-italic-underline.png');
    await send();
    check('Enter sends (and the box is empty again)', (await boxText()) === '' && (await page.evaluate(() => window.__cw.sent().length)) === 1);

    // ---------- 2. bullets with real dots ----------
    await page.keyboard.type('- first');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('second');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('third');
    const ul = await page.$$eval(`${box} .rc-ul`, els => els.map(e => ({ t: e.textContent, dot: getComputedStyle(e, '::before').content })));
    check('`- ` + Shift+Enter: three bullet items, drawn with a dot (no dash in the text)', ul.length === 3 && ul.every(x => x.dot === '"•"') && !(await boxText()).includes('-'), JSON.stringify(ul));
    check('...sent as a Markdown list', (await value()) === '- first\n- second\n- third');
    await shot('02-bullet-list.png');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    check('Shift+Enter on an empty item ends the list', (await page.$$(`${box} .rc-ul`)).length === 3 && (await page.$$(`${box} .rc-p`)).length === 1);
    await send();

    // ---------- 3. code block ----------
    await page.keyboard.type('```js');
    await page.keyboard.press('Enter');
    check('``` + Enter makes a code block instead of sending', !!(await page.$(`${box} .rc-code`)) && (await page.evaluate(() => window.__cw.sent().length)) === 2);
    await page.keyboard.type('const answer = 42;');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('console.log(answer);');
    const code = await page.$eval(`${box} .rc-code`, el => ({ ff: getComputedStyle(el).fontFamily, bg: getComputedStyle(el).backgroundColor, t: el.textContent, lang: el.getAttribute('data-lang') }));
    check('code block: monospace on the code background, language label', /JetBrains Mono/i.test(code.ff) && code.bg !== 'rgba(0, 0, 0, 0)' && code.lang === 'js', JSON.stringify(code));
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('and an `inline` bit, ||a spoiler|| too ');
    await shot('03-code-block.png');
    check('...sent as a fence', (await value()).startsWith('```js\nconst answer = 42;\nconsole.log(answer);\n```'));
    await send();

    // ---------- 4. heading ONLY from the button; nothing typed makes one ----------
    for (const t of ['H', 'h', 'H hello', 'h hello', 'H1 x', '# x', '## x', '### x', '#x']) {
        await page.keyboard.type(t);
        await page.keyboard.press('Space');
        await page.keyboard.press('Shift+Enter');
        await page.keyboard.type(`mid ${t} line`);
        await page.keyboard.press('Shift+Enter');
    }
    const typedHeads = await page.$$eval(`${box} .rc-h1, ${box} .rc-h2, ${box} .rc-h3`, els => els.length);
    check('typing H / h / "H " / "# " / "## " / "### " (line start and mid-line, + Shift+Enter) never makes a heading', typedHeads === 0 && !/(^|\n)#{1,3} /.test(await value()), JSON.stringify(await value()));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await openBar();
    const hb = await page.$eval('[data-action="heading"]', b => ({ label: b.getAttribute('aria-label'), text: b.textContent, icon: b.querySelector('svg')?.getAttribute('class') ?? '' }));
    check('the heading button: a heading icon (no bare "H" glyph), accessible name "Heading"', hb.label === 'Heading' && hb.text === '' && /lucide-heading-1/.test(hb.icon), JSON.stringify(hb));
    await page.focus('[data-action="heading"]');
    await sleep(250);
    const tip = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].map(t => t.textContent));
    check('its tooltip is "Heading"', tip.includes('Heading'), JSON.stringify(tip));
    await shot('04a-heading-button-tooltip.png');
    await page.click(box);
    await page.keyboard.type('# not a heading');
    check('typed `# ` never becomes a heading', !(await page.$(`${box} .rc-h1`)) && (await boxText()) === '# not a heading' && (await value()) === '\\# not a heading');
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('Release notes');
    await openBar();
    await page.click('[data-action="heading"]');
    await sleep(120);
    check('in a heading the icon shows its level (H1)', /lucide-heading-1/.test(await page.$eval('[data-action="heading"] svg', s => s.getAttribute('class'))));
    const h = await page.$eval(box, el => ({ h1: el.querySelector('.rc-h1')?.textContent, size: getComputedStyle(el.querySelector('.rc-h1')).fontSize, base: getComputedStyle(el).fontSize }));
    check('the H button makes a heading (style, same size), sent as `# `', h.h1 === 'Release notes' && h.size === h.base && (await value()) === '# Release notes', JSON.stringify(h));
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Everything is faster now.');
    await sleep(120);
    await shot('04-heading-from-H.png');
    await send();

    // ---------- 5. # opens the channel menu ----------
    await page.keyboard.type('see you in ');
    await page.keyboard.press('Control+b');
    await page.keyboard.type('#ge');
    await sleep(150);
    const menu = await page.$$eval('[role="listbox"] [role="option"], [data-suggestion-menu] [role="option"]', els => els.map(e => e.textContent));
    const anyMenu = await page.evaluate(() => [...document.body.querySelectorAll('*')].some(e => e.textContent === 'Channels' && e.children.length === 0));
    check('typing `#` still opens the channel menu (inside bold text too)', anyMenu, JSON.stringify(menu));
    await shot('05-channel-menu.png');
    await page.keyboard.press('Enter');
    check('Enter picks the channel (still bold)', (await boxText()).includes('#general') && (await value()).includes('**#general'), JSON.stringify(await value()));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');

    // ---------- 6. font + size preview ----------
    await openBar();
    await page.click('[data-size-button]');
    await sleep(150);
    await shot('06-size-picker.png');
    await page.click('[data-size-id="large"]');
    await page.click('[data-font-button]');
    await page.click('[data-font-id="hand"]');
    await page.keyboard.type('a note in my own hand, **big** enough to read');
    const fp = await page.$eval(box, el => ({ ff: getComputedStyle(el).fontFamily, fs: getComputedStyle(el.querySelector('.rc-lg') ?? el).fontSize }));
    check('the box previews the font (Caveat) and the size (Large armed: 14.5 x 1.5)', /Caveat/.test(fp.ff) && fp.fs === '21.75px', JSON.stringify(fp));
    const selBefore = await page.evaluate(() => JSON.stringify(window.__cw.sel()));
    await page.keyboard.press('Control+b');
    await sleep(120);
    check('Ctrl+B at the end only arms bold for what comes next', (await value()) === '[large]a note in my own hand, **big** enough to read[/large]', selBefore + ' ' + JSON.stringify(await value()));
    await shot('07-font-and-size-preview.png');
    await send();

    // ---------- 7. nothing sticks after a send ----------
    const after = await page.evaluate(() => {
        const st = window.__cw.state();
        const el = document.querySelector('[data-rich-composer]');
        return { font: st.font, size: st.size, fs: getComputedStyle(el).fontSize, ff: getComputedStyle(el).fontFamily, fontBtn: document.querySelector('[data-font-button]')?.textContent, sizeBtn: document.querySelector('[data-size-button]')?.getAttribute('aria-label'), last: window.__cw.sent().at(-1) };
    });
    check('after the send: Default font, Normal size, box back to 14.5px Nunito', after.font === null && after.size === null && after.fs === '14.5px' && !/Caveat/.test(after.ff) && after.fontBtn === 'Default' && after.sizeBtn === 'Text size: Normal', JSON.stringify(after));
    check('...while the sent message kept them', after.last.font === 'hand' && after.last.size === 'large');
    await page.keyboard.type('next message');
    check('...and no style is still switched on', !(await page.$(`${box} strong`)) && (await value()) === 'next message');
    await sleep(120);
    check('...the Bold button is not pressed', await page.$eval('[data-action="bold"]', b => b.getAttribute('aria-pressed')) === 'false');
    await shot('08-defaults-after-send.png', true);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');

    // ---------- 8. IME composition (CDP: what an IME does) ----------
    const cdp = await ctx.newCDPSession(page);
    await page.keyboard.type('IME: ');
    await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.imeSetComposition', { text: '日本', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '日本' });
    await sleep(100);
    await page.keyboard.type('語!');
    check('IME composition commits into the model (and typing continues after it)', (await value()) === 'IME: 日本語!' && (await boxText()) === 'IME: 日本語!', JSON.stringify(await value()));
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');

    // ---------- 9. paste: HTML stripped, prompt formats ----------
    if (await page.$('.fmt-bar')) await page.click('.fmt-toggle');
    await page.click(box);
    await page.evaluate(async () => {
        const item = new ClipboardItem({
            'text/html': new Blob(['<b style="color:red" onclick="alert(1)">Hi</b><img src=x onerror=alert(1)>'], { type: 'text/html' }),
            'text/plain': new Blob(['Hi **there**, see:\n- one\n- two'], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([item]);
    });
    await page.keyboard.press('Control+v');
    await sleep(200);
    const pasted = await page.$eval(box, el => ({ t: el.textContent, b: !!el.querySelector('b, img, [onclick], [style*="red"]'), strong: !!el.querySelector('strong') }));
    check('a rich paste goes in as plain text: no markup, no styles', !pasted.b && !pasted.strong && pasted.t === 'Hi **there**, see:- one- two', JSON.stringify(pasted));
    const prompt = await page.$('.fmt-paste');
    check('...and the paste prompt is offered', !!prompt);
    if (prompt) {
        await page.click('.fmt-paste button:has-text("Format")');
        await sleep(150);
        const fmt = await page.$eval(box, el => ({ strong: el.querySelector('strong')?.textContent, ul: el.querySelectorAll('.rc-ul').length }));
        check('Format turns it into formatted content in the box', fmt.strong === 'there' && fmt.ul === 2, JSON.stringify(fmt));
    }
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');

    // ---------- 10. 4,000-character message: per-keystroke cost in Chromium ----------
    const ms = await page.evaluate(async () => {
        const el = document.querySelector('[data-rich-composer]');
        const fire = (data) => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true }));
        let big = '';
        while (big.length < 4000) big += 'Some words and a few more words here. ';
        for (const ch of big.slice(0, 600)) fire(ch);  // warm
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) fire('x');
        return (performance.now() - t0) / 60;
    });
    const big = await page.evaluate(() => window.__cw.plain().length);
    // fill to 4,000 through the value path and measure again
    const ms4k = await page.evaluate(async () => {
        const el = document.querySelector('[data-rich-composer]');
        const fire = (data) => el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data, bubbles: true, cancelable: true }));
        let s = '';
        while (s.length < 4100) s += '**bold** words `code` and *it* plus plain text. ';
        // type it in as text (literal), then convert: the cost we care about is per keystroke at size
        for (const ch of s) fire(ch);
        const t0 = performance.now();
        for (let i = 0; i < 60; i++) fire('y');
        return { per: (performance.now() - t0) / 60, len: window.__cw.plain().length };
    });
    check('typing stays instant at 4,000 characters (< 16 ms per key)', ms4k.len >= 4000 && ms4k.per < 16, `600 chars: ${ms.toFixed(2)} ms/key, ${ms4k.len} chars: ${ms4k.per.toFixed(2)} ms/key (box had ${big})`);

    // ---------- 11. Small / Normal / Large in the feed ----------
    await page.setViewportSize({ width: 760, height: 760 });
    await load('?scene=sizes');
    const sz = await page.evaluate(() => ['s-small', 's-normal', 's-large'].map(id => {
        const body = document.querySelector(`[data-row="${id}"] .whitespace-pre-wrap`);
        const pre = body.querySelector('.cl-fmt-pre code');
        const ic = body.querySelector('code.cl-fmt-code');
        return { body: getComputedStyle(body).fontSize, code: pre && getComputedStyle(pre).fontSize, inline: ic && getComputedStyle(ic).fontSize };
    }));
    check('Small / Normal / Large: body 13.125 / 15 / 22.5 px, code blocks and inline code scale with it',
        sz[0].body === '13.125px' && sz[1].body === '15px' && sz[2].body === '22.5px'
        && sz[0].code === '10.9375px' && sz[1].code === '12.5px' && sz[2].code === '18.75px'
        && parseFloat(sz[2].inline) > parseFloat(sz[1].inline), JSON.stringify(sz));
    await shot('09-sizes-small-normal-large.png', true);
} finally {
    await browser.close();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
