# share-e2e — screen share against a real SFU

One publisher and one viewer (two separate headless Chromium processes) on a
**throwaway** LiveKit container, the viewer's downlink impaired with `tc netem`
inside the SFU's network namespace. Everything that decides layers, bitrates
and fallbacks is the app's own code, bundled from `src/`:
`buildScreenSharePublishOptions` / `applyScreenShareSenderParams`
(screenShare.ts), `installShareLowLayerControl` (shareLowLayer.ts), the
viewer's `claimRemoteQuality` + `pickShareLayer` as a focused fullscreen tile
(remoteVideoQuality.ts), `CallEventMonitor` (share loss fallback, freeze /
layer / health events), the app's E2EE worker + `installE2EESenderCodecPin`.

Never point it at prod.

## Setup (once)

```sh
S=/path/to/scratch            # outside the repo
docker network create ckh-net-pub; docker network create ckh-net-view
# lk.yaml: port 7880, rtc.tcp_port 7881, rtc.udp_port 7882, use_external_ip false,
#          rtc.congestion_control {enabled: true, allow_pause: true} (as prod),
#          keys: {<key>: <secret ≥ 32 chars>}, room.auto_create true
docker run -d --name ckh-lk-verify --network ckh-net-pub -v $S/lk.yaml:/lk.yaml:ro \
  livekit/livekit-server:v1.9.12 --config /lk.yaml
docker network connect ckh-net-view ckh-lk-verify && docker restart ckh-lk-verify
# tc sidecar in the SFU's netns (image: node:20-alpine + apk add iproute2-tc)
docker run -d --name ckh-tc-side --net container:ckh-lk-verify --cap-add NET_ADMIN <tc-image> sleep infinity
# build the page
OUT_DIR=$S/dist npx vite build -c harness/share-e2e/vite.config.ts   # from apps/desktop
# a source clip (Chromium's fake capture device plays it; a WebGL canvas is the fallback source)
ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=30,noise=alls=2:allf=t" -t 4 -pix_fmt yuv420p $S/clip.y4m
```

The publisher only talks to the SFU's `ckh-net-pub` address and the viewer
only to its `ckh-net-view` address (the page drops the server's other ICE
candidates), so netem on the view interface impairs the viewer's downlink
only.

## Run

```sh
LK_KEY=<key> LK_SECRET=<secret> DIST=$S/dist PUB_IP=<pub-net ip> VIEW_IP=<view-net ip> \
  node run.mjs --mode incident --out $S/a.jsonl --codec h264 --fps 15 --res 1080p --w 1920 --h 1080 \
  --viewers 2 --rate 3mbit --clip $S/clip.y4m [--gate off]
node run.mjs --summarize $S/a.jsonl
```

Modes: `incident` (clean 3 min → throttle 3 min → clean 3 min → 20 % loss /
jitter bursts 10 s on / 10 s off for 3 min → clean 3 min), `baseline`
(`--secs`, unimpaired), `quick`, `probe`. `--gate off` skips the
lighter-copy gate (LiveKit dynacast alone = a sharer whose gate allows the
copy); with the gate on, `--hw false` stops stamping the share's encoder as
hardware (the gate never runs the copy on a software encoder).

## Limits

No hardware encoder here: software OpenH264 manages ~15 fps at 1080p with
both layers (and drops resolution under CPU load), nowhere near 1440p90
NVENC/H.265. Proves the SFU / layer / fallback mechanics, not encoder cost.
Clean up: `docker rm -f ckh-tc-side ckh-lk-verify; docker network rm ckh-net-pub ckh-net-view`.
