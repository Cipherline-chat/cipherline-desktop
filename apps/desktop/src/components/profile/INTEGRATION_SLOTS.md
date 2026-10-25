# Profile integration slots

The profile UI (branch `claude/profile-ux-v3`) draws integrations; it does not
fetch them. Integrations work plugs data in through the four seams below and
never has to touch the layout files. Cosmetics work (decorations / effects) has
its own section at the end.

## Where things render

| Surface | What | Component |
|---|---|---|
| Preview popover (click a name/avatar) | First activity, compact, under the status line | `ProfileActivityRow variant="compact"` |
| Full profile, header rail | Every activity, full rows (art, detail, progress bar) | `ProfileActivityRow variant="full"` |
| Full profile, **Integrations** tab | One card per connection, then your extra panels | `ProfileIntegrationsSection` + `ProfileIntegrationsExtras` |
| Settings > Profile preview | Same as the preview popover (it is the same card) | - |

The Integrations tab shows when `connections.length > 0` or
`ProfileIntegrationsExtras` is known to have content (see below), and always on
your own profile (with a "Connect accounts" call to action).

## Seam 1: activity - `hooks/useProfileActivity.ts`

```ts
useProfileActivity({ userId, isSelf, profile, liveGame, status }): ProfileActivity[]
```

Return activities in display order. The default returns the detected game only.
Replace the body to add Spotify "Listening to", Twitch streams, Steam/Xbox rich
presence. Type (`components/profile/integrationTypes.ts`):

```ts
interface ProfileActivity {
  kind: 'playing' | 'listening' | 'watching' | 'streaming';
  title: string;              // plain text
  detail?: string | null;     // "Artist - Album", "on Steam"
  art?: string | null;        // must pass safeImageSrc (blob:/data:image or allow-listed https)
  source: string;             // 'game' | 'steam' | 'spotify' | 'twitch' | 'xbox' | ...
  progress?: { startedAt: number; durationMs: number } | null;  // draws a live bar
  url?: string | null;        // opened via openExternalLink (validated)
}
```

Label rules the row applies: `playing` -> "Playing", `listening` -> "Listening to",
`watching` -> "Watching", `streaming` -> "Streaming". Source icons exist for
`game`, `steam`, `spotify`, `twitch`, `xbox`, `github`, `youtube`; anything else
falls back to the kind's icon.

Privacy: the server must already have applied the owner's visibility before
data reaches this hook. The row never shows anything the hook did not return.

## Seam 2: connections - `hooks/useProfileConnections.ts`

```ts
useProfileConnections({ userId, isSelf, profile, steamPersona }): ProfileConnection[]
interface ProfileConnection { platform: string; name: string; verified?: boolean; url?: string | null; body?: ReactNode }
```

Default: verified Steam + the typed profile links. Add OAuth-verified accounts
here; `verified: true` draws the tick. A `body` renders inside that platform's
card (keep it under ~160px tall; the tab scrolls).

## Seam 3: extra panels - `components/profile/ProfileIntegrationsExtras.tsx`

```ts
<ProfileIntegrationsExtras userId isSelf profile token />
```

Drawn after the connection cards on the Integrations tab. Default renders `null`.
Own this file. Use the `pfp-panel-card` class (title: `<h3 className="pcd-sec-title">`) for a titled card
so it matches the other panels. If it can have content when there are no
connections, export `hasIntegrationExtras(profile): boolean` from the same file
and the tab will show for it (the tab reads it if present).

## Seam 4: settings entry point

Your own full profile's Integrations tab has a "Connect accounts" button that
calls `requestOpenSettings('profile')` today. Point it at your connections pane
by changing `CONNECT_ACCOUNTS_PANE` in `components/profile/ProfileIntegrationsSection.tsx`.

## Cosmetics (decorations / effects) - for the cosmetics work

- **Options are read generically.** The picker renders `optionKeysFor(kind, id)`
  in order: `'h'` draws the hue control (Match theme + presets + slider); any key
  with an entry in `LEVEL_WORDS` draws a three-way segment labelled from
  `OPTION_LABELS[key]`. A new key with neither is skipped (add it to
  `LEVEL_WORDS`, or ask for a new control type). New items and new option keys
  appear in the picker with no UI change.
- **Item copy.** `CosmeticItem.blurb` shows in the inspector beside the options.
- **Motion policy.** Cards pass `loop` to `ProfileEffect`: the effect keeps
  playing while the window is focused and visible (it no longer plays once and
  settles). Picker thumbnails do not loop unless hovered or selected. One-shot
  keyframes (`sonar`, `bioluminescence`, `shooting-stars`) get looping
  variants in `styles/profile-motion.css` under `.pc-fx[data-loop="true"]`; a
  new effect whose keyframes run once needs a looping rule there.
- **Pausing.** Profile cosmetics pause only when the window is unfocused or
  hidden (`<html data-cl-window="inactive">`, utils/idleMotion.ts), not after
  45 s without input like the rest of the app's decoration. Reduced motion =
  still.
