// Fold a `restore` or `pickflow` stage run: per step, what the capture delivered and what the USER saw (dialogs).
//   node restore-report.mjs <cell dir> [restore|pickflow]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const dir = process.argv[2];
const stage = process.argv[3] || 'restore';
const here = path.dirname(fileURLToPath(import.meta.url));
const app = JSON.parse(fs.readFileSync(path.join(dir, 'app-default.json'), 'utf8'));
const per = JSON.parse(execFileSync('node', [path.join(here, 'inside', 'dialogs.mjs'), dir], { encoding: 'utf8' }));
const r = app.stages && app.stages[stage];
if (!r) { console.log(`no ${stage} stage`, app.errors); process.exit(1); }
if (r.error) console.log(`${stage} stage error:`, r.error);
// the listing of a step happens inside the step's phase (pickflow) or in its own phase (restore): fold both
const listing = (step) => per[`restore:list${step.startsWith('L1') ? 1 : 2}:window`] || {};
for (const s of r.steps) {
  const e = per[`${stage}:${s.step}`] || {};
  const l = stage === 'restore' && /^L\d-list$/.test(s.step) ? listing(s.step) : {};
  const m = s.m && !s.m.error ? s.m : null;
  const ar = s.applyResult || (s.r && s.r.settings ? { settings: s.r.settings, state: 'live' } : s.r);
  const n = (k) => (e[k] ?? 0) + (l[k] ?? 0);
  console.log(
    s.step.padEnd(30),
    `starts=${n('start')} tokenSent=${n('selectWithToken')}/${n('selectWithToken') + n('selectNoToken')} dialogs=${e.dialogs === null ? 'n/a' : (e.dialogs ?? 0) + (l.dialogs ?? 0)} streams=${n('streamsOpened')}`,
    m ? `| src ${m.source.fps}fps ${m.source.size && m.source.size.join('x')}` : (s.m && s.m.error ? `| ${s.m.error}` : ''),
    ar && ar.error ? `| ERR ${ar.error}` : '', ar && ar.state ? `track=${ar.state}` : '',
    s.picked ? `| picked "${s.picked}"` : '',
  );
}
console.log('raw per-phase:', JSON.stringify(per));
