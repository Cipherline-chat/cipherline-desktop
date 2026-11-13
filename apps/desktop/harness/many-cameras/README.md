# many-cameras: N remote cameras against a real SFU

Measures what a viewer pays for a call with N people on camera, and proves the E2EE transform sits in front of the decoder.
N synthetic participants (own LiveKit Room, own PeerConnection, own E2EE worker, a 640x360 animated-canvas camera published with
simulcast 180p + 360p and the shared key) run in ONE Chromium; the viewer runs in ANOTHER, so its CPU (CDP
`SystemInfo.getProcessInfo`, cumulative seconds per browser process) is its own. The viewer's tile logic is the app's code
(`remoteVideoQuality.ts` pickTileLayer / claimRemoteQuality / chooseDecodedSet / decodeCapFor, `remoteVideoDemand.ts`
retainRemoteVideo). Never point it at prod.

Policies (`--policy`, comma list):

| policy | meaning |
|---|---|
| `high` | every tile asks for the top layer, nothing capped (naive reference) |
| `layers` | per-tile layer by size, nothing capped (the app in Automatic before the cap) |
| `capped` | per-tile layer by size + `AUTO_DECODE_CAP` decoded tiles, the rest avatars (the app now) |

## Setup

```sh
S=/path/to/scratch
# lk.yaml: port 7890, rtc.tcp_port 7891, rtc.port_range_start/end 50000-50999, node_ip 127.0.0.1, use_external_ip false,
#          keys: {<key>: <secret >= 32 chars>}, room.auto_create true
docker run -d --name mc-lk --net host -v $S/lk.yaml:/lk.yaml:ro livekit/livekit-server:v1.9.12 --config /lk.yaml
OUT_DIR=$S/dist npx vite build -c harness/many-cameras/vite.config.ts      # from apps/desktop
```

## Run

```sh
cd harness/many-cameras
LK_KEY=<key> LK_SECRET=<secret> DIST=$S/dist node run.mjs --n 25 --policy high,layers,capped --cols 7 --cell 200x112 --out $S/res.jsonl
LK_KEY=<key> LK_SECRET=<secret> DIST=$S/dist node run.mjs --proof          # E2EE: right-key vs wrong-key viewer
```

`--secs` (measure window, default 25 s after a 12 s settle), `--mode auto|reduced|datasaver`, `--cap N` (override the cap).
Output per run (JSON): viewer CPU cores (total + per process type), publisher-host CPU cores, active decodes, decoded fps /
Mpx per second, presented fps, layer heights in use, jitter buffer, E2EE errors.

Caveat: 50 software-encoding publishers on a shared 32-core dev box cannot hold 15 fps each (decoded fps is below N x 15 in the
tables); compare policies against each other within a row, not against an ideal.

## Results (2026-11-10, dev box: 32 cores, no GPU, software VP8, E2EE on, 640x360 15 fps cameras, 180p/360p simulcast)

Viewer CPU in cores (one Chromium, 25 s window after settle). `high` = every tile at the top layer; `layers` = per-tile layer by size
(the app in Automatic before the cap); `capped` = layers + the 25-tile decode cap (the app now).

| cameras | policy | tiles decoded | viewer CPU | decoded Mpx/s | layers in use |
|---|---|---|---|---|---|
| 10 | high / layers / capped | 10 | 0.57 / 0.36 / 0.35 | 34.4 / 8.7 / 8.6 | 360 / 180 / 180 |
| 25 | high / layers / capped | 25 | 1.47 / 0.91 / 0.83 | 86.5 / 21.6 / 21.7 | 360 / 180 / 180 |
| 50 | high / layers | 50 | 2.66 / 1.47 | 173 / 43 | 360 / 180 |
| 50 | capped | 25 (+ ~6 still draining before the SFU pause) | 1.02 | 42 | 180 (25), 360 (6 draining) |
| 40 | capped | 25 | 0.74 | 21.6 | 180 |

Per-tile layer selection alone cut viewer CPU ~40% (4x fewer decoded pixels); the cap bounds it for a big call (50 cameras 1.47 -> 1.02
cores; the SFU pause is what stops the other 25 arriving). Decode here is software; with hardware decode the per-stream cost moves to
the GPU. Publisher-host CPU is the synthetic cameras', not the app's.

E2EE proof (`--proof`, 1 publisher, right-key viewer vs wrong-key viewer): right key 229 frames decoded, 16 key frames, 1/1 tile
painted; wrong key 0 frames decoded, 0 key frames, 6 EncryptionErrors, 0 tiles painted. The decrypt transform runs ahead of the
decoder, so a hardware decoder is fed the same decrypted frames (not provable here without a GPU).
