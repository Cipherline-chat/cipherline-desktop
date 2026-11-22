// Before/after contact sheet from two panel-corners-probe.mjs runs (--crops=1).
//   node harness/panel-corners-sheet.mjs --before=<dir> --after=<dir> --state=dark-laptop-server-top
//        --panels=list,chat,right --out=<file.png> [--title=...] [--labels=Before,After]
// Each row: one corner of one panel, the amplified crop from each run
// (x8, contrast x16 around the colour just outside the corner: mid-grey =
// exactly the page background; any tint inside the bounding square but
// outside the curve is the "square corner").
import { chromium, exe, arg } from './reaction-center-measure.mjs';
import fs from 'fs';
import path from 'path';

const before = arg('before', ''), after = arg('after', '');
const states = arg('state', 'dark-laptop-server-top').split(',');
const panels = arg('panels', 'list,chat,right').split(',');
const outFile = arg('out', '/tmp/panel-corners-sheet.png');
const title = arg('title', 'Panel corners');
const [lb, la] = arg('labels', 'Before (origin/staging),After (this branch)').split(',');
const results = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')); } catch { return []; } };
const rb = results(before), ra = results(after);
const img = (dir, st, p, c) => {
    const f = path.join(dir, 'crops', st, `${p}-${c}.png`);
    return fs.existsSync(f) ? `data:image/png;base64,${fs.readFileSync(f).toString('base64')}` : null;
};
const delta = (rows, st, p, c) => rows.find((r) => `${r.theme}-${r.size}-${r.case}-${r.scroll}` === st && r.panel === p && r.corner === c)?.delta;
let rowsHtml = '';
for (const st of states) for (const p of panels) for (const c of ['TL', 'TR', 'BL', 'BR']) {
    const a = img(before, st, p, c), b = img(after, st, p, c);
    if (!a && !b) continue;
    const da = delta(rb, st, p, c), db = delta(ra, st, p, c);
    const cell = (src, d) => `<td>${src ? `<img src="${src}">` : '<i>n/a</i>'}<div class="d ${d >= 2 ? 'bad' : 'ok'}">${d === undefined ? '' : `delta ${d}`}</div></td>`;
    rowsHtml += `<tr><th>${st.split('-').slice(2).join(' ')}<br><b>${p}</b> ${c}</th>${cell(a, da)}${cell(b, db)}</tr>`;
}
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:18px;background:#1b1f2a;color:#e6e9f2;font:13px/1.35 system-ui,sans-serif}
h1{font-size:17px;margin:0 0 4px} p{margin:0 0 12px;color:#aab}
table{border-collapse:collapse} th,td{padding:6px 10px;vertical-align:top;text-align:left}
th{font-weight:400;color:#aab;width:150px} th b{color:#fff}
td img{display:block;image-rendering:pixelated;width:256px;height:256px;object-fit:contain;background:#808080}
.d{margin-top:3px;font-weight:700} .bad{color:#ff8f7a} .ok{color:#7ee0b2}
thead th{color:#fff;font-weight:700}
</style><h1>${title}</h1><p>Each tile: one corner, 8x, contrast x16 around the colour just outside the corner. Mid-grey = page background.
A tinted block between the curve and the tile edge is the square corner. "delta" = worst difference in 0-255 levels (2+ = visible to the probe).</p>
<table><thead><tr><th></th><th>${lb}</th><th>${la}</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
const browser = await chromium.launch({ executablePath: exe, args: ['--disable-gpu'] });
try {
    const page = await browser.newPage({ viewport: { width: 760, height: 400 } });
    await page.setContent(html);
    await page.screenshot({ path: outFile, fullPage: true });
} finally { await browser.close(); }
console.log(outFile);
