// node analyze.mjs <rec dir> : per-frame indicator geometry after each click, and the bug signature.
// A healthy switch keeps the painted box inside the span of the two tiles (from the upper tile's top to the lower
// tile's bottom). The reported bug paints outside that span (the top edge thrown above the rail / the bottom past the
// target) and holds a full-span stretch for a long time.
import fs from 'node:fs';
const dir = process.argv[2];
const { marks, geo } = JSON.parse(fs.readFileSync(`${dir}/geo.json`, 'utf8'));
let bad = 0;
const out = [];
for (let m = 0; m < marks.length; m++) {
    const from = marks[m].now, to = marks[m + 1]?.now ?? Infinity;
    const rows = geo.filter((r) => r.now >= from - 50 && r.now < to);
    if (!rows.length) continue;
    const startTop = rows[0].top, h0 = rows[0].height;
    const endTop = rows[rows.length - 1].top;
    const lo = Math.min(startTop, endTop), hi = Math.max(startTop, endTop) + h0;
    out.push(`-- click ${marks[m].click}: ${startTop} -> ${endTop} (span ${lo}..${hi})`);
    let prevTs = null, stretchedMs = 0;
    for (const r of rows) {
        const outside = r.top < lo - 0.5 || r.top + r.height > hi + 0.5;
        if (outside) bad++;
        const dts = prevTs === null ? 0 : r.ts - prevTs;
        if (r.height > h0 + 1 && prevTs !== null) stretchedMs += dts;
        prevTs = r.ts;
        out.push(`  ${(r.now - from).toFixed(0).padStart(6)}ms dt=${dts.toFixed(0).padStart(4)} top=${r.top.toFixed(1).padStart(7)} h=${r.height.toFixed(1).padStart(6)} w=${r.width.toFixed(1)}${outside ? '  <-- OUTSIDE THE SPAN' : ''}`);
    }
    out.push(`  stretched for ${stretchedMs.toFixed(0)} ms`);
}
out.push(`frames painted outside the span: ${bad}`);
console.log(out.join('\n'));
