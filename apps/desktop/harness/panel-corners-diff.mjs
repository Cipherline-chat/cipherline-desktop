// Pixel diff of two panel-corners-probe.mjs runs (--crops=1 frames), split by
// WHERE pixels changed: inside a pane's box, or outside every pane (the water
// between and around the cards, where a pane's shadow falls).
//   node harness/panel-corners-diff.mjs --a=<dir> --b=<dir> [--theme=dark] [--min=1] [--img=<state>:<file.png>]
// --img writes |a-b| x16 for one state (e.g. dark-laptop-server-top:/tmp/d.png).
import { arg } from './reaction-center-measure.mjs';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { PNG } = require(process.env.PNGJS ?? '/home/antigravity/Cipherline/node_modules/pngjs');
const A = arg('a', ''), B = arg('b', ''), theme = arg('theme', 'dark'), MIN = Number(arg('min', '1'));
const [imgState, imgFile] = arg('img', ':').split(':');
const rows = JSON.parse(fs.readFileSync(path.join(B, 'results.json'), 'utf8'));
const NAMED = /^(list|chat|right|solo|rail-deck\d*|settings)$/;
const dpr = { laptop: 1, large: 1, hidpi: 1.5 };
let total = { inside: 0, outside: 0, maxIn: 0, maxOut: 0 };
for (const st of fs.readdirSync(path.join(B, 'crops')).filter((s) => s.startsWith(`${theme}-`)).sort()) {
    const fa = path.join(A, 'crops', st, 'full.png'), fb = path.join(B, 'crops', st, 'full.png');
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) continue;
    const a = PNG.sync.read(fs.readFileSync(fa)), b = PNG.sync.read(fs.readFileSync(fb));
    if (a.width !== b.width || a.height !== b.height) { console.log(`${st}: size differs`); continue; }
    const [, size, cs, sc] = st.split('-');
    const k = dpr[size] ?? 1;
    const boxes = [...new Map(rows.filter((r) => `${r.theme}-${r.size}-${r.case}-${r.scroll}` === st && NAMED.test(r.panel)).map((r) => [r.panel, r.box])).values()];
    const inside = (x, y) => boxes.some(([l, t, w, h]) => x >= l * k && x < (l + w) * k && y >= t * k && y < (t + h) * k);
    let nIn = 0, nOut = 0, mIn = 0, mOut = 0;
    const o = imgState === st ? new PNG({ width: a.width, height: a.height }) : null;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
        if (o) { const v = Math.min(255, d * 16); o.data[i] = v; o.data[i + 1] = v; o.data[i + 2] = v; o.data[i + 3] = 255; }
        if (d < MIN) continue;
        if (inside(x, y)) { nIn++; mIn = Math.max(mIn, d); } else { nOut++; mOut = Math.max(mOut, d); }
    }
    if (o) fs.writeFileSync(imgFile, PNG.sync.write(o));
    total.inside += nIn; total.outside += nOut; total.maxIn = Math.max(total.maxIn, mIn); total.maxOut = Math.max(total.maxOut, mOut);
    console.log(`${st.padEnd(34)} inside panes: ${String(nIn).padStart(6)} px (max ${mIn})   outside panes: ${String(nOut).padStart(6)} px (max ${mOut})`);
}
console.log(`TOTAL inside panes ${total.inside} px (max ${total.maxIn}), outside ${total.outside} px (max ${total.maxOut})`);
