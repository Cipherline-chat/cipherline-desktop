# Changelog

User-facing changes of Cipherline Desktop, newest first. Format: [Keep a Changelog](https://keepachangelog.com/).

Every stable release has a section headed `## [X.Y.Z] - YYYY-MM-DD` with a `### Security` subsection that either
lists the publicly known vulnerabilities fixed in it (GHSA / CVE ids) or says, verbatim,
`No publicly known vulnerabilities fixed in this release.` The release is refused (`scripts/release/check-changelog.mjs`,
run by `scripts/release/promote-stable.sh`) if the section for the version being released is missing, empty, still
contains a `TODO`, or has no such Security statement. The release workflow publishes this section as the body of the
GitHub Release. How to fill it in: `docs/stable-release-pipeline.md`, "Release notes".

Every stable release also has a `### What's new` subsection: 3 to 8 short, plain-English bullets for the user. The app
bakes it in at build time and shows it as the "What's new in X.Y.Z" dialog on the first launch after updating
(`apps/desktop/src/utils/changelogParse.ts` reads it). The release is refused without it. Format and preview:
`docs/stable-release-pipeline.md`, "What's new notes".

## [Unreleased]

### What's new

### Changes

### Security

## [1.0.23] - 2026-10-25

### What's new

- **Redesigned profiles.** Click a name for a quick preview, or open the full profile with tabs for mutual friends and mutual servers, a showcase, achievements and your level.
- **Make it yours.** Pick a profile theme, avatar decorations and effects (including seasonal Halloween ones), send a high-five, keep private notes about people, and share your profile as a card with a QR code.
- **Steam and Spotify.** Link Steam to show your games, and friends can see what you are listening to if you turn that on.
- **My Emojis.** Add your own emojis, animated ones too, and use them anywhere, including in your custom status.
- **Custom status.** Set a status with an emoji and have it clear itself after a time you choose.
- **Better screen sharing.** A lighter copy for slower viewers with automatic fallback, hardware encoding on NVIDIA, audio that stays in step with the video, and zoom that fills the view.
- **Call personalization.** Choose your speaking ring color and an entrance sound, including one of your own.
- **Faster channel keys.** New members and returning devices get their channel keys sooner, so messages unlock faster.

### Changes

#### Profiles

- Redesigned profile card: a quick preview when you hover a name, and a full profile with tabs for Profile, Mutual friends and Mutual servers, each shown only when it has something in it.
- Profile themes, avatar decorations and effects, including 8 new decorations and 7 new effects with their own options (color, intensity, speed), and seasonal Halloween items; items you have not unlocked can be tried on first.
- Showcase, favorite games, interests and links on your profile; display name, local time and who can see what (including friends-only).
- High-five someone from their profile, see how long you have been friends, and keep private notes that sync across your devices.
- Achievements and a level, earned on your device, with an optional "Most played this week".
- Share card for your profile with a QR code.
- Animated avatars and banners, a verified mark, badges that do something, and an easter-egg count on profile badges.
- Settings, Profile is reorganized into Basics, Style, Showcase and Privacy; changes save as you go, with no Save button.
- A new color picker with a saturation area, hue slider, hex field, presets and recent colors, plus "Match my banner" colors picked on your device.

#### Connections

- Settings, Connections: link a verified Steam account to show your level, library size and recent games.
- Spotify showcase: up to three public playlist or album links on your profile.
- "Listening to" status for friends, off by default; it reads what your computer is playing and shows it where a game would appear (a game still wins).

#### Emoji and status

- My Emojis: add personal emojis (animated too), manage them in Settings, Personalize, and use them in chat, reactions and the emoji picker; save one from a message with a click. They sync across your devices and are included in backups.
- Custom status: set, edit or clear it from the status picker, choose when it clears, and see it in the status line everywhere; a My Emojis emoji can be your status emoji.
- The emoji picker has Server emojis and My Emojis tabs.

#### Calls

- Speaking ring color, including a custom color from the in-app picker, with a preview that shows your avatar.
- Entrance sounds in calls, including your own custom sound, processed on your device and sent encrypted inside the call.
- Moderators can move a member into a private call, as long as the moderator can join it; the member joins that one call as a guest.
- Light noise suppression now actually starts, and Strong switches to Light by itself if your computer falls behind.
- Voice can no longer fall seconds behind in a call.
- Calls remember audio settings per microphone and speaker, with "Voice & Video settings" from the call's mic and speaker menus.
- Echo cancellation is off by default, and every input and output volume control is capped at 200%.
- Level call volume: a faster sender-side leveler and a listener-side "Normalize voice volume".
- A fullscreen strip shows cameras and active speakers first.
- Your camera on/off sound plays when you press, not after the camera opens.
- A call key can be handed to a joiner by anyone who holds it, so joining is quicker.

#### Screen sharing

- A lighter copy of your share is on by default, used from the first viewer on heavy shares; viewers fall back to it automatically when the full picture is choppy, and go back when it recovers.
- Hardware encoding on NVIDIA machines: a share never sits on a software encoder, and software encoding at a high frame rate switches or caps itself.
- Screen-share audio stays in step with the video, and is never run through voice processing.
- Zoom on a focused share fills the stage, and the focused picture extends behind the strip and call controls.
- The screen-share bitrate ceiling is capped and scales sensibly with frame rate.
- Quick screen share shares the window that was in front when you pressed the key; the Screen Share shortcut moved off Ctrl+Shift+S.
- HDR screens can be shared with correct colors; HDR native capture is off by default.
- Crash reports now keep the last moments of a call.

#### Channel keys

- Channel keys arrive faster: one request covers many channels, a rotation hands the new key to every member at once, and keys are installed newest first so recent messages unlock first.
- Re-asks name only the keys that are missing, and "waiting for channel keys" no longer flaps or appears for messages a key cannot fix.

#### Messaging and servers

- Long messages (over 5,000 characters) collapse behind Expand and Open full screen.
- Unsent DM and group drafts survive switching conversations and restarts, and show as "Draft:" in the conversation list.
- Kick and ban confirmations were redesigned, and Shift-click skips the delete confirmation (the hint is shown in the dialog).
- Reply is hidden in channels where you cannot send messages.
- New message dialog is single-select with a quiet "Start a group chat" link.
- Hovering the Pro badge shows how long someone has been Pro.
- A reaction chip bursts once when it piles up to ten.
- Transparent images keep their transparency, and editing a message puts the caret at the end.

#### Settings and polish

- Settings are calmer and easier to scan: Voice & Video, Notifications, Storage, Advanced, Activity, Keybinds, Privacy and Appearance have fewer, clearer cards, and sections stay open until you close them.
- Double-click any slider that has a default to reset it.
- "Still using these devices?" prompts and stale-device badges.
- Per-destination progress bars for Back up now, and backup failures name the step that failed.
- A single glyph on the taskbar overlay: mention, deafened, muted or unread.
- Safety numbers: a one-time hint and a first-verification moment, and a re-check is only suggested after a year.
- Full-screen "Update required" and "App shut down" screens, and account, security and update dialogs on the shared dialog frame.
- Rotating tips and dry lines on the loading screen.
- Playful touches: Keys on Home reacts to what you are doing, plus moments for first message, first call, milestones and the calendar, a rare alternate ringtone, and a few hidden surprises.

#### Fixes

- "Playing" shows only while the game is actually running.
- A Windows log-off, sleep or flaky connection is no longer reported as a crash or a freeze.
- Resuming from sleep waits for the network, then retries.
- The Settings camera preview follows the camera you pick, and "click to copy" for the version and commit works.
- DM and group drafts were being cleared whenever the conversation list loaded.
- Referral bonuses no longer turn a paying or comped account into a trial.
- No focus box around whole panes after Alt-Tab.

### Security

- GHSA-g7r4-m6w7-qqqr (esbuild, fixed in 0.28.2; renderer build tooling)
- GHSA-rj75-hqrm-r3gf, GHSA-w9m9-85wc-3x92 (postcss-selector-parser, fixed in 7.1.6; renderer build tooling)
- GHSA-hp3w-g68c-fv3c (sprintf-js, removed from the shipped app's document-preview dependency chain)
- Messages that claim to come from one of your own devices are now checked against the devices you have confirmed. A newly added device can't hand out encryption keys until you confirm it.
- Syncing history to a new device now only accepts the transfer this device asked for, and asks before importing it.
- In server channels, an edit is only applied when it comes from the message's author, and a delete when it comes from the author or a moderator.
- A call's encryption key is checked against the conversation and the call it belongs to before it is used.
- Choosing a new backup passphrase now requires a strong one. Passphrases you already saved keep working.
- Google Drive access now runs entirely in the app's core and is limited to Cipherline's own backup folder; the app window never sees the Drive sign-in token.
- Screen and app-audio capture now need either a choice made in Cipherline's own share picker or your approval in a system dialog.
- Release builds now refuse to run as a plain Node.js process, ignore debugging switches, check their packaged code for tampering on start, and encrypt stored cookies. On macOS, two permissions that let other programs load code into Cipherline were removed.
- Stricter checks on incoming message keys, channel keys and links, and safer handling of received documents and file names.
- Moving a member into a call they could not otherwise join uses a single-use, 60-second grant that lets them into that one call only, and the call's encryption key is handed to them end to end encrypted, bound to that call. They cannot re-enter later with an old token.
- Custom status images (My Emojis) and your custom entrance sound are never stored on the server: status images stay on your devices, and the sound travels encrypted inside the call.
- Steam on your profile is marked verified only after you prove the account through Steam's own sign-in; Steam and Spotify artwork loads through Cipherline's servers so those services do not see your address, and the "Listening to" status is friends-only, off by default and left out of backups.
- HDR native screen capture is off by default.

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
