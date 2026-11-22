#!/usr/bin/env node
/**
 * Prove a PACKAGED build carries a working native Strong engine: node scripts/check-packaged-audio-engine.mjs <unpacked app dir>
 * (or the electron-builder `release` dir that contains win-unpacked / linux-unpacked / mac*). Looks where the app looks (electron/main.ts): the addon in
 * resources/app.asar.unpacked/build/Release/, the model in resources/dfn/; verifies the model's sha256, loads the addon with plain
 * Node-API (same OS/arch as the runner), loads the model and processes a few frames. Exit 0 = engine present and working; exit 1 = missing or
 * broken, which the workflow reports as a warning (the app then offers Light) unless CL_REQUIRE_AUDIO_NODE=1 makes it fatal.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.argv[2];
if (!root || !existsSync(root)) { console.error('usage: check-packaged-audio-engine.mjs <unpacked app dir>'); process.exit(2); }
const subs = ['win-unpacked', 'linux-unpacked', 'linux-x64-unpacked', 'mac-universal', 'mac-arm64', 'mac', 'mac-x64'].map((n) => join(root, n)).filter(existsSync);
const candidates = [...subs.flatMap((d) => [join(d, 'resources'), ...readdirSync(d).filter((n) => n.endsWith('.app')).map((n) => join(d, n, 'Contents', 'Resources'))]), join(root, 'resources'), join(root, 'Contents', 'Resources'), ...(readdirSync(root).filter((n) => n.endsWith('.app')).map((n) => join(root, n, 'Contents', 'Resources')))];
const resources = candidates.find((d) => existsSync(join(d, 'app.asar')) || existsSync(join(d, 'app.asar.unpacked')));
const problems = [];
const addon = resources && join(resources, 'app.asar.unpacked', 'build', 'Release', 'cl_audio_node.node');
const model = resources && join(resources, 'dfn', 'DeepFilterNet3_ll_onnx.tar.gz');
const host = resources && join(resources, 'app.asar');
if (!resources) problems.push(`no resources dir under ${root}`);
if (addon && !existsSync(addon)) problems.push(`addon missing: ${addon}`);
if (model && !existsSync(model)) problems.push(`model missing: ${model}`);
if (host && !existsSync(host)) problems.push('app.asar missing');
const EXPECT = '5998e58e8ba0e09bb76986ef97b84afa065a571ef282d4a1222f341e3251cf3a';
if (!problems.length) {
  const bytes = readFileSync(model);
  if (createHash('sha256').update(bytes).digest('hex') !== EXPECT) problems.push('model sha256 mismatch');
  else {
    try {
      const { ClAudioNode } = createRequire(import.meta.url)(resolve(addon)) /* absolute: a relative path is looked up as a package name */;
      const e = new ClAudioNode(48000);
      if (e.failed()) throw new Error('engine failed to build: ' + e.lastError());
      if (!e.setStrongModel(bytes)) throw new Error('model rejected: ' + e.lastError());
      if (!e.setSettings({ noise: 2, autoGain: true, manualGainDb: 0, originalSound: false, idleSkip: true })) throw new Error('settings rejected');
      const f = Float32Array.from({ length: 480 }, (_, i) => 0.1 * Math.sin(i * 0.05));
      for (let k = 0; k < 20; k++) if (e.process480(f) !== 0) throw new Error('process480 failed');
      const s = e.stats(false);
      if (s.effectiveNoise !== 2 || e.delaySamples() !== 480) throw new Error(`not the low-delay Strong profile (noise ${s.effectiveNoise}, delay ${e.delaySamples()})`);
      console.log(`packaged native Strong OK: ${addon} (${readFileSync(addon).length} bytes) + model, Strong low-delay, 20 frames processed`);
    } catch (err) { problems.push('addon/model did not work: ' + (err instanceof Error ? err.message : err)); }
  }
}
if (problems.length) {
  for (const p of problems) console.log(`::warning title=Native Strong noise suppression::${p}`);
  console.log('this build ships WITHOUT working native Strong (the app offers Light)');
  process.exit(1);
}
