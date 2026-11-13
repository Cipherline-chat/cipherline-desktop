/**
 * The REAL X11 annotation overlay (electron/annotation-overlay.ts: real BrowserWindow, real preload,
 * real helper binary for the compositor probe/watch and the window rectangle) driven inside the lab's
 * Xvfb, the way the renderer drives it: ask main to show the overlay for the share, push a stroke
 * around the whole frame, and ask again whenever the overlay is not up (the renderer's own retry after
 * a refusal or an `annot-overlay:ended`).
 *
 * Bundled with esbuild by run.sh (external: electron) and run with the real Electron binary by
 * lab/run-x11-electron.sh. Output is `HARNESS ...` lines on stdout; the shell script screenshots the
 * X framebuffer and asserts on pixels.
 *
 *   CL_SOURCE_ID=screen:0:0 | window:<XID>:0     what is shared
 *   CL_LIST_SOURCES=1                            also print what desktopCapturer offers (id + thumbnail size)
 */
import { app, desktopCapturer } from 'electron';
import {
    showAnnotationOverlay, pushAnnotationOverlayDelta, isAnnotationOverlayShown, setAnnotationOverlayEndedListener,
} from '../../../electron/annotation-overlay';

app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');
app.on('window-all-closed', () => { /* the overlay comes and goes; keep driving */ });

const log = (m: string): void => console.log(`HARNESS ${Date.now()} ${m}`);

const stroke = (now: number) => ({
    id: 'lab', color: '#ff3b6b', width: 10,
    points: [
        { x: 0.03, y: 0.03 }, { x: 0.97, y: 0.03 }, { x: 0.97, y: 0.97 }, { x: 0.03, y: 0.97 }, { x: 0.03, y: 0.03 },
    ],
    updatedAt: now, closedAt: 0,
});

void app.whenReady().then(async () => {
    const id = process.env.CL_SOURCE_ID ?? 'screen:0:0';
    setAnnotationOverlayEndedListener(reason => log(`ENDED ${reason}`));
    if (process.env.CL_LIST_SOURCES) {
        try {
            const srcs = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1600, height: 1200 } });
            for (const s of srcs) {
                const t = s.thumbnail.getSize();
                log(`SOURCE ${s.id} display_id=${s.display_id || '-'} thumb=${t.width}x${t.height}`);
            }
        } catch (e) { log(`SOURCES failed ${String(e)}`); }
    }
    let last = '';
    let wasShown = false;
    const tick = async (): Promise<void> => {
        if (!isAnnotationOverlayShown()) {
            if (wasShown) { wasShown = false; log('OVERLAY down'); }
            const r = await showAnnotationOverlay({ id, display_id: '' });
            const k = JSON.stringify(r);
            if (k !== last) { last = k; log(`SHOW ${k}`); }
            if (!r.ok) return;
            wasShown = true;
        }
        pushAnnotationOverlayDelta({ reset: true, upsert: [stroke(Date.now())] });
    };
    setInterval(() => { void tick(); }, 400);
    void tick();
});
