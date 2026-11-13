// Folds one cell's raw output into cell.json + cell.md, and every cell into matrix.json + matrix.md.
//   node report.mjs cell   <cellDir> <distro> <session>
//   node report.mjs matrix <outRoot>
import fs from 'node:fs';
import path from 'node:path';

const rj = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const rt = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

function facts(dir) {
  const o = {}; for (const l of (rt(path.join(dir, 'facts.txt')) || '').split('\n')) { const m = l.match(/^([\w-]+)=(.*)$/); if (m) o[m[1]] = m[2]; } return o;
}

/** Hardware encode entrypoints a driver advertises, from `vainfo` text: only the Enc* lines count. */
function vaEncode(dir) {
  const out = {};
  for (const drv of ['iHD', 'i965', 'radeonsi', 'nouveau']) {
    const t = rt(path.join(dir, `vainfo-${drv}.txt`)); if (!t) continue;
    const enc = t.split('\n').filter((l) => /VAEntrypointEnc/.test(l)).map((l) => l.trim().replace(/\s+/g, ' '));
    const driver = (t.match(/Driver version: (.*)/) || [])[1] || null;
    out[drv] = { opened: /vainfo: Driver version/.test(t), driver, encodeProfiles: enc, error: enc.length || /Driver version/.test(t) ? null : t.split('\n').find((l) => /error|failed/i.test(l)) || null };
  }
  return out;
}

function summarizeCell(dir, distro, session) {
  const cell = { distro, session, notPackaged: fs.existsSync(path.join(dir, 'NOT_PACKAGED')) };
  if (cell.notPackaged) return cell;
  cell.facts = facts(dir);
  const app = rj(path.join(dir, 'app-default.json')), hw = rj(path.join(dir, 'app-hwenc.json')), sweep = rj(path.join(dir, 'app-sweep.json'));
  cell.app = app; cell.hwenc = hw; cell.sweep = sweep;
  cell.portal = rj(path.join(dir, 'portal.json'));
  cell.flowsApp = rj(path.join(dir, 'app-flows.json'));
  cell.flowsPortal = rj(path.join(dir, 'portal-flows.json'));
  cell.chooserBot = rt(path.join(dir, 'chooser-bot.log'));
  cell.audioSuite = (() => {
    const r = rj(path.join(dir, 'audio', 'results.json')); if (!r) return null;
    // The suite's "absent" bar is -90 dBFS (digital silence). A residual below -60 dBFS is inaudible: report it as marginal, not failed.
    const levels = (d) => ((d || '').match(/-?\d+(\.\d+)?(?= dBFS)/g) || []).map(Number);
    const marginal = r.assertions.filter((a) => !a.ok && /absent/.test(a.name) && levels(a.detail).length && levels(a.detail).every((v) => v <= -60));
    const failed = r.assertions.filter((a) => !a.ok && !marginal.includes(a));
    return { total: r.assertions.length, failed: failed.map((a) => a.name + ' -- ' + a.detail), marginal: marginal.map((a) => a.name + ' -- ' + a.detail), exclusionFailed: failed.filter((a) => /^S[1-5]/.test(a.name)).length };
  })();
  cell.vaapi = vaEncode(dir);
  const st = (app && app.stages) || {};
  const hs = (hw && hw.stages) || {};
  const ss = (sweep && sweep.stages) || {};
  const fps = (kind, n) => { const k = st.capture && st.capture[kind]; const f = k && k.fps && k.fps.find((x) => x.requested === n); return f || null; };
  const enc = (s, source) => (((source === 'screen' ? s['encode-screen'] : s['encode-canvas']) || {}).results) || [];
  cell.derived = {
    appStarts: !!(st.env && !st.env.error), appError: (app && app.errors) || [],
    ozone: st.env && st.env.effectiveOzonePlatform,
    glRenderer: (st.webgl && st.webgl.probes && st.webgl.probes['dots-webgl1'] && st.webgl.probes['dots-webgl1'].renderer) || null,
    featureStatus: st.gpu && st.gpu.featureStatus, hwEncodeStatusDefault: st.gpu && st.gpu.featureStatus && st.gpu.featureStatus.video_encode,
    hwEncodeStatusFlag: hs.gpu && hs.gpu.featureStatus && hs.gpu.featureStatus.video_encode,
    addonLoads: st.addon ? !!st.addon.loaded : null, addonSupported: st.addon && st.addon.isSupported, addonError: st.addon && st.addon.error,
    promptsScreen: cell.portal ? cell.portal.promptsScreenShare : null,
    promptsScreenSplit: cell.portal ? `${cell.portal.promptsScreenShare_getSources}+${cell.portal.promptsScreenShare_getDisplayMedia}` : null,
    promptsWindow: cell.portal ? cell.portal.promptsWindowShare : null,
    screenSourcesOffered: st.sources && st.sources.screenList ? st.sources.screenList.sources.length : null,
    windowSourcesOffered: st.sources && st.sources.windowList ? st.sources.windowList.sources.length : null,
    patternWindowOffered: st.sources ? st.sources.patternWindowFound : null,
    screenFps: { 30: fps('screen', 30), 60: fps('screen', 60), 90: fps('screen', 90) },
    windowFps: st['capture-window'] ? st['capture-window'].fps : null,
    screenStartError: st.capture && st.capture.screen && st.capture.screen.startError,
    encodeCanvas: enc(ss, 'canvas'), encodeScreen: enc(st, 'screen'),
    encodeCanvasHw: enc(hs, 'canvas'),
    webglDraws: st.webgl && st.webgl.probes ? Object.fromEntries(Object.entries(st.webgl.probes).map(([k, v]) => [k, v.available ? !!v.drew : null])) : null,
    webglPresented: st.webgl && st.webgl.presented ? st.webgl.presented.ok : null,
    electronAudio: st.audio ? st.audio.verdict || st.audio.skipped || st.audio.error : null,
    flows: flowsSummary(cell.flowsApp, cell.flowsPortal),
  };
  fs.writeFileSync(path.join(dir, 'cell.json'), JSON.stringify(cell, null, 2));
  fs.writeFileSync(path.join(dir, 'cell.md'), cellMd(cell));
  return cell;
}

const f1 = (x) => (x == null ? '?' : x);

/** The A/B: ScreenCast.Start calls (= desktop choosers) per step of one user decision, BEFORE (the app as shipped) and AFTER (one prompt). */
function flowsSummary(app, portal) {
  if (!portal || !portal.flows || !app) return null;
  const st = (app && app.stages) || {};
  const fl = portal.flows;
  const sum = (f, names) => (f ? names.reduce((a, n) => a + (f.steps[n] || 0), 0) : null);
  const afterSteps = (st['flow-after'] && st['flow-after'].steps) || [];
  const fpsKept = afterSteps.filter((s) => /^fps-/.test(s.step)).map((s) => `${s.maxFramerate}->${s.encodedFps}`).join(' ');
  return {
    before: fl.before ? {
      total: fl.before.total,
      perShare: sum(fl.before, ['pick', 'capture']),
      fpsChanges: sum(fl.before, ['retune-60', 'retune-90']),
      changeSource: sum(fl.before, ['change-pick', 'change-capture']),
    } : null,
    after: fl.after ? {
      total: fl.after.total,
      perShare: sum(fl.after, ['capture']),
      fpsChanges: sum(fl.after, ['fps-30', 'fps-60', 'fps-90', 'size-half', 'fps-30-again']),
      republish: sum(fl.after, ['republish']),
      changeSource: sum(fl.after, ['change']),
      oldShareLiveWhenNewArrived: st['flow-after'] && st['flow-after'].change ? st['flow-after'].change.oldTrackStateWhenNewArrived : null,
      senderFps: fpsKept,
      framesAfterChange: (afterSteps.find((s) => s.step === 'after-change') || {}).encodedFps ?? null,
    } : null,
    raw: fl,
  };
}
function encSummary(list) {
  if (!list || !list.length) return 'n/a';
  return list.map((r) => {
    if (r.error) return `${r.key}: ERR ${r.error}`;
    const hw = /External|Vaapi|VideoToolbox|MediaFoundation|NVENC/i.test(r.encoderImplementation || '') || r.powerEfficientEncoder;
    return `${r.key}: ${r.encoderImplementation || '?'}${hw ? ' [HW]' : ' [SW]'} ${f1(r.encodedFps)}fps ${f1(r.encodeMsPerFrame)}ms q=${r.qualityLimitationReason}`;
  }).join('<br>');
}

function cellMd(c) {
  if (c.notPackaged) return `# ${c.distro} / ${c.session}\nnot packaged on this distro\n`;
  const d = c.derived || {};
  const L = [`# ${c.distro} / ${c.session}`, '', '```', JSON.stringify(c.facts, null, 1), '```', ''];
  L.push(`- app starts: ${d.appStarts}; ozone: ${d.ozone}; GL: ${d.glRenderer}`);
  L.push(`- addon: loaded=${d.addonLoads} supported=${d.addonSupported} ${d.addonError || ''}`);
  L.push(`- portal prompts: screen=${d.promptsScreen} (${d.promptsScreenSplit}), window=${d.promptsWindow}`);
  if (d.flows) L.push(`- portal prompts per share, BEFORE -> AFTER: share ${d.flows.before ? d.flows.before.perShare : '?'} -> ${d.flows.after ? d.flows.after.perShare : '?'}; fps changes ${d.flows.before ? d.flows.before.fpsChanges : '?'} -> ${d.flows.after ? d.flows.after.fpsChanges : '?'}; republish on the kept capture -> ${d.flows.after ? d.flows.after.republish : '?'}; change of source ${d.flows.before ? d.flows.before.changeSource : '?'} -> ${d.flows.after ? d.flows.after.changeSource : '?'}`);
  L.push(`- screen fps: ` + [30, 60, 90].map((n) => { const x = d.screenFps[n]; return x ? `@${n}: raw ${x.fps} / unique ${x.uniqueFps ?? '?'} / source ${x.sourceFps ?? '?'}` : `@${n}: n/a`; }).join('; '));
  L.push(`- encode (canvas, 1080p60): <br>${encSummary(d.encodeCanvas)}`);
  L.push(`- encode (canvas, +AcceleratedVideoEncoder): <br>${encSummary(d.encodeCanvasHw)}`);
  L.push(`- webgl draws: ${JSON.stringify(d.webglDraws)} presented: ${d.webglPresented}`);
  L.push(`- audio: ${JSON.stringify(c.audioSuite)}; electron: ${d.electronAudio}`);
  return L.join('\n') + '\n';
}

function fpsCell(x) { if (!x) return 'n/a'; const u = x.changedFps ?? x.uniqueFps ?? x.fps; return `${u}${x.sourceFps ? ` (src ${x.sourceFps})` : ''}`; }
function encCompact(list) {
  if (!list || !list.length) return 'n/a';
  const by = {}; for (const r of list) by[r.key] = r;
  return ['video/vp8', 'video/vp9', 'h264-cb', 'h264-high', 'video/av1', 'video/h265'].filter((k) => by[k]).map((k) => {
    const r = by[k]; const n = k.replace('video/', '');
    if (r.error) return `${n}: ERR`;
    const impl = (r.encoderImplementation || '?').replace(/^(\w+).*/, '$1');
    const hw = /External|Vaapi/i.test(r.encoderImplementation || '') || r.powerEfficientEncoder ? 'HW' : 'SW';
    return `${n}: ${impl}/${hw} ${f1(r.encodedFps)}`;
  }).join('<br>');
}

function matrix(root) {
  const cells = [];
  for (const dd of fs.readdirSync(root)) {
    const dp = path.join(root, dd); if (!fs.statSync(dp).isDirectory() || dd.startsWith('_')) continue;
    if (fs.existsSync(path.join(dp, 'BUILD_FAILED'))) { cells.push({ distro: dd, session: '(image)', buildFailed: rt(path.join(dp, 'BUILD_FAILED')) }); continue; }
    for (const s of fs.readdirSync(dp)) {
      const cp = path.join(dp, s); if (!fs.statSync(cp).isDirectory() || s.startsWith('pkg-')) continue;
      cells.push(rj(path.join(cp, 'cell.json')) || { distro: dd, session: s, missing: true });
    }
  }
  fs.writeFileSync(path.join(root, 'matrix.json'), JSON.stringify(cells, null, 2));
  const L = ['# Linux share matrix', '', `generated ${new Date().toISOString()}`, ''];
  L.push('## Parity table', '');
  L.push('| distro | session | app starts | addon loads | portal prompts / screen share | screen capture fps @30 / @60 / @90 (unique frames; src = pattern rAF rate) | encoder per codec (hardware encode OFF: CIPHERLINE_LINUX_HW_ENCODE=0, 1080p60 canvas) | encoder with hardware encode forced ON | WebGL draws / presented | audio: addon suite / Electron self-exclusion |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of cells) {
    if (c.buildFailed) { L.push(`| ${c.distro} | - | image build failed | | | | | | | |`); continue; }
    if (c.notPackaged) { L.push(`| ${c.distro} | ${c.session} | not packaged | | | | | | | |`); continue; }
    if (c.missing) { L.push(`| ${c.distro} | ${c.session} | no result | | | | | | | |`); continue; }
    const d = c.derived || {};
    if (!d.appStarts) { L.push(`| ${c.distro} | ${c.session} | NO (${(d.appError || []).join('; ').slice(0, 80) || (c.app && c.app.session_failed ? 'session failed' : 'no app output')}) | | | | | | | |`); continue; }
    const gl = d.webglDraws ? Object.entries(d.webglDraws).map(([k, v]) => `${k}:${v == null ? 'n/a' : v ? 'Y' : 'N'}`).join(' ') + ` / ${d.webglPresented ? 'Y' : 'N'}` : '?';
    const aud = `${c.audioSuite ? `${c.audioSuite.total - c.audioSuite.failed.length}/${c.audioSuite.total}` : 'n/a'} / ${(d.electronAudio || 'n/a').toString().slice(0, 48)}`;
    const prompts = d.promptsScreen == null ? 'n/a' : `${d.promptsScreen} (${d.promptsScreenSplit})`;
    L.push(`| ${c.distro} | ${c.session} | yes (${d.ozone || '?'}) | ${d.addonLoads ? (d.addonSupported ? 'yes' : 'loads, unsupported') : 'NO'} | ${prompts} | ${[30, 60, 90].map((n) => fpsCell(d.screenFps[n])).join(' / ')} | ${encCompact(d.encodeCanvas)} | ${encCompact(d.encodeCanvasHw)} | ${gl} | ${aud} |`);
  }
  // the headline of the one-prompt work: desktop choosers per user decision, before and after
  L.push('', '## Desktop choosers (ScreenCast.Start) per user decision: BEFORE -> AFTER', '');
  L.push('Counted from `dbus-monitor` on `org.freedesktop.portal.ScreenCast.Start` with the real Electron and the app\'s exact Linux switches (app/main.js stages `flow-before` / `flow-after`). BEFORE = the app as shipped: the picker lists, the capture asks again, each fps change is `applyConstraints` on the capture, changing source repeats it all. AFTER = one capture asked for once at the share\'s maximum; fps / size on the RTP sender; a republish on a clone of the live capture; changing source is one more capture while the old share keeps running. Expected after the fix: 1 / 0 / 0 / 1.', '');
  L.push('| distro | session | start a share | 30 -> 60 -> 90 fps (+ size, + back) | republish (codec drift / stall / HW rule) | change of source | old share live when the new capture arrived | sender fps as set -> encoded |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const c of cells) {
    const f = c.derived && c.derived.flows;
    if (!f) continue;
    const b = f.before || {}, a = f.after || {};
    L.push(`| ${c.distro} | ${c.session} | ${b.perShare ?? '?'} -> **${a.perShare ?? '?'}** | ${b.fpsChanges ?? '?'} -> **${a.fpsChanges ?? '?'}** | n/a -> **${a.republish ?? '?'}** | ${b.changeSource ?? '?'} -> **${a.changeSource ?? '?'}** | ${a.oldShareLiveWhenNewArrived ?? '?'} | ${a.senderFps || '?'} |`);
  }
  // per-cell detail: GPU, hardware encode status, VA-API, capture timing, encoder cost
  L.push('', '## Per-cell detail', '');
  L.push('| distro | session | WebGL renderer | Chromium video_encode: off -> on | VA-API (iHD) H.264 encode entrypoints | window-list portal Start / extra portal sessions from applyConstraints | capture raw fps @30/60/90 (frame gap p95 ms @90) | encoder ms/frame: off -> on (VP8, H264-CB, VP9) |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const c of cells) {
    const d = c.derived; if (!d || !d.appStarts) continue;
    const va = c.vaapi && c.vaapi.iHD ? (c.vaapi.iHD.encodeProfiles.filter((x) => /H264/.test(x)).length ? c.vaapi.iHD.encodeProfiles.filter((x) => /H264/.test(x)).map((x) => x.replace(/VAProfile|VAEntrypoint/g, '').replace(/\s*:\s*/, ':')).join(', ') : (c.vaapi.iHD.opened ? 'opened, no H264 encode' : 'driver did not open')) : 'n/a';
    const ms = (list, k) => { const r = (list || []).find((x) => x.key === k); return r ? (r.error ? 'ERR' : f1(r.encodeMsPerFrame)) : '-'; };
    const row = (k) => `${ms(d.encodeCanvas, k)}->${ms(d.encodeCanvasHw, k)}`;
    const fr = [30, 60, 90].map((n) => (d.screenFps[n] ? d.screenFps[n].fps : '-')).join('/') + (d.screenFps[90] && d.screenFps[90].dtMs ? ` (${d.screenFps[90].dtMs.p95})` : '');
    L.push(`| ${c.distro} | ${c.session} | ${d.glRenderer || '?'} | ${d.hwEncodeStatusDefault || '?'} -> ${d.hwEncodeStatusFlag || '?'} | ${va} | ${c.portal ? c.portal.windowListPromptedPortal : 'n/a'} / ${c.portal ? c.portal.extraSessionsFromApplyConstraints : 'n/a'} | ${fr} | VP8 ${row('video/vp8')}; H264 ${row('h264-cb')}; VP9 ${row('video/vp9')} |`);
  }

  // packaged staging build (AppImage / .deb) launch + addon load
  const pk = [];
  for (const dd of fs.readdirSync(root)) {
    const dp = path.join(root, dd); if (!fs.statSync(dp).isDirectory() || dd.startsWith('_')) continue;
    for (const kind of ['appimage', 'deb']) { const j = rj(path.join(dp, `pkg-${kind}`, `pkg-${kind}.json`)); if (j) pk.push({ distro: dd, kind, ...j }); }
  }
  if (pk.length) {
    L.push('', '## Packaged staging build (1.0.24-staging.196) launch / smoke check', '');
    L.push('| distro | package | app starts + paints (smoke report) | addon loads inside the app | addon plain-node load | addon needs glibc / libstdc++ | missing libs |');
    L.push('|---|---|---|---|---|---|---|');
    for (const p of pk) {
      if (p.skipped) { L.push(`| ${p.distro} | ${p.kind} | skipped: ${p.skipped} | | | | |`); continue; }
      const sr = p.smokeReport; const paint = sr ? `yes (${JSON.stringify(sr).slice(0, 90)})` : 'NO smoke report';
      L.push(`| ${p.distro} | ${p.kind} | ${paint} | ${p.addonLoadedInApp ? 'yes' : 'NO ' + (p.addonNotLoadedLine || '')} | ${p.addonPlainNodeLoad || '?'} | ${p.addonGlibcMax || '?'} / ${p.addonGlibcxxMax || '?'} | ${p.addonLddMissing || 'none'} |`);
    }
  }
  fs.writeFileSync(path.join(root, 'matrix.md'), L.join('\n') + '\n');
}

const [cmd, a, b, c] = process.argv.slice(2);
if (cmd === 'cell') summarizeCell(a, b, c);
else if (cmd === 'matrix') matrix(a);
else { console.error('usage: report.mjs cell <dir> <distro> <session> | matrix <root>'); process.exit(2); }
