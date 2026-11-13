// driver/run.mjs <desktop> [scenario ...]   (normally started by run.sh)
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lab.mjs';
import * as S from './session.mjs';
import * as P from './probes.mjs';
import { SCENARIOS, ORDER } from './scenarios.mjs';

const desktop = process.argv[2] || 'sway';
const want = process.argv.slice(3).length ? process.argv.slice(3) : ORDER;
fs.mkdirSync(L.RESULTS, { recursive: true });
const out = path.join(L.RESULTS, `results-${desktop}`);
const results = { desktop, started: new Date().toISOString(), scenarios: {}, facts: {} };
const save = () => { fs.writeFileSync(out + '.json', JSON.stringify(results, null, 1)); fs.writeFileSync(out + '.md', toMarkdown(results)); };

function toMarkdown(r) {
  const rows = Object.entries(r.scenarios).map(([k, v]) => `| ${k} | ${v.status} | ${(v.why || v.criteria || '').replace(/\|/g, '/').slice(0, 160)} | ${brief(v)} |`);
  return [`# Linux e2e lab: ${r.desktop}`, '', `started ${r.started}; ${JSON.stringify(r.facts)}`, '', '| scenario | result | criteria / why | key numbers |', '|---|---|---|---|', ...rows, ''].join('\n');
}
function brief(v) {
  const bits = [];
  if (v.viewer) bits.push(`viewer ${v.viewer.res} ${v.viewer.dec_fps_counter}fps ${v.viewer.decoder ?? ''}`);
  if (v.sharer) bits.push(`sharer ${v.sharer.res} enc ${v.sharer.encoder ?? '?'} hw=${v.sharer.hardware_encoder} ${v.sharer.codec ?? ''}`);
  if (v.app_events?.share_fps) bits.push(`app share_fps cap=${v.app_events.share_fps.cap_fps} src=${v.app_events.share_fps.src_fps} enc=${v.app_events.share_fps.enc_fps} sent=${v.app_events.share_fps.sent_fps} limit=${v.app_events.share_fps.limit}`);
  if (v.portal) bits.push(`portal Start=${v.portal.start} chooser=${v.portal.chooserRuns}`);
  if (v.viewer_received_audio_tracks) bits.push(v.viewer_received_audio_tracks.map((t) => `${t.peakHz}Hz(1000:${t.db1000 - t.floorDb}dB 440:${t.db440 - t.floorDb}dB)`).join(' '));
  return bits.join('; ').replace(/\|/g, '/');
}

let ctx;
try {
  L.log(`bring-up: sharer on ${desktop}, viewer on x11`);
  ctx = await S.bringUp({ desktop, sharerOpts: { cpus: process.env.LAB_CPUS || '6', gpu: process.env.LAB_GPU !== '0', env: process.env.LAB_APP_ENV ? { LAB_APP_ENV: process.env.LAB_APP_ENV } : {} } });
  ctx.desktop = desktop;
  await Promise.all([P.install(ctx.s.page), P.install(ctx.v.page)]);
  await S.startCall(ctx);
  await L.sleep(8000);
  results.facts = { kernel: L.sh('uname', ['-r']).trim(), uptime: L.sh('uptime', []).trim(), nproc: L.sh('nproc', []).trim(), electron: fs.readFileSync(path.join(L.OUT, 'lab.env'), 'utf8').match(/CLE2E_ELECTRON_DIST=.*electron-dist-([\d.]+)/)?.[1] ?? 'node_modules', sharer_facts: fs.readFileSync(path.join(L.OUT, 'run/sharer/facts.txt'), 'utf8').split('\n').filter(Boolean) };
  for (const name of want) {
    const fn = SCENARIOS[name];
    if (!fn) { results.scenarios[name] = { status: 'skipped', why: 'unknown scenario' }; continue; }
    L.log(`scenario ${name}`);
    try { results.scenarios[name] = await Promise.race([fn(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error(`scenario timed out after ${process.env.LAB_SCENARIO_TIMEOUT_S || 300}s`)), 1000 * (+process.env.LAB_SCENARIO_TIMEOUT_S || 300)))]); }
    catch (e) { results.scenarios[name] = { status: 'fail', why: `driver error: ${String(e.message || e).slice(0, 300)}` }; try { await (await import('./app.mjs')).shot(ctx.s.page, `error-${name}-${desktop}`); await S.recover(ctx); } catch { /* none */ } }
    L.log(`  -> ${results.scenarios[name].status}`);
    save();
  }
} finally {
  save();
  console.log(toMarkdown(results));
  L.stopClients();
}
