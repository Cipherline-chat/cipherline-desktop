// Summarise panel-corners-probe.mjs runs side by side.
//   node harness/panel-corners-summary.mjs --runs=base:<dir>,fixed:<dir> [--min=2] [--theme=dark] [--cards=0]
// One row per panel + corner (named panels; --cards=1 adds the generic cards):
// the worst delta over every case / size / scroll, and where it happened.
import fs from 'fs';
import path from 'path';
const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? `--${n}=${d}`).split('=').slice(1).join('=');
const runs = arg('runs', '').split(',').filter(Boolean).map((s) => { const [label, dir] = s.split(':'); return { label, rows: JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) }; });
const MIN = Number(arg('min', '2'));
const theme = arg('theme', 'dark');
const cards = arg('cards', '0') === '1';
const family = (r) => r.panel.startsWith('card:') ? `${r.case}/${r.panel}` : r.panel.replace(/\d+$/, '');
const keys = new Set();
const worst = runs.map(({ rows }) => {
    const m = new Map();
    for (const r of rows) {
        if (r.theme !== theme || (!cards && r.panel.startsWith('card:'))) continue;
        if (r.panel.startsWith('card:') && r.radius >= Math.min(r.box[2], r.box[3]) / 2 - 1) continue; // circles (avatars): no corner
        const k = `${family(r)} ${r.corner}`;
        keys.add(k);
        const cur = m.get(k);
        if (!cur || r.delta > cur.delta) m.set(k, { delta: r.delta, where: `${r.case} ${r.size} ${r.scroll}`, n: cur?.n ?? 0 });
        m.get(k).n += r.delta >= MIN ? 1 : 0;
    }
    return m;
});
const pad = (s, n) => String(s).padEnd(n);
console.log(pad('panel corner', 34) + runs.map((r) => pad(`${r.label} (max, #states>=${MIN}, worst at)`, 52)).join(''));
for (const k of [...keys].sort()) {
    const cells = worst.map((m) => { const w = m.get(k); return w ? pad(`${w.delta}  ${w.n}  ${w.where}`, 52) : pad('-', 52); });
    if (worst.every((m) => (m.get(k)?.delta ?? 0) < MIN)) continue;
    console.log(pad(k, 34) + cells.join(''));
}
