// Electron main for the native-Strong bench. Uses the REAL compiled preload, audio-engine-ipc, utility-process host, addon and worklet.
//   xvfb-run -a npx electron scripts/audio-native-bench/main.cjs <plan.json>
// plan.json: { outDir: <build.mjs output>, out: <results.json>, steps: [ { name, ...runOptions, load?: {at, seconds, procs}, killAt?: seconds, restart?: true } ] }
// Each step runs one real-time call in the page (window.__bench.run) while main samples the utility process (/proc CPU + RSS once a second).
const { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const plan = JSON.parse(fs.readFileSync(process.argv.find((a) => a.endsWith('.json')), 'utf8'));
const desktop = path.resolve(__dirname, '../..');
const dist = path.join(plan.outDir, 'dist-electron');
const { registerAudioEngineIpc } = require(path.join(dist, 'audio-engine-ipc.js'));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-audio-output'); // no sound card here: the fake output stream pulls the AudioContext in real time
app.disableHardwareAcceleration();

let child = null;
const ticks = (pid) => { try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return Number(f[11]) + Number(f[12]); } catch { return null; } };
const rssKb = (pid) => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]); } catch { return null; } };
const CLK = 100;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { preload: path.join(dist, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 || /\[bench\]/.test(msg)) console.log('[page]', msg.slice(0, 300)); });
  win.webContents.on('preload-error', (_e, p, err) => console.log('[preload-error]', p, String(err)));
  const files = { host: path.join(dist, 'audio-engine-host.js'), addon: path.join(desktop, 'build/Release/cl_audio_node.node'), model: path.join(desktop, 'resources/dfn/DeepFilterNet3_ll_onnx.tar.gz') };
  if (plan.addon) files.addon = plan.addon;
  if (plan.files) Object.assign(files, plan.files);   // e.g. a PACKAGED layout: host inside app.asar, addon in app.asar.unpacked, model in resources/dfn
  const ctl = registerAudioEngineIpc({
    ipc: ipcMain, newChannel: () => new MessageChannelMain(), files, exists: (p) => fs.existsSync(p),
    fork: (h) => { child = utilityProcess.fork(h, [], { serviceName: 'Cipherline audio engine', stdio: 'inherit' }); return child; },
    log: (l) => console.log('[AudioEngine]', l),
  });
  await win.loadFile(path.join(__dirname, 'page.html'));
  const assets = { worklet: fs.readFileSync(path.join(desktop, 'src/audio/clAudioWorklet.js'), 'utf8'), wasmB64: fs.readFileSync(path.join(desktop, 'src/audio/engine/cl_audio.wasm')).toString('base64') };
  await win.webContents.executeJavaScript(`window.__assets = ${JSON.stringify(assets)};`);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(plan.outDir, 'page-glue.js'), 'utf8'));
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8'));
  const has = await win.webContents.executeJavaScript('typeof window.audioEngine + "/" + typeof window.__clNative');
  console.log('[bench] window.audioEngine / glue:', has, 'available:', JSON.stringify(await win.webContents.executeJavaScript('window.__bench.available()')));

  const results = [];
  for (const step of plan.steps) {
    console.log('[bench] step', step.name);
    const loads = [];
    const samples = [];
    let pid = null, lastT = null, lastWall = null, killedAt = null, killedPid = null;
    const sampler = setInterval(() => {
      if (!child || !child.pid) return;
      if (pid !== child.pid) { pid = child.pid; lastT = ticks(pid); lastWall = Date.now(); return; }
      const t = ticks(pid), now = Date.now();
      if (t !== null && lastT !== null) samples.push({ at: now, cpuPct: ((t - lastT) / CLK) / ((now - lastWall) / 1000) * 100, rssMb: (rssKb(pid) || 0) / 1024 });
      lastT = t; lastWall = now;
    }, 1000);
    const timers = [];
    const started = () => Date.now();
    // the page signals the start of the measured part by setting window.__benchStarted; main polls for it to schedule load / kill
    const sched = setInterval(async () => {
      let st = null;
      try { st = await win.webContents.executeJavaScript('window.__benchStarted || 0'); } catch { return; }
      if (!st) return;
      clearInterval(sched);
      if (step.load) timers.push(setTimeout(() => {
        console.log('[bench] load on', step.load.procs);
        for (let i = 0; i < step.load.procs; i++) { const c = spawn(process.execPath, ['-e', 'for(;;){}'], { env: { ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }); loads.push(c); }
        loadStart = Date.now();
        timers.push(setTimeout(() => { for (const c of loads) c.kill('SIGKILL'); loadEnd = Date.now(); }, step.load.seconds * 1000));
      }, step.load.at * 1000));
      if (step.stopAt !== undefined) timers.push(setTimeout(() => { const pid2 = child && child.pid; console.log('[bench] SIGSTOP utility', pid2, 'for', step.stopMs, 'ms'); try { process.kill(pid2, 'SIGSTOP'); setTimeout(() => { try { process.kill(pid2, 'SIGCONT'); } catch {} }, step.stopMs); } catch (e) { console.log(e.message); } }, step.stopAt * 1000));
      if (step.killAt !== undefined) timers.push(setTimeout(() => { killedPid = child && child.pid; killedAt = Date.now(); console.log('[bench] SIGKILL utility', killedPid); try { process.kill(killedPid, 'SIGKILL'); } catch (e) { console.log(e.message); } }, step.killAt * 1000));
    }, 100);
    var loadStart = null, loadEnd = null;
    await win.webContents.executeJavaScript('window.__benchStarted = 0; 0');
    if (step.wavFile) {   // a PRIVATE recording is read in place and handed to the page as base64; the output goes where step.outF32 says (scratchpad only)
      await win.webContents.executeJavaScript(`window.__wav = ${JSON.stringify(fs.readFileSync(step.wavFile).toString('base64'))}; 0`);
    }
    const opts = JSON.stringify({ ...step, wavFile: !!step.wavFile });
    let res;
    try { res = await win.webContents.executeJavaScript(step.ackTimes ? `window.__bench.ackTimes(${opts})` : step.hostOnly ? `window.__bench.runHostOnly(${opts})` : `window.__bench.run(${opts})`); } catch (e) { res = { error: String(e) }; }
    if (step.outF32 && res && res.recB64) { fs.writeFileSync(step.outF32, Buffer.from(res.recB64, 'base64')); res.recB64 = '(written)'; }
    clearInterval(sampler); clearInterval(sched); for (const t of timers) clearTimeout(t); for (const c of loads) c.kill('SIGKILL');
    results.push({ step, res, samples, loadStart, loadEnd, killedAt, killedPid, startedAt: await win.webContents.executeJavaScript('window.__benchStarted || 0').catch(() => 0) });
    fs.writeFileSync(plan.out, JSON.stringify({ results }));
    if (step.pauseAfterS) await new Promise((r) => setTimeout(r, step.pauseAfterS * 1000));
  }
  ctl.stop();
  console.log('[bench] done ->', plan.out);
  app.quit();
}).catch((e) => { console.error('[bench] FATAL', e); app.exit(1); });
