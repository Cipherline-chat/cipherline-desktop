# Changelog

User-facing changes of Cipherline Desktop, newest first. Format: [Keep a Changelog](https://keepachangelog.com/).

Every stable release has a section headed `## [X.Y.Z] - YYYY-MM-DD` with a `### Security` subsection that either
lists the publicly known vulnerabilities fixed in it (GHSA / CVE ids) or says, verbatim,
`No publicly known vulnerabilities fixed in this release.` The release is refused (`scripts/release/check-changelog.mjs`,
run by `scripts/release/promote-stable.sh`) if the section for the version being released is missing, empty, still
contains a `TODO`, or has no such Security statement. The release workflow publishes this section as the body of the
GitHub Release. How to fill it in: `docs/stable-release-pipeline.md`, "Release notes".

## [Unreleased]

<!-- Fill this in at release time: rename this heading to `## [X.Y.Z] - YYYY-MM-DD` for the version about to be promoted,
     replace every placeholder, and add a fresh empty `## [Unreleased]` above it. Everything outside the headed section
     for the version is ignored by the release check. -->

### Changes

- TODO(release): user-facing changes since the previous stable tag (`git log --no-merges v<prev>..HEAD -- apps/desktop packages/shared`).

### Security

- TODO(dep-vuln-round): list the GHSA / CVE ids fixed by the dependency round (branch `claude/dep-vuln-round`) in this release,
  one per line, e.g. `- GHSA-xxxx-xxxx-xxxx (package, fixed in x.y.z)`. If none are publicly known, replace this whole list with
  the single line: No publicly known vulnerabilities fixed in this release.

## [1.0.21] - 2026-10-09

### Changes

- Channels: a whole-pane "waiting for channel keys" state replaces a page of key pills while keys arrive.
- Channels: channel history now pages in 100 messages at a time; saved and pinned messages always load, and jumping to a
  message loads the surrounding context.
- Channels: rows that a key cannot fix no longer show "waiting on channel keys", and deleting a message needs no key.
- Channel keys: a re-ask is always answered, and delivery is faster and keeps working in the background; idle key holders now
  also rotate keys for servers whose channels are not loaded yet.
- Messages: a pending message looks sent; if delivery fails it shows a red "!" with Retry and Discard. A hung send request
  now times out instead of blocking the queue.
- Reactions: the emoji stays centred in its chip at fractional display scales.
- Profile panel: no ring around the game-controller icon on a direct-message profile.
- Home: the backup tile clears once backups are set up or a backup completes.

### Security

- Not recorded: this entry was written after the release, from the commit history, before security notes were kept
  per release.

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
