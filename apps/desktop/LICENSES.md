# Third-Party Licenses

Cipherline Desktop is open source software (Apache License 2.0) and incorporates the
following third-party packages. Their licenses are reproduced or referenced below.

---

## MIT License

The following packages are distributed under the MIT License:

- **@dnd-kit/core**, **@dnd-kit/sortable**, **@dnd-kit/utilities** — Copyright (c) Claudéric Demers
- **react** — Copyright (c) Meta Platforms, Inc.
- **react-dom** — Copyright (c) Meta Platforms, Inc.
- **react-router-dom** — Copyright (c) Remix Software
- **react-resizable-panels** — Copyright (c) Brian Vaughn
- **axios** — Copyright (c) Matt Zabriskie
- **@stripe/stripe-js**, **@stripe/react-stripe-js** — Copyright (c) Stripe, Inc.
- **lucide-react** — Copyright (c) Lucide Contributors
- **@marsidev/react-turnstile** — Copyright (c) Marsi Dev
- **emoji-mart**, **@emoji-mart/react**, **@emoji-mart/data** — Copyright (c) Missive
- **emoji-picker-react** — Copyright (c) Ealush
- **@noble/ed25519** — Copyright (c) Paul Miller
- **@scure/bip39** — Copyright (c) Paul Miller
- **zxcvbn** — Copyright (c) Dropbox, Inc.
- **better-sqlite3** — Copyright (c) Joshua Wise
- **electron** — Copyright (c) OpenJS Foundation
- **electron-updater** — Copyright (c) Loopline Systems
- **electron-log** — Copyright (c) Alexey Prokhorov (transitive via electron-updater)
- **exceljs** — Copyright (c) Guyon Morée
- **obscenity** — Copyright (c) Joseph Liu (via @cipherline/shared: the username profanity filter)
- **PipeWire / SPA headers** (vendored subset, compile-time declarations only; the library itself is loaded from the user's system at run time and is not distributed) — Copyright (c) Wim Taymans and the PipeWire contributors. See `src-native/third_party/pipewire/LICENSE`.
- **Wayland protocol descriptions** (vendored XML, `src-native/wayland_overlay/protocols/`, used only to write and cross-check the hand-written protocol tables of the Wayland annotation-overlay helper; `harness/wayland-annotation/check-protocol-tables.sh` compares them with `wayland-scanner`'s output): `xdg-output-unstable-v1.xml` — Copyright (c) 2017 Red Hat Inc., MIT; `wlr-layer-shell-unstable-v1.xml` — Copyright (c) 2017 Drew DeVault, under the permissive licence in the file's own header (an MIT-style "permission to use, copy, modify, distribute, and sell ... without fee" grant, SPDX HPND-sell-variant; no copyleft, no patent or attribution-advertising clause). The libwayland-client / Xlib / XShape / XRandR ABI declarations in `wl_min.h` and `x11_min.h` are written from those public interfaces (libwayland is MIT; the X11 libraries are MIT/X11); the helper loads all of those libraries from the user's system at run time (`dlopen`) and distributes none of them. `harness/wayland-annotation/lab/wlr-virtual-pointer-unstable-v1.xml` (Copyright (c) 2019 Josef Gajdusek, MIT) is a test-harness input only and is not shipped.

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> provided to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

---

## MIT License (dual-licensed — MIT option chosen)

The following packages are available under MIT OR GPL; Cipherline uses the MIT option:

- **jszip** — Copyright (c) Stuart Knightley, David Duponchel, Franz Buchinger, António Afonso (MIT OR GPL-3.0-or-later)

> Same MIT license text as above.

---

## BSD 2-Clause License

The following packages are distributed under the BSD 2-Clause ("Simplified BSD") License:

- **mammoth** — Copyright (c) Michael Williamson
- **@electron/packager** (dev) — Copyright (c) Electron contributors

> Redistribution and use in source and binary forms, with or without modification,
> are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this
>    list of conditions and the following disclaimer.
>
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
> ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
> WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
> DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
> FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
> DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
> SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
> CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
> OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

## BSD 3-Clause License (SpeexDSP, bundled in @sapphi-red/speex-preprocess-wasm)

The "Light" noise suppressor runs SpeexDSP's preprocessor, compiled to WebAssembly by
`@sapphi-red/speex-preprocess-wasm` (the wrapper is MIT-licensed; SpeexDSP itself is BSD-3-Clause):

- **SpeexDSP** — Copyright 2002-2008 Xiph.org Foundation; Copyright 2002-2008 Jean-Marc Valin;
  Copyright 2005-2007 Analog Devices Inc.; Copyright 2005-2008 Commonwealth Scientific and
  Industrial Research Organisation (CSIRO); Copyright 1993, 2002, 2006 David Rowe;
  Copyright 2003 EpicGames; Copyright 1992-1994 Jutta Degener, Carsten Bormann

> Redistribution and use in source and binary forms, with or without modification, are
> permitted provided that the following conditions are met:
>
> - Redistributions of source code must retain the above copyright notice, this list of
>   conditions and the following disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice, this list of
>   conditions and the following disclaimer in the documentation and/or other materials
>   provided with the distribution.
> - Neither the name of the Xiph.org Foundation nor the names of its contributors may be used
>   to endorse or promote products derived from this software without specific prior written
>   permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS
> OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
> FOUNDATION OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
> EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
> HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
> TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
> EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

## Rust call-audio engine (cl-audio, compiled to WebAssembly)

The opt-in "New (beta)" audio engine (Settings → Voice & Video → Audio engine) is Cipherline's own `cl-audio`
crate (Apache-2.0, `crates/cl-audio`, built to `src/audio/engine/cl_audio.wasm`; the exact build is recorded in
`cl_audio.wasm.json`). It statically links these Rust crates (dependency set from `cargo metadata` for
`wasm32-unknown-unknown`, 45 crates besides `cl-audio`; none is copyleft):

Model weights compiled into the same binary (both MIT, run by Cipherline's own code; details in `crates/cl-audio/assets/README.md`):

- **FastEnhancer** B and S (the Strong noise suppression, run in a Web Worker) — https://github.com/aask1357/fastenhancer,
  Copyright (c) 2025 AHN Sung Hwan, trained on the DNS Challenge data.
- **Silero VAD** v6, 16 kHz (the speech detector) — https://github.com/snakers4/silero-vad, Copyright (c) 2020-present Silero Team.

BSD-3-Clause:

- **nnnoiseless** 0.5.2 — Rust port of Xiph's RNNoise, embeds the RNNoise model weights. Copyright (c) 2020, Joe Neeman;
  Copyright (c) 2017, Mozilla; Copyright (c) 2007-2017, Jean-Marc Valin; Copyright (c) 2005-2017, Xiph.Org Foundation;
  Copyright (c) 2003-2004, Mark Borgerding
- **sonora** 0.3.0 and its `sonora-aec3`, `sonora-agc2`, `sonora-common-audio`, `sonora-fft`, `sonora-ns`, `sonora-simd` —
  pure-Rust port of the WebRTC audio-processing module (AGC2, limiter, high-pass). Copyright (c) 2011, The WebRTC
  Project Authors; Copyright (c) 2016, Arun Raghavan and contributors; Copyright (c) 2026, dignifiedquire

> Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
> following conditions are met:
>
> - Redistributions of source code must retain the above copyright notice, this list of conditions and the following
>   disclaimer.
> - Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
>   disclaimer in the documentation and/or other materials provided with the distribution.
> - Neither the name of the copyright holders (including the Xiph.Org Foundation, Mozilla and The WebRTC Project Authors)
>   nor the names of its contributors may be used to endorse or promote products derived from this software without
>   specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
> INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
> DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
> SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
> WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

MIT:

- **rubato** 0.14.1 and **realfft** 3.5.1 — Copyright (c) Henrik Enquist (resampling, FFT front end)
- **tracing** 0.1.44, **tracing-core** 0.1.36 (and the build-time `tracing-attributes`) — Copyright (c) Tokio Contributors
- **derive_more** 2.1.1 (and the build-time `derive_more-impl`) — Copyright (c) Jelte Fennema

MIT OR Apache-2.0 (Cipherline uses the MIT option; Apache-2.0 notices are in the Apache section below):

- **rustfft** 6.4.1 (Allen Welkie), **primal-check**, **strength_reduce**, **transpose**, **easyfft**, **generic_singleton**,
  **array-init**, **num-complex**, **num-integer**, **num-traits** (The Rust Project Developers), **once_cell**, **cfg-if**,
  **scopeguard**, **lock_api**, **parking_lot**, **parking_lot_core**, **smallvec** (The Servo Project Developers),
  **pin-project-lite**, **serde**, **serde_core** (and the build-time `serde_derive`, `syn`, `quote`, `proc-macro2`,
  `unicode-ident`, `unicode-xid`) — copyright held by their respective authors
- **bytemuck** 1.25.2 (Zlib OR Apache-2.0 OR MIT) and **anymap3** 1.1.0 (BlueOak-1.0.0 OR MIT OR Apache-2.0) — MIT option

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice and
> this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED
> "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
> BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

## Retired: native DeepFilterNet "Strong" (cl-audio-node addon)

NOT SHIPPED any more: Strong is now FastEnhancer inside the page's wasm (see above) and no build packages the addon or the
model. The entry stays until the retired code (`electron/audio-engine-*`, `crates/cl-audio-node`) is deleted.

Strong noise suppression ran natively in an Electron utility process: `crates/cl-audio-node` (Apache-2.0, Cipherline's own) is a
Node-API addon (`build/Release/cl_audio_node.node`) that links `cl-audio` with its `dfn` feature, plus the DeepFilterNet 3 low-delay
model file (`resources/dfn/DeepFilterNet3_ll_onnx.tar.gz`, fetched by a script that no longer exists, pinned commit
and sha256, never committed). Dependency set from `cargo metadata` (runtime dependencies of `cl-audio-node`, `x86_64-unknown-linux-gnu`,
146 crates besides `cl-audio-node` and `cl-audio`; none is GPL, LGPL, AGPL or SSPL; nothing has a missing licence field). The
nnnoiseless / sonora / rubato entries above apply to this binary too. New, grouped by licence:

MIT:

- **napi** 3.16.2, **napi-sys** 3.4.1 (and the build-time **napi-derive** 3.7.1, **napi-build** 2.6.0) — the Node-API binding
  (napi-rs), Copyright (c) 2020 LongYinan and contributors. Used as plain crates built by cargo: no napi CLI, no npm package.

ISC:

- **libloading** 0.9.1 — Copyright (c) 2015 Simonas Kazlauskas (napi loads the Node-API symbols lazily)

MIT OR Apache-2.0 (Cipherline uses the MIT option; Apache-2.0 notices are in the Apache section below):

- **deep_filter** (libDF) 0.5.7-pre, git `Rikorose/DeepFilterNet` @ `7b14b895fe7fc42cab72b4a4c1e49c982bd6404b` — Copyright (c) Hendrik
  Schröter. The repository states that all code **and model weights** are dual-licensed MIT / Apache-2.0, which covers the bundled
  standard model compiled into the addon and the separately downloaded `DeepFilterNet3_ll_onnx.tar.gz`
- **tract-core**, **tract-onnx**, **tract-linalg**, **tract-hir**, **tract-nnef** and the other `tract-*` crates 0.21.4 — Copyright
  (c) Sonos, Inc. and Mathieu Poumeyrol (the neural-network runtime that executes DeepFilterNet)
- **ndarray** 0.15.6 (Ulrik Sverdrup, Jim Turner), **flate2**, **tar** (Alex Crichton), **ctor** (Matt Mastracci), and about 70 further
  crates of the tract / ndarray / serde / regex family — copyright held by their respective authors

Other permissive licences in that set (all on the repository's allow list, or a permissive option of a multi-licence crate), flagged here
because they are not plain MIT / Apache-2.0 / BSD / ISC:

- **zlib-rs** 0.6.8 — Zlib licence (permissive; requires the notice to be kept, "altered source versions must be plainly marked")
- **tiny-keccak** 2.0.2 — CC0-1.0 (public-domain dedication)
- **libm** 0.2.11 — MIT AND (MIT OR Apache-2.0)
- **unicode-ident** 1.0.27 — (MIT OR Apache-2.0) AND Unicode-3.0 (Unicode data licence, permissive)
- **aho-corasick**, **byteorder**, **memchr**, **same-file**, **walkdir** — Unlicense OR MIT (MIT option)
- **miniz_oxide**, **adler2**, **bytemuck**, **zerocopy**, **rustix**, **linux-raw-sys** — multi-licence with an MIT or Apache-2.0 option

The Windows and macOS builds add platform crates (`windows-sys` and friends, MIT OR Apache-2.0) that this Linux metadata run does not
list; re-run `cargo metadata --filter-platform <triple>` per target when the CI build is added (docs/plans/audio-strong-native-ci.md).

---

## BSD 3-Clause License (dual-licensed — BSD option chosen)

The following package is available under BSD-3-Clause OR GPL-2.0; Cipherline uses the
BSD-3-Clause option:

- **node-forge** — Copyright (c) Digital Bazaar, Inc.

> Redistribution and use in source and binary forms, with or without modification,
> are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this
>    list of conditions and the following disclaimer.
>
> 2. Redistributions in binary form must reproduce the above copyright notice,
>    this list of conditions and the following disclaimer in the documentation
>    and/or other materials provided with the distribution.
>
> 3. Neither the name of the copyright holder nor the names of its contributors
>    may be used to endorse or promote products derived from this software without
>    specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
> ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
> WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.

---

## Apache License 2.0

The following packages are distributed under the Apache License, Version 2.0:

- **livekit-client** — Copyright (c) LiveKit, Inc.
- **@livekit/components-react** — Copyright (c) LiveKit, Inc.
- **@livekit/components-styles** — Copyright (c) LiveKit, Inc.
- **@shiguredo/rnnoise-wasm** — Copyright (c) Shiguredo Inc.
- **@shiguredo/noise-suppression** — Copyright (c) Shiguredo Inc.
- **AWS SDK for JavaScript v3** (`@aws-sdk/*`, `@smithy/*`) — Copyright (c) Amazon.com, Inc.
- **rxjs** — Copyright (c) Google LLC (Ben Lesh)
- **reflect-metadata** — Copyright (c) Ron Buckton
- **typescript** — Copyright (c) Microsoft Corporation

Fonts bundled with the app (message fonts, `src/assets/fonts`, latin-subset woff2
files as published by Google Fonts / Fontsource, unmodified):

- **Special Elite** — Copyright (c) 2010 Brian J. Bonislawsky DBA Astigmatic (AOETI). Full text shipped as `licenses/fonts/SpecialElite-Apache-2.0.license`.
- **Permanent Marker** — Copyright (c) 2010 Font Diner, Inc. Full text shipped as `licenses/fonts/PermanentMarker-Apache-2.0.license`.

> Licensed under the Apache License, Version 2.0 (the "License"); you may not
> use these files except in compliance with the License. You may obtain a copy
> of the License at:
>
> http://www.apache.org/licenses/LICENSE-2.0
>
> Unless required by applicable law or agreed to in writing, software distributed
> under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
> CONDITIONS OF ANY KIND, either express or implied.

---

## SIL Open Font License 1.1 (fonts)

The following fonts are bundled with the app (message fonts and the Accessibility font choice, `src/assets/fonts`) as
latin-subset woff2 files exactly as published by Google Fonts / Fontsource (not
modified by us). The full licence text of each ships inside the app as
`licenses/fonts/<Font>-OFL.license` (from `public/licenses/fonts`), as the OFL requires.
Approved by the owner on 2026-11-16 (OFL is not on the default allow-list).

- **Lora** — Copyright 2011 The Lora Project Authors (https://github.com/cyrealtype/Lora-Cyrillic), with Reserved Font Name "Lora"
- **Caveat** — Copyright 2014 The Caveat Project Authors (https://github.com/googlefonts/caveat)
- **Atkinson Hyperlegible** — Copyright 2020 Braille Institute of America, Inc.
- **Lexend** — Copyright 2019 The Lexend Project Authors (https://github.com/googlefonts/lexend). UI / message font choice in Settings → Accessibility (latin subset, regular + bold)
- **OpenDyslexic** — Copyright (c) 2019-07-29, Abbie Gonzalez (https://abbiecod.es), with Reserved Font Name OpenDyslexic. UI / message font choice in Settings → Accessibility (latin subset, regular + bold). The OFL-1.1 release (3.0); the older Bitstream Vera-licensed OpenDyslexic is not used

Full license text: https://openfontlicense.org (SIL Open Font License, Version 1.1)

---

## Mozilla Public License 2.0

The following packages are distributed under the Mozilla Public License 2.0.
MPL-2.0 is a "weak copyleft" license: only modifications to the MPL-licensed
files themselves must be made available; Cipherline's own source code is unaffected.

- **lightningcss** — Copyright (c) Devon Govett / Parcel contributors

Full license text: https://www.mozilla.org/en-US/MPL/2.0/

---

## Creative Commons Attribution 4.0 (CC-BY-4.0)

The following data package requires attribution:

- **caniuse-lite** — Browser compatibility data from https://caniuse.com, Copyright (c) Alexis Deveria

Full license text: https://creativecommons.org/licenses/by/4.0/

---

## CC0 1.0 (public domain dedication)

Not a dependency: SVG path data copied inline (no package, no network) into
`src/components/integrations/platformLogoData.tsx`:

- **Simple Icons** 16.36.0 (https://simpleicons.org) — the Spotify, Apple Music, YouTube Music, TIDAL, Deezer,
  SoundCloud, YouTube, Netflix, Twitch, Crunchyroll and Jellyfin marks. CC0 covers the SVG data only; the logos
  are trademarks of their owners and are used to identify the service a friend is listening on / watching.

Full license text: https://creativecommons.org/publicdomain/zero/1.0/

---

Full license texts for all dependencies are available in their respective
`node_modules/<package>/LICENSE` files or on https://www.npmjs.com.
