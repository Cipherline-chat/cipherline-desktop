// UI responsiveness in the REAL renderer while the user works: for args[1] seconds, alternate between the rail
// servers named args[2] and args[3] (by their rail title), open #general, type a message keystroke by keystroke
// and send it. Meanwhile the page records long tasks (> 50 ms on the main thread), frame gaps (rAF deltas) and
// Event Timing durations (input -> next paint) for every key / click. Returns the numbers, labelled args[0].
//   node pw.mjs <port> step-measure.mjs <label> <seconds> <serverA> <serverB>
export default async (page, { args }) => {
  const [label, secs = '30', a, b] = args;
  await page.evaluate(() => {
    const w = window;
    w.__m = { long: [], frames: [], events: [], t0: performance.now(), stop: false };
    try { const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__m.long.push(e.duration); }); po.observe({ type: 'longtask' }); w.__m.po1 = po; } catch { /* unsupported */ }
    try { const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__m.events.push({ n: e.name, d: e.duration }); }); po.observe({ type: 'event', durationThreshold: 16, buffered: false }); w.__m.po2 = po; } catch { /* unsupported */ }
    let last = performance.now();
    const loop = (t) => { w.__m.frames.push(t - last); last = t; if (!w.__m.stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  const until = Date.now() + Number(secs) * 1000;
  let sent = 0; let switches = 0; let i = 0;
  const pill = async () => (await page.locator('[data-testid="import-pill"]').first().textContent().catch(() => null)) ?? '(no pill)';
  const pillStart = await pill();
  while (Date.now() < until) {
    const target = i++ % 2 === 0 ? a : b;
    if (target) {
      await page.locator(`nav [title="${target}"], nav img[alt="${target}"]`).first().click().catch(() => undefined);
      switches++;
      await page.waitForTimeout(700);
      await page.locator('nav, aside, body').getByText('general', { exact: true }).first().click().catch(() => undefined);
      await page.waitForTimeout(500);
    }
    const box = page.locator('[contenteditable="true"], textarea').last();
    if (await box.isVisible().catch(() => false)) {
      await box.click().catch(() => undefined);
      await page.keyboard.type(`typing while importing ${label} #${sent + 1}`, { delay: 45 });
      await page.keyboard.press('Enter');
      sent++;
    }
    await page.waitForTimeout(600);
  }
  const pillEnd = await pill();
  const m = await page.evaluate(() => {
    const w = window; w.__m.stop = true; w.__m.po1?.disconnect(); w.__m.po2?.disconnect();
    const q = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
    const f = w.__m.frames.slice(2);
    const ev = w.__m.events.filter((e) => /key|click|pointer|input/.test(e.n)).map((e) => e.d);
    return {
      seconds: Math.round((performance.now() - w.__m.t0) / 1000),
      longTasks: { count: w.__m.long.length, totalMs: Math.round(w.__m.long.reduce((s, x) => s + x, 0)), maxMs: Math.round(Math.max(0, ...w.__m.long)) },
      frames: { n: f.length, p50: q(f, 0.5), p95: q(f, 0.95), p99: q(f, 0.99), max: Math.round(Math.max(0, ...f)), over100ms: f.filter((x) => x > 100).length },
      inputToPaint: { n: ev.length, p50: q(ev, 0.5), p95: q(ev, 0.95), max: Math.round(Math.max(0, ...ev)), over200ms: ev.filter((x) => x > 200).length },
    };
  });
  return { label, sent, switches, pillStart, pillEnd, ...m };
};
