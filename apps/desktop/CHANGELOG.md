# Changelog

User-facing changes of Cipherline Desktop, newest first. Format: [Keep a Changelog](https://keepachangelog.com/).

Every stable release has a section headed `## [X.Y.Z] - YYYY-MM-DD` with a `### Security` subsection that either
lists the publicly known vulnerabilities fixed in it (GHSA / CVE ids) or says, verbatim,
`No publicly known vulnerabilities fixed in this release.` The release is refused (`scripts/release/check-changelog.mjs`,
run by `scripts/release/promote-stable.sh`) if the section for the version being released is missing, empty, still
contains a `TODO`, or has no such Security statement. The release workflow publishes this section as the body of the
GitHub Release. How to fill it in: `docs/stable-release-pipeline.md`, "Release notes".

## [Unreleased]

### Changes

### Security

## [1.0.22] - 2026-10-14

This release also carries everything that was in 1.0.21, which was tagged but never published to users.

### Changes

#### Calls

- Call moderation: moving someone to another call no longer looks like a kick, and members you move see a "you were moved"
  cue. There is a new Disconnect action next to Move to, with a confirmation, and the moderation permissions have clearer names.
- Calls channels have their own "Start calls" permission, so who can start a call is separate from who can join one.
- A Calls channel can end its call for everyone when the person who started it leaves on purpose.
- Your mute and deafen state stays put when you switch or are moved to another call, and members outside the call can see it.
- New echo cancellation setting (on by default) that applies to every microphone open and takes effect live during a call.
- Output device changes are verified, there is a "Test speakers" button, and attachment players follow the speaker you pick.
- The microphone you publish follows the system default input mid-call, and the voice gate works with noise suppression off.
- Call video recovers on its own after a graphics driver reset.
- Mic, deafen and camera icons now draw a clear slash when off.
- A global keybind answers screen annotation requests, and fullscreen opens on the stream you had focused.

#### Screen sharing

- Screen sharing survives games and 32:9 Surround displays, and "Prioritize calls and screen share while gaming" is now one
  setting. While sharing, Cipherline raises its scheduling priority, opts out of Windows power throttling, and applies a new
  quality right away when you change the shared source.
- A one-time hint suggests sharing the game window rather than the whole screen.
- Wallpaper Engine is no longer shown as a game you are playing, and a Steam-folder program left running no longer reads as
  "Playing" forever.

#### Messaging & servers

- Link channels with `#` and pick from a lookup list, just like @mentions. The @mention picker follows the live server roster.
- Reactions appear instantly; if one does not go through, the chip turns red with Retry and Remove.
- A pending message looks sent, and an undelivered one shows a red "!" with Retry and Discard. A hung send now times out.
- New Copy image in the chat context menu.
- The message action bar sits inside the hovered row, straddles its top edge and is full size again.
- Channel history loads 100 messages at a time; saved and pinned messages always load, and jumping to a message loads its
  surrounding context.
- Channel keys arrive in seconds after you join a server instead of minutes, and a whole-pane "waiting for channel keys"
  state replaces a page of key pills. New members also see who is online right away.
- An edge pill points to unread channels scrolled out of view in the channel list.
- Right-click the DMs and Group chats buttons for Mark all as read, New message and New group chat. A "+" beside a group's
  Members heading adds people.
- Read state for DMs and groups now stays in sync across your devices.
- Usernames are checked against a profanity filter and can be changed once every 24 hours; existing names are not touched.
- The Friends view no longer shows "no friends" while the panel lists one.

#### Privacy & security

- Revealing the backup passphrase or the recovery key now asks you to confirm it is you (your two-factor code, or your
  password if two-factor is off) and re-hides after five minutes.
- Restoring a backup asks for that backup's own password.
- Google Drive backups now use only the narrow "files created by this app" permission.
- Page zoom is locked on every window, so keyboard, wheel or pinch zoom can no longer break the layout.
- The Screen Lock now makes everything behind it unreachable, not just covered, leaves no trace of the loading bar, and
  suggests hiding notification previews while it is on.
- Update manifests are cryptographically signed and verified on every platform before an update is used.
- Every Windows executable and library we ship is now code-signed, and release builds are checked for it.
- Hardening from a full code-scanning pass: every identifier placed in a web address is encoded, image addresses are
  validated before anything is loaded, and file-path checks go through one safe helper.
- Dependencies were brought up to date, including Electron 43.2.0 to 43.7.9 (see Security below).

#### Billing & Pro

- One-step checkout: card details and tax location are now one form, with Link on desktop and wallets on the web, and no
  trip to a browser. Bank payments are not offered.
- One purchase email instead of two, with subtotal, tax and total, plus notices for cancelling, resuming, a subscription
  ending, and a changed card. Abandoned checkouts no longer appear in payment history.
- A "You're Pro" celebration plays once per purchase.

#### Settings & polish

- Storage settings gains a Servers section in the purge list, a redone "Purge older than" menu, and shows DM and group
  avatars in its rows.
- Date of birth at sign-up is typed as MM/DD/YYYY with an automatic mask; the invite button is centred and the privacy dots
  react to the pointer; onboarding storage-step handles are polished.
- Backup reminders update live and clear once backups are set up or a backup completes.
- Channel and category settings dialogs scroll on small windows, and Settings navigation no longer lags on hover.
- The lock screen shows the animated dot field instead of the loading scene.

#### Platform (Linux / macOS)

- Screen share on Linux and macOS: Cipherline now says what each system supports, and on Wayland notes the 60 fps limit of
  the system capture. Hardware H.264 encoding on Linux is available as an opt-in (`CIPHERLINE_LINUX_HW_ENCODE=1`).
- Updates are checked hourly, on wake and when the network returns, always finish inside the app with automatic retries,
  and a downloaded update installs on the next launch.

#### Fixes

- A normal quit is no longer reported as a crash.
- The ending of a call by the person who started it is more reliable (it waits for the server and retries room cleanup).
- The Home backup tile clears correctly and the profile panel has no stray ring around the controller icon.
- Reaction emoji stay centred at fractional display scales.
- Window refocus no longer briefly freezes the interface during background clean-up.
- Rows a key cannot fix no longer say "waiting on channel keys", and deleting a message needs no key.

#### Open source & transparency

- Every change to the public repository is now checked by GitHub's CodeQL code scanning, and every pull request runs the full build and test suite before it can merge.
- The main branch is protected: changes go through a reviewed pull request with passing checks, and force-pushes and deletions are blocked.
- Each stable release is published as a signed GitHub Release with checksums, Sigstore signatures and build-provenance attestations (installers stay on our update feed).
- Every release now ships with release notes and a security section listing the publicly known vulnerabilities it fixes; a release cannot be published without them.
- Fuzz tests now exercise the backup-file reader and the update-signature checker with random inputs.
- Build steps in the release workflow are pinned to exact versions, and the security policy states response times (acknowledgement within 48 hours, initial assessment within 5 business days).
- Cipherline is working toward the OpenSSF Best Practices badge, and the repository's OpenSSF Scorecard rating has improved substantially.

### Security

Publicly known vulnerabilities fixed in this release, by updating dependencies (advisories present in the 1.0.21 build
and absent from this one).

Electron 43.2.0 to 43.7.9, in the shipped app:

- GHSA-gr2m-v5gq-v685, GHSA-j84w-jfhq-vhvj, GHSA-9qh4-3jw8-366w (Electron, fixed in 43.4.1)
- GHSA-qmv3-fv6v-rmhq (Electron, fixed in 43.5.0)

Other dependencies in the shipped app:

- axios 1.20.0: GHSA-vh66-26gq-q6x8, GHSA-9fr6-4gfg-395g, GHSA-c29m-xwm3-cm6r, GHSA-mghh-pgcx-3jjj, GHSA-x97p-jq2g-jp4f,
  GHSA-3pq3-5fj3-cg6v, GHSA-542g-h47m-68v8, GHSA-j8rh-479h-cp32, GHSA-4hqw-qxg8-jxx2, GHSA-m8m8-qj5v-23w3,
  GHSA-44g4-m2mj-wpvx, GHSA-r4gj-5m52-g5wh
- react-router 7.18.4: GHSA-qwww-vcr4-c8h2
- electron-updater and builder-util-runtime 9.7.0: GHSA-p2f4-r6v6-j797
- @xmldom/xmldom 0.8.15: GHSA-6gmq-8vp8-gcm6, GHSA-w2rr-34g9-rvrj, GHSA-4w3w-2rp5-g8jm, GHSA-c7q8-3ch8-vqpv,
  GHSA-27p8-2357-5qqv, GHSA-6h8r-xr42-gp59, GHSA-8344-3jmq-59r6, GHSA-x4fp-j954-r2f4, GHSA-965w-775f-mr7g, GHSA-93r5-fhx6-vmg9
- brace-expansion: GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895, GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7,
  GHSA-6j4f-fj2g-mc7p
- js-yaml 4.3.2: GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj, GHSA-2883-xcg3-v3hh
- uuid 11.1.1: GHSA-w5hq-g745-h8pq

Packaging and build tooling (electron-builder 26.15.7 and the build chain):

- app-builder-lib (Linux AppImage search path): GHSA-7g7r-gx96-252g
- tar 7.5.22: GHSA-23hp-3jrh-7fpw, GHSA-8x88-c5mf-7j5w, GHSA-gvwx-54wh-qm9j, GHSA-r292-9mhp-454m, GHSA-w8wr-v893-vjvp
- shell-quote 1.12.0: GHSA-pqg4-j6r4-53mv, GHSA-395f-4hp3-45gv
- undici: GHSA-4cwx-7wf7-3272, GHSA-w293-vg96-wgc3, GHSA-rfgv-xxqx-mfg5, GHSA-3wwx-pv8p-q78v, GHSA-pmjh-fq2x-6v4x,
  GHSA-3xpg-4rpp-hhhm, GHSA-2jfj-6hjv-fm6j, GHSA-rx4f-c7p8-82vq, GHSA-jr45-8vmc-qm54, GHSA-8xcm-r25x-g524,
  GHSA-m8rv-5g2x-5cg5, GHSA-v3r7-h72x-cjcm, GHSA-r53p-7pc4-xj5r, GHSA-2gqq-gqf2-x968, GHSA-8436-99hf-9mmv
- http-cache-semantics: GHSA-ch52-4w7c-c8xp
- postcss, nanoid, source-map-js, browserslist and baseline-browser-mapping (renderer build): GHSA-r28c-9q8g-f849,
  GHSA-fxqj-rqcc-2cmp, GHSA-28wg-ghj8-5hjv, GHSA-2v37-7h3g-55p8, GHSA-68fv-2mgg-jv7q, GHSA-c83g-rgw3-j3cx,
  GHSA-73wf-gq98-2v4g, GHSA-w5vr-8v7q-w6rv

Also hardened, without public advisories: the issues found by code scanning (URL and path handling, image loading), the
Screen Lock isolation, signed update manifests, signed Windows binaries, and a step-up check before secrets are revealed.

## [1.0.21] - 2026-10-09

### Changes

- Tagged but never published to users. Everything in this version shipped in 1.0.22.

### Security

- Not recorded: this version was never released; see 1.0.22.

## [1.0.20] - 2026-10-09

### Changes

- No user-facing changes (version bump only).

### Security

- Not recorded: this entry was written after the release, before security notes were kept per release.

## [1.0.19] - 2026-10-09

### Changes

- Channel keys: key distribution is now flow-controlled, which stops a burst of key hand-shakes from flooding a server with
  many members.

### Security

- Not recorded: this entry was written after the release, before security notes were kept per release.

Earlier versions (1.0.18 and before) are not listed here.
