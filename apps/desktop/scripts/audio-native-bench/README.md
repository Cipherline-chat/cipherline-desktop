# audio-native-bench

Measures the native "Strong" noise-suppression hand-off in a REAL Electron: the real compiled preload, `audio-engine-ipc`, utility-process
host, `cl_audio_node.node` addon and `clAudioWorklet.js`, fed by a real-time `AudioContext` (no sound card needed: `--disable-audio-output`).

```bash
cd apps/desktop
npm run build-audio-node                                           # addon (RETIRED path; the model must be supplied by hand into resources/dfn/)
node scripts/audio-native-bench/build.mjs /tmp/bench-out            # compiles electron/ (tsc) + bundles the page glue (esbuild)
cat > /tmp/bench-out/plan.json <<'JSON'
{"outDir":"/tmp/bench-out","out":"/tmp/bench-out/results.json","steps":[
 {"name":"idle J=2","native":true,"jitter":2,"seconds":300},
 {"name":"loaded J=2","native":true,"jitter":2,"seconds":300,"load":{"at":60,"seconds":120,"procs":40}},
 {"name":"latency","native":true,"jitter":2,"seconds":12,"recordSeconds":8},
 {"name":"kill","native":true,"jitter":2,"seconds":20,"recordSeconds":18,"killAt":8}]}
JSON
xvfb-run -a npx electron --no-sandbox scripts/audio-native-bench/main.cjs /tmp/bench-out/plan.json
node scripts/audio-native-bench/analyze.mjs /tmp/bench-out/results.json
node scripts/audio-native-bench/cpu.cjs ll 60; node scripts/audio-native-bench/cpu.cjs std 60   # engine CPU alone, paced like a call
```

Per step it reports the worklet -> utility process -> worklet round trip (1 ms steps: `Date.now()`, the worklet has no high-resolution
clock), the arrival slack in samples (so the underruns at any jitter depth can be re-derived), host processing time, the utility process CPU
and RSS (`/proc`, once a second), the measured input -> output delay (cross-correlation) and the longest zero run of the output
(continuity). `load` starts busy-loop processes for part of the run, `killAt` SIGKILLs the utility process. Results depend on what else the
machine is doing: always note the load average.
