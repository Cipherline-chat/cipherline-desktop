# linux-e2e-lab

Two REAL Cipherline desktop clients (Electron 43 running `apps/desktop` built from this tree: renderer + `dist-electron` + the native
`audio_capture.node`) in one DM call over a fully local, isolated server stack. The sharer runs on a Linux desktop session
(sway/wlroots, KWin, mutter/GNOME, or Xvfb+openbox), the viewer on X11. Everything is measured from the app itself.

```sh
harness/linux-e2e-lab/up.sh                         # image + API build + app build + server stack (idempotent; first time ~10 min)
harness/linux-e2e-lab/run.sh desktop=sway           # all scenarios on a Wayland sharer      (desktop=x11|sway|kde|gnome)
harness/linux-e2e-lab/run.sh desktop=x11 share-audio change-source     # some scenarios
LAB_APP_ENV=CIPHERLINE_LINUX_HW_ENCODE=1 run.sh desktop=x11 vaapi      # opt-in VA-API encode, Intel /dev/dri passed through
harness/linux-e2e-lab/down.sh                       # tear down: clients, compose project `cle2e`, network `cle2e-net`, image
```

Results: `$LAB_RESULTS` (default: the session scratchpad `linux-e2e/`) `results-<desktop>.json|md` + `shots/*.png`.

## What runs where
| piece | how |
|---|---|
| server stack | compose project `cle2e`, `cle2e-*` containers on `172.29.88.0/24`, tmpfs data: Postgres, Redis, MinIO, LiveKit v1.9.12, and the API built from THIS tree (`build-api.sh`, tsc) with attestation off, `REGISTER_POW_DIFFICULTY=0`, no mail provider (codes are read from the API log). Only `127.0.0.1:13005` is published. Never touches `cipherline-*`, ports 3005/5174/7880/5432/6379/9000, staging or prod. |
| accounts | `labsharer` / `labviewer`, created through the API's register -> verify -> finalize, made friends, trial pinned in the lab DB (one source address trips the per-address trial limiter). Random passwords in `out/accounts.json` (mode 600, gitignored), never printed. Sign-in, the emailed 2FA code, "Start fresh", storage prompts, the DM and the call are all driven through the real UI. |
| client container | `cle2e-sharer` / `cle2e-viewer` (`docker/desktop.Dockerfile`, Ubuntu 24.04): PipeWire + WirePlumber + pipewire-pulse, gnome-keyring, the desktop session (`inside/session-*.sh`, adapted from the `claude/linux-share-matrix` branch), a dbus-monitor on the ScreenCast portal, a 1000 Hz tone + animated window app (`pattern-app/`, a separate process tree from Cipherline), then the real app. `/dev/dri` is passed through. |
| harness glue (no app code) | `inside/lab-proxy.mjs`: the renderer's CSP only admits the `VITE_API_HOST` loopback origin, so each client runs a loopback proxy (`/rtc*` -> LiveKit, rest -> API) and a static server for `dist/`, and Electron is started with `VITE_DEV_SERVER_URL` pointing at it (the only way an unpackaged build admits a loopback API). `--password-store=gnome-libsecret` (a plain sway / openbox session is not a desktop Chromium picks a keyring for, so without it the app shows "Encryption at rest disabled" and boot stalls on that dialog). `--no-sandbox` (no user namespaces in the container). |
| measurement | the standard WebRTC stats of the app's own peer connections (`driver/probes.js`, wraps `RTCPeerConnection` in the page: encoder name, hw flag, fps counters, decoder, resolution), the app's own call events as main kept them (`electron.perfGetLog`: `share_fps`, `share_codec`, `share_start`, `share_clamp`, `share_net`, `share_rx_fps`), an FFT of every audio track the viewer receives, an FFT of the sharer's speakers (positive control), portal call counts from `dbus-monitor`, compositor screenshots (`grim` / `import`) of the sharer. |

## Scenarios (`driver/scenarios.mjs`)
`share-1080-90`, `share-source-90`, `share-audio`, `change-source`, `portal-chooser`, `window-share`, `annotation`, `encode-stepdown`,
`vaapi`, `webgl-onboarding`. Each returns `pass | fail | partial | skipped` with the numbers and the criteria it was judged by.

## Automation limits (stated, not hidden)
* **Portal chooser**: automated on sway only (`xdg-desktop-portal-wlr` `chooser_type=dmenu` + `inside/xdpw-chooser.sh`, which also
  COUNTS invocations). KDE (`xdg-desktop-portal-kde`) and GNOME (`xdg-desktop-portal-gnome`) draw a real dialog; the matrix branch
  tried to answer it with `chooser-bot.sh` (mutter RemoteDesktop keysyms / no input route on KWin). Chromium never asks for a restore
  token, so there is no token shortcut either. Those desktops run, the share scenarios stop at the chooser.
* **Pure-tone call audio**: the viewer's mic is a 440 Hz tone; the app's RNNoise / voice gate / AGC remove a pure tone, so the lab turns
  them off on the viewer through Settings -> Voice & Video.
* **Onboarding dots**: the real dot field needs a full sign-up; `webgl-onboarding` runs the same WebGL probe (same attributes) in the app's own
  renderer instead and says so.
* The dev box is shared and often loaded (load 8-12 on 12 cores): absolute fps is a lower bound, every run records `uptime`.

Test-only switches: none in app code. One app change rides on this branch as its own commit (the X11 picker skeleton bug the lab found).
