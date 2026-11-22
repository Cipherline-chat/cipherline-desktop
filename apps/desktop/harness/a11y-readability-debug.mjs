// Prints page errors / console output for one harness URL: node harness/a11y-readability-debug.mjs "view=chat"
import { chromium, exe } from './reaction-center-measure.mjs';
const BASE = `http://127.0.0.1:${process.env.A11Y_PORT ?? 5447}/harness/a11y-readability.html`;
const b = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')));
p.on('console', m => console.log('console', m.type(), m.text().slice(0, 300)));
await p.goto(`${BASE}?${process.argv[2] ?? 'view=chat'}`, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 6000));
console.log('booted', await p.evaluate(() => window.__booted), 'rows', await p.evaluate(() => document.querySelectorAll('.cl-msg-row').length));
await b.close();
