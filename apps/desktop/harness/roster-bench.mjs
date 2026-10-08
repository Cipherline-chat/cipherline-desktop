// Member-roster bench driver (see harness/roster-main.tsx).
//
//   1. copy the pre-change panel next to the real one (untracked):
//        <base>:apps/desktop/src/components/server/ServerContextPanel.tsx -> ServerContextPanel.old.tsx
//   2. build the variants you want to compare, each into its own dir, and serve each on its own port:
//        ROSTER_BENCH_OUT=/tmp/rb-inc  npx vite build --config harness/roster.vite.config.ts
//        python3 -m http.server 5289 --directory /tmp/rb-inc
//      "cache only" = the same build with ROW_BATCH raised to 1e6 in src/utils/incrementalRows.ts.
//   3. node harness/roster-bench.mjs      (env: MEMBERS SERVERS REPS CYCLES RTTS=0,60,200 BASE_INC BASE_CACHE_ONLY PW_CHROMIUM_EXE)
//
// Needs `playwright-core` and a Chromium headless shell. Take timings on a quiet box: wall-clock
// inflates several-fold under load (a load average of 15+ showed ~7x), so check `uptime` first.
// Production builds only: dev-mode React (jsxDEV) is several times slower and says nothing about the shipped app.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const exe = process.env.PW_CHROMIUM_EXE;
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const INC = process.env.BASE_INC ?? 'http://127.0.0.1:5289/harness/roster.html';
const CACHE_ONLY = process.env.BASE_CACHE_ONLY ?? 'http://127.0.0.1:5290/harness/roster.html';
const VARIANTS = [
  { name: 'old   (before)',          base: INC, impl: 'old' },
  { name: 'cache only',              base: CACHE_ONLY, impl: 'new' },
  { name: 'cache + incremental rows', base: INC, impl: 'new' },
];

async function run(browser, v, rtt, members, servers, cycles) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async n => (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === n).value;
  await page.goto(`${v.base}?impl=${v.impl}&rtt=${rtt}&members=${members}&servers=${servers}`);
  await page.waitForFunction(() => window.__bench && window.__bench.ready, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const sw = i => page.evaluate(async i => window.__bench.switchTo(i), i);
  const req0 = await page.evaluate(() => window.__bench.requests);
  const cold = [];
  for (let i = 0; i < servers; i++) cold.push((await sw(i)).paintMs);
  await page.waitForTimeout(1500);
  const reqCold = (await page.evaluate(() => window.__bench.requests)) - req0;
  // Heap + live DOM with every server visited once.
  await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
  const heapMB = (await metric('JSHeapUsedSize')) / 1048576;
  const domNodes = await page.evaluate(() => document.getElementsByTagName('*').length);

  // Revisit loop, inside the freshness window for `new` (no refetch), always refetching for `old`.
  const t0 = await metric('TaskDuration');
  const walls = [];
  for (let k = 0; k < cycles; k++) for (let i = 0; i < servers; i++) walls.push((await sw(i)).paintMs);
  await page.waitForTimeout(300);
  const t1 = await metric('TaskDuration');
  const reqRevisit = (await page.evaluate(() => window.__bench.requests)) - req0 - reqCold;

  // Idle main-thread time, 10 s, nothing happening.
  await page.waitForTimeout(1000);
  const i0 = await metric('TaskDuration');
  await page.waitForTimeout(10000);
  const idle = ((await metric('TaskDuration')) - i0) * 1000;
  await ctx.close();
  return { coldFirst: cold[0], coldRest: median(cold.slice(1)), revisitWall: median(walls), taskPerSwitch: (t1 - t0) * 1000 / (cycles * servers), reqCold, reqRevisit, heapMB, domNodes, idle };
}

const members = Number(process.env.MEMBERS ?? 62), servers = Number(process.env.SERVERS ?? 6), reps = Number(process.env.REPS ?? 3), cycles = Number(process.env.CYCLES ?? 3);
const rtts = (process.env.RTTS ?? '60').split(',').map(Number);
const browser = await chromium.launch({ executablePath: exe, args: ['--js-flags=--expose-gc', '--disable-gpu'] });
try {
  for (const rtt of rtts) {
    console.log(`\n=== ${members} members/server, ${servers} servers, simulated API latency ${rtt} ms (median of ${reps}) ===`);
    for (const v of VARIANTS) {
      const rs = []; for (let k = 0; k < reps; k++) rs.push(await run(browser, v, rtt, members, servers, cycles));
      const m = f => median(rs.map(f));
      console.log(`${v.name.padEnd(26)} firstOpen ${m(r => r.coldFirst).toFixed(0).padStart(4)} ms | other cold ${m(r => r.coldRest).toFixed(0).padStart(4)} ms | revisit ${m(r => r.revisitWall).toFixed(0).padStart(4)} ms (main-thread ${m(r => r.taskPerSwitch).toFixed(0)} ms) | GETs cold ${m(r => r.reqCold)} / ${cycles}x revisit ${m(r => r.reqRevisit)} | heap ${m(r => r.heapMB).toFixed(1)} MB | DOM ${m(r => r.domNodes)} | idle ${m(r => r.idle).toFixed(0)} ms/10s`);
    }
  }
} finally { await browser.close(); }
