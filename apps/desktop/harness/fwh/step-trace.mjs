// args: <durationMs> <outName> [play=1]
// Records a Chrome trace over CDP while pressing Space on a rhythm (the game swims / restarts),
// then closes and reopens nothing: the overlay stays open.
import fs from 'node:fs';
export default async (page, { args }) => {
  const dur = Number(args[0] ?? 30000), out = `${process.env.S}/${args[1] ?? 'trace'}.json`, play = args[2] !== '0';
  const cdp = await page.context().newCDPSession(page);
  const cats = [
    '-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
    'toplevel', 'toplevel.flow', 'v8.execute', 'v8', 'disabled-by-default-v8.gc', 'blink.user_timing', 'blink', 'loading',
    'renderer.scheduler', 'ipc', 'mojom', 'gpu', 'viz', 'cc', 'benchmark', 'blink.animations', 'blink_gc', 'scheduler',
  ];
  const chunks = [];
  cdp.on('Tracing.dataCollected', (e) => { for (const ev of e.value) chunks.push(ev); });
  const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: cats, recordMode: 'recordContinuously' }, transferMode: 'ReportEvents' });
  const t0 = Date.now();
  let presses = 0;
  if (play) await page.locator('.fw-root').focus().catch(() => {});
  while (Date.now() - t0 < dur) {
    if (play) { await page.keyboard.down('Space'); await page.keyboard.up('Space'); presses++; }
    await page.waitForTimeout(play ? 330 + Math.round(Math.random() * 120) : 500);
  }
  await cdp.send('Tracing.end');
  await done;
  fs.writeFileSync(out, JSON.stringify({ traceEvents: chunks }));
  return `trace ${out} events=${chunks.length} presses=${presses}`;
};
