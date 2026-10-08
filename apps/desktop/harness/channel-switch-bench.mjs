// Channel-switch bench driver for the member sidebar (see harness/channel-switch-main.tsx).
//
//   1. copy the pre-change panel next to the real one (untracked):
//        git show origin/staging:apps/desktop/src/components/server/ServerContextPanel.tsx \
//          > apps/desktop/src/components/server/ServerContextPanel.old.tsx
//   2. ROSTER_BENCH_OUT=/tmp/cs  npx vite build --config harness/roster.vite.config.ts
//      python3 -m http.server 5291 --directory /tmp/cs
//   3. node harness/channel-switch-bench.mjs   (env: MEMBERS REPS CYCLES RTTS=0,60,200 BASE PW_CHROMIUM_EXE)
//
// Same caveats as roster-bench.mjs: production build only, quiet box only.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const BASE = process.env.BASE ?? 'http://127.0.0.1:5291/harness/channel-switch.html';

async function run(browser, impl, rtt, members, cycles) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?impl=${impl}&rtt=${rtt}&members=${members}`);
  await page.waitForFunction(() => window.__bench && window.__bench.ready, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const sw = i => page.evaluate(async i => window.__bench.switchTo(i), i);
  const req0 = await page.evaluate(() => window.__bench.requests);
  // Cold: first visit of each channel. c1 (2 viewers) BEFORE c2 (30 viewers), so
  // a full-roster flash on c2's first visit is visible as maxRows > 30.
  const coldC1 = await sw(1);
  const coldC2 = await sw(2);
  const coldC3 = await sw(3);
  await page.waitForTimeout(300);
  const reqCold = (await page.evaluate(() => window.__bench.requests)) - req0;
  const pub = [], res = [];
  for (let k = 0; k < cycles; k++) for (const i of [0, 1, 2, 3]) {
    const r = await sw(i);
    (i === 1 || i === 2 ? res : pub).push(r.paintMs);
  }
  await page.waitForTimeout(300);
  const reqRevisit = (await page.evaluate(() => window.__bench.requests)) - req0 - reqCold;
  // A never-seen restricted channel (c4, 5 viewers) clicked after the pointer
  // rested on its row for HOVER ms — the channel list's hover prefetch.
  const hovered = await page.evaluate(async d => window.__bench.hoverThenSwitch(4, d), Number(process.env.HOVER ?? 300));
  await ctx.close();
  return { hovered: hovered.paintMs, coldC1: coldC1.paintMs, coldC2: coldC2.paintMs, coldC2Max: coldC2.maxRows, coldC3: coldC3.paintMs, pub: median(pub), res: median(res), reqCold, reqRevisit };
}

const members = Number(process.env.MEMBERS ?? 100), reps = Number(process.env.REPS ?? 5), cycles = Number(process.env.CYCLES ?? 5);
const rtts = (process.env.RTTS ?? '60').split(',').map(Number);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_EXE, args: ['--disable-gpu'] });
try {
  for (const rtt of rtts) {
    console.log(`\n=== ${members} members, simulated API latency ${rtt} ms (median of ${reps}) ===`);
    for (const impl of ['old', 'new']) {
      const rs = []; for (let k = 0; k < reps; k++) rs.push(await run(browser, impl, rtt, members, cycles));
      const m = f => median(rs.map(f));
      console.log(`${impl.padEnd(4)} first visit: restricted(2) ${m(r => r.coldC1).toFixed(0).padStart(4)} ms, restricted(30) ${m(r => r.coldC2).toFixed(0).padStart(4)} ms [max rows seen ${m(r => r.coldC2Max)}], public ${m(r => r.coldC3).toFixed(0).padStart(3)} ms | revisit: public ${m(r => r.pub).toFixed(1)} ms, restricted ${m(r => r.res).toFixed(1)} ms | GETs first-visits ${m(r => r.reqCold)} / ${cycles}x revisit ${m(r => r.reqRevisit)} | click after ${process.env.HOVER ?? 300} ms hover on a never-seen restricted channel ${m(r => r.hovered).toFixed(0)} ms`);
    }
  }
} finally { await browser.close(); }
