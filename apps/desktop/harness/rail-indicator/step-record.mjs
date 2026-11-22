// Record the rail indicator through a sequence of REAL rail clicks in the running app.
//   node pw.mjs <cdp> step-record.mjs <label> <cpuThrottle> <click> [<click> ...]
// A click is `dm`, `groups`, or `srv:<n>` (the n-th server in the rail, 0-based; the rail is scrolled so the tile is
// clickable exactly as a user would). Between clicks the app idles 1.2 s.
// Writes to $S/rec-<label>/:
//   frames/NNNN.jpg  every screencast frame (CDP Page.startScreencast, everyNthFrame 1) with its compositor timestamp
//   frames.json      [{ file, ts }]
//   geo.json         one row per renderer animation frame: rAF timestamp, the indicator's top/height/width
//                    (the painted inline style), plus the click marks
//   rail.json        the rail box in CSS px (for cropping) and the device scale
import fs from 'node:fs';
const S = process.env.S;
export default async (page, { ctx, args }) => {
    const [label, throttle, ...clicks] = args;
    const dir = `${S}/rec-${label}`;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(`${dir}/frames`, { recursive: true });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(throttle) || 1 });

    // A per-frame logger of the indicator's painted geometry (renderer side, no app code involved).
    await page.evaluate(() => {
        const w = window;
        w.__risGeo = [];
        w.__risOn = true;
        const ind = () => document.querySelector('[data-testid="rail-scroll"] .cl-rail-indicator');
        const tick = (ts) => {
            const el = ind();
            if (el) w.__risGeo.push({ ts, now: performance.now(), top: parseFloat(el.style.top), height: parseFloat(el.style.height), width: parseFloat(el.style.width), radius: el.style.borderRadius, opacity: getComputedStyle(el).opacity, scroll: el.parentElement.scrollTop });
            if (w.__risOn) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });

    const frames = [];
    let n = 0;
    cdp.on('Page.screencastFrame', async (f) => {
        const file = `${String(n++).padStart(4, '0')}.jpg`;
        fs.writeFileSync(`${dir}/frames/${file}`, Buffer.from(f.data, 'base64'));
        frames.push({ file, ts: f.metadata.timestamp });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
    await page.waitForTimeout(600);

    const marks = [];
    for (const c of clicks) {
        const sel = c === 'dm' ? '[data-rail-id="nav:dm"]'
            : c === 'groups' ? '[data-rail-id="nav:group"]'
                : null;
        let loc;
        if (sel) loc = page.locator(sel).first();
        else {
            const i = Number(c.split(':')[1]);
            loc = page.locator('[data-testid="rail-scroll"] [data-rail-id^="srv:"]').nth(i).locator('button').first();
        }
        await loc.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        const t = await page.evaluate(() => performance.now());
        const wall = Date.now() / 1000;
        await loc.click();
        marks.push({ click: c, now: t, wall });
        await page.waitForTimeout(1200);
    }
    await cdp.send('Page.stopScreencast');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const geo = await page.evaluate(() => { window.__risOn = false; return window.__risGeo; });
    const rail = await page.evaluate(() => {
        const r = document.querySelector('nav.app-rail').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight };
    });
    fs.writeFileSync(`${dir}/frames.json`, JSON.stringify(frames));
    fs.writeFileSync(`${dir}/geo.json`, JSON.stringify({ marks, geo }));
    fs.writeFileSync(`${dir}/rail.json`, JSON.stringify(rail));
    // Signature of the bug: a painted box that leaves the span between the two tiles (above the upper one or
    // below the lower one), or that grows taller than the two tiles together.
    return { frames: frames.length, geoRows: geo.length, marks, rail };
};
