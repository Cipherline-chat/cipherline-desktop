// Drives the REAL ChatPane composer in real Chromium: typing `:name:` converts in the text box.
//
//   npx vite --config harness/emoji-shortcodes.vite.config.ts   (serves :5324)
//   node harness/emoji-shortcodes-shots.mjs                      (env: OUT=<dir> BASE=... PW_CHROMIUM_EXE=...)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE ?? '/home/antigravity/Cipherline/node_modules/playwright-core');
const exe = process.env.PW_CHROMIUM_EXE ?? '/home/antigravity/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5324/harness/emoji-shortcodes.html';
const OUT = process.env.OUT ?? '/tmp/emoji-shortcodes-shots';
mkdirSync(OUT, { recursive: true });
let failures = 0;
const check = (name, ok, extra = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

const HEART = '❤️';
const SMILE = '\u{1F604}';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
page.on('pageerror', e => { failures++; console.log('PAGEERROR', e.message); });
await page.goto(`${BASE}?view=server&bare=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__booted && window.__emojiReady);
const ta = page.locator('textarea[data-chat-input]');
await ta.waitFor();
await page.waitForTimeout(800); // server emoji list fetch

const state = () => ta.evaluate(el => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }));
const clear = async () => { await ta.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Delete'); };
const type = async (s) => { await ta.click(); await page.keyboard.type(s, { delay: 15 }); await page.waitForTimeout(120); };
const settle = () => page.waitForTimeout(150);

// 1. standard emoji, underscore name
await clear(); await type(':red_heart:'); await settle();
let s = await state();
check('typing :red_heart: leaves the emoji in the box', s.value === HEART, JSON.stringify(s));
check('caret is directly after the emoji', s.start === HEART.length && s.end === HEART.length, JSON.stringify(s));

// 2. one undo brings the typed text back
await page.keyboard.press('Control+Z'); await settle();
s = await state();
check('one Ctrl+Z restores the typed :red_heart:', s.value === ':red_heart:', JSON.stringify(s));
await page.keyboard.press('Control+Shift+Z'); await settle();
s = await state();
check('redo puts the emoji back', s.value === HEART, JSON.stringify(s));

// 3. old habit: real spaces in a complete name
await clear(); await type(':red heart:'); await settle();
s = await state();
check('typing :red heart: with real Space keys converts (the whole span is a complete name)', s.value === HEART, JSON.stringify(s));

// 4. Space is an ordinary key while an emoji query is open
await clear(); await type(':red'); await page.keyboard.press('Space'); await settle();
s = await state();
check('Space after ":red" is a plain space (no underscore)', s.value === ':red ', JSON.stringify(s));
await clear(); await type(':hello world'); s = await state();
check('":hello world" stays exactly as typed', s.value === ':hello world', JSON.stringify(s));

// 5. things that must never be touched
for (const t of ['note: hello', '12:30 pm', ':) hi', '::', 'ratio 3:2:1', 'foo:smile:', 'see :notanemoji: ok', 'a :smile']) {
    await clear(); await type(t); s = await state();
    check(`unchanged: ${JSON.stringify(t)}`, s.value === t, JSON.stringify(s));
}
await clear(); await type(':) '); s = await state();
check('":)" then a space is a normal space', s.value === ':) ', JSON.stringify(s));

// 6. code is literal
for (const t of ['`:smile:', '`a :smile:', '```\n:smile:']) {
    await clear(); await ta.click();
    for (const ch of t) { if (ch === '\n') await page.keyboard.press('Shift+Enter'); else await page.keyboard.type(ch); }
    await settle(); s = await state();
    check(`inside code, not converted: ${JSON.stringify(t)}`, s.value === t, JSON.stringify(s));
}

// 7. several emojis, and mid-text caret placement
await clear(); await type(':smile: and :red_heart: done'); s = await state();
check('two emojis in one line', s.value === `${SMILE} and ${HEART} done`, JSON.stringify(s));
await clear(); await type('ab cd');
await page.keyboard.press('Home'); for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
await page.keyboard.type(':smile:', { delay: 15 }); await settle(); s = await state();
check('typed in the middle: text after is kept and the caret sits right after the emoji', s.value === `ab ${SMILE}cd` && s.start === 3 + SMILE.length, JSON.stringify(s));
await page.keyboard.type('X'); s = await state();
check('typing continues at the caret', s.value === `ab ${SMILE}Xcd`, JSON.stringify(s));

// 8. server emojis: stay :name:, canonical underscore form (one is stored as "party parrot")
await clear(); await type(':partyblob:'); s = await state();
check('server emoji stays :partyblob: in the box', s.value === ':partyblob:', JSON.stringify(s));
await clear(); await type(':party_parrot:'); s = await state();
check('server emoji stored with a space is :party_parrot: and stays', s.value === ':party_parrot:', JSON.stringify(s));
await clear(); await type(':party parrot:'); s = await state();
check('old-style ":party parrot:" is rewritten to :party_parrot:', s.value === ':party_parrot:', JSON.stringify(s));

// 9. the autocomplete speaks underscores
await clear(); await type(':red_he'); await page.waitForTimeout(300);
const labels = await page.evaluate(() => (document.body.innerText.match(/:[a-z0-9_ +-]{2,}:/g) ?? []).join(' | '));
check('menu offers :red_heart:', /:red_heart:/.test(labels), labels.slice(0, 200));
check('no menu label has a space between words', !/:[a-z0-9_]+ [a-z0-9_]+:/.test(labels));
await page.screenshot({ path: `${OUT}/autocomplete-red_he.png` });
await page.keyboard.press('Enter'); await settle(); s = await state();
check('Enter on the highlighted row inserts the emoji, not ":red heart:"', s.value === HEART && !/ /.test(s.value), JSON.stringify(s));

await clear(); await type('I :red_heart: this :partyblob: and :smile:'); await settle();
await page.screenshot({ path: `${OUT}/composer-converted.png` });
s = await state();
check('screenshot line', s.value === `I ${HEART} this :partyblob: and ${SMILE}`, JSON.stringify(s));

await browser.close();
console.log(failures ? `FAILURES: ${failures}` : 'ALL PASS');
process.exit(failures ? 1 : 0);
