# linux-share-matrix

Measures Linux screen sharing (capture, encode, WebGL, system audio) with the **real Electron binary the app ships**,
inside Docker, on many distros x desktop sessions. No login, no account, no network route out (containers sit on an
`--internal` docker network). Nothing is installed on the host.

```sh
harness/linux-share-matrix/run.sh                         # every distro in docker/, sessions: sway kde gnome x11
harness/linux-share-matrix/run.sh ubuntu-24.04 arch       # some distros
SESSIONS="sway x11" run.sh fedora                         # some sessions
GPU=0 run.sh ubuntu-24.04                                 # no /dev/dri: software baseline
KEEP_IMAGES=1 run.sh ...                                  # keep the (1.5-3 GB) distro images; default removes each after its cells
MATRIX_QUICK=1 run.sh ...                                 # dev loop: the default Electron run only (no software/forced runs, no audio suite)
MATRIX_TESTS=env,gpu,encode-canvas MATRIX_DEFAULT_EXTRA_ARGS="--use-fake-device-for-media-stream --use-fake-ui-for-media-stream" MATRIX_QUICK=1 run.sh ...   # the encode stage alone under the app defaults
MATRIX_IMG_SUFFIX=-mine run.sh ...                        # private image/network/container names (two matrix runs at once must not share a tag)
CIPHERLINE_LINUX_HW_ENCODE=0 run.sh ...                   # the whole matrix with hardware encode off
MATRIX_LIBVA_DRIVER=i965 / MATRIX_EXTRA_FEATURES=... / MATRIX_HWENC_EXTRA_ARGS=...   # EXPERIMENT knobs (a libva driver, extra Chromium features, extra Chromium args for the forced-on run)
PKG=1 PKG_DIR=<dir> run.sh ubuntu-24.04                   # + launch/smoke the staging AppImage and .deb found in <dir>
```

Output (default `$OUT_ROOT` = the session scratchpad `linux-matrix/`): `<distro>/<session>/cell.json|cell.md` plus every
raw log, `matrix.md` (parity table + detail), `matrix.json`. Cells run strictly one after another.

## What a cell does
`inside/cell.sh` (as an unprivileged user, under `dbus-run-session`): PipeWire + WirePlumber + pipewire-pulse + a null sink,
a `dbus-monitor` on the ScreenCast portal, then the session (`inside/session-<name>.sh`), then the test app
(`app/`, plain Electron, `--no-sandbox` because the container has no user namespaces) **twice**:

1. with exactly the switches `electron/main.ts` applies on Linux (`--enable-features=WebRTCPipeWireCapturer` plus whatever
   `decideLinuxHwEncode()` says, `--ozone-platform-hint=auto`, `--log-level=3`). The hardware-encode decision is **the app's own
   function**: `run.sh` transpiles `electron/linux-video-encode.ts` and mounts it at `/lve`, so the default run is the real
   default (hardware encode **on** since 2026-11-04, `CIPHERLINE_LINUX_HW_ENCODE=0` turns it off). `run.sh` greps `main.ts` for
   the other switches so drift fails loudly;
2. the same with `CIPHERLINE_LINUX_HW_ENCODE=0` (the software baseline), codec sweep only; then `=1` forced on, codec sweep only.

Run 1 walks the app's own path: `desktopCapturer.getSources` window list, then screen list, then
`setDisplayMediaRequestHandler` -> `getDisplayMedia`, measuring delivered fps (frame counter drawn by a 90 Hz pattern
window and decoded from the captured frames) at 30/60/90 via `applyConstraints`, an `RTCPeerConnection` loopback encode per
codec (`encoderImplementation`, fps, ms/frame, `qualityLimitationReason`), a WebGL probe that DRAWS (`readPixels` and a
`capturePage` of the composited canvas), and system audio through `build/Release/audio_capture.node` with the app excluded.
Portal prompts are counted from the `ScreenCast.Start` D-Bus calls, attributed to the phase that was running.
After the app, the plain-node exclusion suite of `harness/linux-share-audio/` runs against that distro's PipeWire.

## Desktop choosers per user decision (the "one prompt" A/B)
Every Wayland `ScreenCast.Start` is the desktop's chooser on KDE and GNOME, so the number of Starts one user decision costs
IS the number of times the user is asked. A second Electron run per Wayland cell (`phases-flows.log`, `app-flows.json`,
`portal-flows.json`; stages `flow-before` / `flow-after` in `app/main.js`) counts them step by step:

| | BEFORE (control: the app as shipped until 2026-11-04) | AFTER (the one-prompt flow) |
|---|---|---|
| start a share | list both types (1) + capture, answered with the listed id (1) = **2** | capture, answered with a placeholder id, no listing = **1** |
| 30 -> 60 -> 90 fps (and a size step) | `applyConstraints` on the capture, +1 each = **2** | RTP sender `maxFramerate` / `scaleResolutionDownBy`, the capture untouched = **0** |
| republish (codec drift, stall, HW rule) | a new capture = 1 | a clone of the live capture = **0** |
| change of source | list + capture again = **2** | one more capture, with the old track still live when it arrives = **1** |

What the harness established (Electron 43.8.1, stage `probe`, frames pulled): a listing's selection is **not** held for the capture that
follows; a capture answered with a made-up id is one Start; **the same id twice attaches to the running capture with no Start** (so each
capture needs a new numeric id - `portalCaptureVideo(seq)`); every changed constraint on a live portal capture is a new Start. A capture's
own session starts LAZILY (when the first sink attaches), so every step pulls frames and waits before the next marker.
Limits of the cells: sway's portal (xdpw `chooser_type=none`) answers itself, so the full BEFORE/AFTER table is only complete there. On GNOME the
chooser bot (chooser-bot-gnome.py) answers some dialogs and not others - BEFORE's listing often "produces no source" and the control
stops at one Start (the older `sources`/`capture` stages of the same run give GNOME's BEFORE: listing 1 + capture 1, +2 from applyConstraints);
AFTER still counts one Start per capture, with frames flowing whenever the bot answered. KDE's dialog is not answered at all (Start
counts only, frames 0; ubuntu-24.04's KDE portal never comes up). A Start is counted when it is CALLED, answered or not.
`app/main.js` mirrors `electron/main.ts desktop-capturer-resolve` (`handlerMode 'portal-placeholder'`); `run.sh` greps main.ts for the literals it
replays so drift fails loudly. `MATRIX_TESTS=flow` (or `probe`) in the environment runs just that stage in the default Electron run.

## Prerequisites
`apps/desktop/build/Release/audio_capture.node` (`npm run rebuild-native`; run.sh builds it if absent) and the Electron
zip in `~/.cache/electron` (or `node_modules/electron/dist`). Docker; for GPU cells `/dev/dri/renderD128`.

## Not automatable here
NVIDIA and AMD GPUs; the real KDE / GNOME portal choosers on a physical desktop (see the report's tester steps).

## Hardware-encode E2EE proof (`e2e/run-e2e.sh`)
`e2e/run-e2e.sh <distro> h264 vp8 h264-high h264-sw h264-wrongkey` publishes a 1080p60 WebGL share from one Electron window and
watches it from another, through a **throwaway LiveKit v1.9.12** on an `--internal` docker network, with call E2EE on, inside a
distro container with `/dev/dri` and a sway session. The page is `harness/share-e2e` (the app's own publish options, sender
params, lighter-copy gate, E2EE worker + sender-codec pin, viewer arbiter), so what is encrypted and decrypted is the app's code
on whatever bitstream the VA-API encoder writes. Per case it prints the publisher's `encoderImplementation` / `powerEfficientEncoder`,
the viewer's codec / decoded fps, and the worker's Annex-B start-code counts (`e2ee_annexb`: frames, rewritten, short start codes).
`h264-wrongkey` is the negative control (a viewer with another key must decode nothing).

## Capture rate and dialogs (`rate`, `restore` stages; `rate-report.mjs`, `inside/dialogs.mjs`)
`MATRIX_TESTS=rate` (add `sources` first for a listed pick) opens captures through the portal and measures, in ONE window each, what the
capture delivers (`source`: frames/s and size at the track), what the encoder makes of it (`encoded`) and what a loopback viewer decodes
(`viewer`), plus the CPU of the Electron tree and of the desktop side (compositor + portal + PipeWire) and the PipeWire format that was
negotiated (`pw-dump`). Modes (`MATRIX_RATE_MODES`, comma list):
- `open`  the capture is OPENED at the pick: the request is the app's own `portalCaptureRequest`, bundled from `src/` and mounted at `/pcr`.
- `old`   NEGATIVE CONTROL: the capture is opened at the share's maximum (3840x2160, 75 fps: what a3dbc5b3 does), the choice applied on the sender only.
- `live`  ONE capture, raw `applyConstraints` up and down (the probe that showed a re-open is a portal session, silent or not by desktop).
- `plan`  the app's own live-retune decision (`portalRetuneTouchesCapture`) replayed on one share (`MATRIX_RATE_PLAN=1080p@30,1440p@60,...`).
`MATRIX_RATE_HANDLER=chosen` answers captures with a LISTED source (the pick) instead of a made-up id; `MATRIX_RATE_PICK=window|screen` lists in the
stage, otherwise the `sources` stage's screen entry is used. Output size: `MATRIX_W/H` (the virtual monitor), `MATRIX_PAT_W/H` (the pattern window, small
so a big output is not dominated by drawing it), `MATRIX_RATE_FPS`, `MATRIX_RATE_SIZES` (1080p,1440p,source), `MATRIX_RATE_SECS`, `MATRIX_RATE_CODEC`.
`REUSE_IMAGE=1` skips the docker build when `clm-<distro>` exists (with `KEEP_IMAGES=1`, which now also keeps the build cache).

A `ScreenCast.Start` is NOT a dialog. `inside/dialogs.mjs <cell dir>` counts what the user saw per phase: Starts, `SelectSources` that carried a
`restore_token`, streams opened and - on GNOME, whose backend logs one "Failed to associate portal window with parent window" per dialog it opens -
dialogs. What it showed (cachyos GNOME, Electron 43.8.1): a listing = 1 dialog; a capture answered with the listed id = 0 (token sent) and so is every
`applyConstraints` after it; a capture answered with a made-up id = 1 dialog, and each `applyConstraints` on it = 1 more. Chromium sends `persist_mode=1`
on every session and a `restore_token` only for a source that came out of a listing. The PipeWire format is `maxFramerate 60/1` whatever frame rate is asked
(webrtc never lowers it): the request throttles what Chromium takes from the stream, not what the compositor produces.
Limits: the GNOME chooser bot answers WINDOW listings only (it cannot answer the screen dialog and is flaky on the first); sway's `chooser_type=none` never
shows a dialog; the KDE session in the container never delivered a frame or a dialog (3 attempts, GPU and software).
