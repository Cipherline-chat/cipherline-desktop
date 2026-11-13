/**
 * The REAL main-process controller (electron/annotation-overlay-wayland.ts) driving the REAL helper
 * binary inside a compositor lab — everything between "the renderer sent a delta" and "pixels on the
 * screen", with only Electron's `screen` replaced by a JSON list (the lab has no Electron).
 * Bundled with esbuild by run.sh and run with the host's node inside the container.
 *
 *   HELPER=<binary> DISPLAYS_JSON='[...]' FRAME_JSON='{"width":..,"height":..}' HOLD_MS=6000 \
 *   DRIVE_FLAG=<file touched once the zig-zag is complete> node controller-e2e.js
 */
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';
import { createWaylandOverlay, type HelperProc } from '../../../electron/annotation-overlay-wayland';

const helper = process.env.HELPER ?? '';
const displays = JSON.parse(process.env.DISPLAYS_JSON ?? '[]');
const frame = JSON.parse(process.env.FRAME_JSON ?? 'null');
const holdMs = Number(process.env.HOLD_MS ?? 6000);

const env: NodeJS.ProcessEnv = {};
for (const k of ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DISPLAY', 'XAUTHORITY', 'HOME']) if (process.env[k]) env[k] = process.env[k];

const ov = createWaylandOverlay({
    spawnHelper: () => spawn(helper, [], { stdio: ['pipe', 'pipe', 'ignore'], env }) as unknown as HelperProc,
    getDisplays: () => displays,
    now: () => Date.now(),
    log: m => console.log('  main log: ' + m),
    onEnded: () => console.log('  main: overlay ended'),
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
    const r = await ov.show({ id: 'screen:0:0', display_id: '' }, frame);
    console.log('show -> ' + JSON.stringify(r));
    if (!r.ok) { process.exitCode = 3; return; }
    // Exactly what the renderer does for a live pen: an upsert with the first point(s), then append
    // deltas as the stroke grows, every one stamped with the time of its last point.
    const zig: Array<[number, number]> = [[0.05, 0.1], [0.3, 0.9], [0.5, 0.5], [0.7, 0.1], [0.95, 0.9]];
    const id = 'e2e-' + Math.random().toString(16).slice(2);
    const pts = (a: Array<[number, number]>) => a.map(([x, y]) => ({ x, y }));
    ov.push({ reset: true, upsert: [{ id, color: '#ff3b6b', width: 4, points: pts([zig[0]]), updatedAt: Date.now(), closedAt: 0 }] });
    for (let seg = 1; seg < zig.length; seg++) {
        for (let k = 1; k <= 10; k++) {
            const [ax, ay] = zig[seg - 1], [bx, by] = zig[seg];
            ov.push({ append: [{ id, points: pts([[ax + (bx - ax) * k / 10, ay + (by - ay) * k / 10]]), updatedAt: Date.now(), closedAt: 0 }] });
            await sleep(15);
        }
    }
    if (process.env.DRIVE_FLAG) writeFileSync(process.env.DRIVE_FLAG, 'drawn\n');
    // the pen stays down: a stationary pen still sends points (a tiny wobble keeps the stroke live)
    const end = Date.now() + holdMs;
    while (Date.now() < end) {
        ov.push({ append: [{ id, points: pts([zig[4]]), updatedAt: Date.now(), closedAt: 0 }] });
        await sleep(250);
    }
    ov.hide();
    await sleep(300);
    console.log('hidden; shown=' + ov.isShown());
})().catch(e => { console.error(e); process.exitCode = 1; });
