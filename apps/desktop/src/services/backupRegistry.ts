/**
 * backupRegistry — the single place that says which on-device state is in
 * the encrypted backup and which is deliberately left out.
 *
 * Before this existed, `exportLocalHistory` hand-listed a dozen settings
 * keys and every setting added since (notification prefs, per-server
 * overrides, home pins, privacy, appearance, retention overrides, safety
 * numbers…) silently fell out of the backup. Now every key the app writes
 * must be classified here — backupRegistry.test.ts scans the source tree
 * for `setItem(` / `secureStore.set(` keys and fails on any that aren't —
 * so a new setting is a one-line decision, not a quiet data loss.
 *
 * Three stores:
 *   • secureLocalStore (renderer, encrypted IndexedDB) — `KV_RULES`.
 *     Per-user keys embed the account id; rules write it as `{uid}` and the
 *     backup stores keys with the placeholder, so restore re-keys under the
 *     restoring account (which importLocalHistory has already proven is the
 *     same account).
 *   • Electron SecureStore (OS-wrapped) — `APP_PREF_KEYS` (included) vs
 *     everything else (identity, prekeys, channel keys, OAuth, backup
 *     credentials — never in a backup).
 *   • userData files — custom notification sounds travel as their own
 *     container records (backupRecords.ts).
 */

export type KvMatch = 'exact' | 'prefix';

export interface KvRule {
    /** Key or key prefix; `{uid}` stands for the account id. */
    pattern: string;
    match: KvMatch;
    include: boolean;
    /** Why it's in or out — shown nowhere, kept for the next reader. */
    why: string;
}

/**
 * Ordered: first matching rule wins. Keys that are backed up through the
 * structured vault fields (messages, topics, voice/keybind/game settings,
 * pins, status, GIF library, saved-message ids) are listed as EXCLUDED here
 * because they must not be duplicated into the generic `kv` map.
 */
export const KV_RULES: KvRule[] = [
    // ── Included: user-facing settings that had no home in the vault ──────
    // Covers `sound_groups` (the collapsed "App sounds" enable + volume, added
    // 2026-09) too: notification prefs are ONE JSON blob under this key, so a
    // new field inside NotificationPrefs is carried by this rule and creates no
    // new secureLocalStore key for the source scan below to find. A new
    // notification setting only needs its own rule here if it is stored under
    // its own key rather than inside this object.
    { pattern: 'cipherline_notif_global_prefs_{uid}',   match: 'exact',  include: true,  why: 'Notifications pane: DND, schedules, sounds + sound groups, keywords, badges' },
    { pattern: 'cipherline_notif_prefs_{uid}',          match: 'exact',  include: true,  why: 'Per-conversation mute / notification overrides' },
    { pattern: 'cipherline_server_notif_prefs_{uid}',   match: 'exact',  include: true,  why: 'Per-server notification overrides' },
    { pattern: 'cipherline_channel_notif_prefs_{uid}',  match: 'exact',  include: true,  why: 'Per-channel notification overrides' },
    { pattern: 'cipherline_home_pins_{uid}',            match: 'exact',  include: true,  why: 'Home-screen pins' },
    // Voice & Video settings remembered per microphone / speaker
    // (utils/audioDeviceProfiles.ts). Included: profiles are keyed by the
    // device's LABEL, not its per-machine id, so restoring onto a new PC gives
    // the same headset its settings back the first time it is plugged in. The
    // id/groupId hints inside are opaque per-origin values that simply never
    // match elsewhere. Nothing new travels: the global voice settings in
    // vault.voiceSettings already carry the picked devices' labels.
    { pattern: 'cipherline_audio_device_profiles_{uid}', match: 'exact', include: true,  why: 'Voice & Video settings per microphone / speaker, keyed by device label' },
    { pattern: 'cipherline_server_rail_order_{uid}',    match: 'exact',  include: true,  why: 'Server rail order — legacy flat list, still written as the flattened order for pre-folder builds' },
    // Folders are a personal UI preference (and part of the on-device social
    // graph): names, colours, membership and the interleaved rail order. The
    // server never sees them, so the encrypted backup is their only way to
    // survive a reinstall.
    { pattern: 'cipherline_server_rail_layout_{uid}',   match: 'exact',  include: true,  why: 'Server rail layout: order + server folders (name, colour, members)' },
    { pattern: 'cipherline_category_collapsed_{uid}_',  match: 'prefix', include: true,  why: 'Collapsed channel categories' },
    { pattern: 'cipherline_ignored_{uid}_',             match: 'prefix', include: true,  why: 'Ignored/blocked server members (safety)' },
    // ── Excluded: TRUST state never travels in a backup or history transfer (F2) ──
    // Safety-number pins, unresolved sender warnings and the own-device ledger
    // are this install's own record of whom it has vouched for. They used to
    // be restored from a vault, which made a vault — a history transfer
    // delivered over the relay, or a backup file sitting on Drive behind a
    // passphrase — able to mark an attacker's key as "verified" or a ghost
    // device as "confirmed". Restoring trust is the one thing an import must
    // never do, so a restored or newly synced device starts from TOFU: contacts
    // show as unverified until re-verified, and the own-device ledger
    // re-baselines with its one-time review banner (docs/ghost-device.md).
    // include:false also makes applyIncludedKv IGNORE these keys in vaults
    // written by older builds.
    { pattern: 'kv_verify_v2_{uid}_',                   match: 'prefix', include: false, why: 'Safety-number verification pins — trust state, never imported from a vault (F2)' },
    { pattern: 'kv_warn_v1_{uid}',                      match: 'exact',  include: false, why: 'Unresolved sender-identity warnings — trust state, stays with the install that raised them (F2)' },
    { pattern: 'kv_own_devices_v1_{uid}',               match: 'exact',  include: false, why: 'Own-device ledger — trust state; a restored device re-baselines and asks for review (F2)' },
    { pattern: 'cipherline_backup_cfg_{uid}',           match: 'exact',  include: true,  why: 'Backup destinations, schedule, filename' },
    { pattern: 'cipherline_onboarded_v2_{uid}',         match: 'exact',  include: true,  why: 'Skip onboarding again after a restore' },
    { pattern: 'cipherline_checklist_dismissed_{uid}',  match: 'exact',  include: true,  why: 'Onboarding checklist dismissed' },
    { pattern: 'cipherline_first_week_nudges_{uid}',    match: 'exact',  include: true,  why: 'First-week tips: the off switch + what was already shown/taught (incl. the save-a-message coach mark) — a restore must not re-teach' },
    { pattern: 'cipherline_sync_dismissed_{uid}',       match: 'exact',  include: true,  why: 'History-sync banner dismissed' },
    { pattern: 'cipherline_privacy_settings',           match: 'exact',  include: true,  why: 'Privacy toggles' },
    { pattern: 'cipherline_screenlock_settings',        match: 'exact',  include: true,  why: 'Screen-lock PIN verifier (user-set)' },
    { pattern: 'cipherline_gif_settings',               match: 'exact',  include: true,  why: 'GIF picker prefs incl. the KLIPY opt-in (a preference, not media)' },
    { pattern: 'cipherline_ambient_motion',             match: 'exact',  include: true,  why: 'Appearance' },
    { pattern: 'cipherline_seasonal_effects',           match: 'exact',  include: true,  why: 'Appearance' },
    { pattern: 'cipherline_left_sidebar_ratio',         match: 'exact',  include: true,  why: 'Layout' },
    { pattern: 'cipherline_right_sidebar_ratio',        match: 'exact',  include: true,  why: 'Layout' },
    { pattern: 'cipherline_call_banner_ratio',          match: 'exact',  include: true,  why: 'Layout' },
    { pattern: 'cipherline_speaker_device_id',          match: 'exact',  include: true,  why: 'Output device (best-effort on another machine)' },
    { pattern: 'cipherline_master_speaker_volume',      match: 'exact',  include: true,  why: 'Master volume' },
    { pattern: 'cipherline_vol_',                       match: 'prefix', include: true,  why: 'Per-participant volumes' },
    { pattern: 'cipherline_ns_enabled_',                match: 'prefix', include: true,  why: 'Per-participant noise suppression' },

    // ── Excluded: retention is PER DEVICE (owner decision, 2026-09) ───────
    // "Your storage settings are set per device … this doesn't get synced
    // over." Every retention setting stays on the device that chose it, and a
    // device the account has never used asks (deviceStorageSetup.ts). Being
    // `include: false` also means applyIncludedKv IGNORES these keys when an
    // OLD backup still carries them in `kv` — a restore can't impose another
    // device's windows.
    { pattern: 'cipherline_conv_retention_{uid}_',      match: 'prefix', include: false, why: 'Per-conversation retention override — per-device setting, never travels' },
    { pattern: 'cipherline_server_retention_{uid}_',    match: 'prefix', include: false, why: 'Per-server retention override — per-device setting, never travels' },
    // The purge ledger (retentionTombstones.ts) was included until 2026-09 so a
    // restore couldn't let purged server-channel messages walk back in. With
    // per-device retention that same property becomes the bug: the ledger
    // records what THIS device's policy deleted, and carried to a device that
    // keeps things longer it would make foldChannelHistory (and the live
    // channel-message path) silently drop messages that device's own policy
    // says to keep — on every future fetch, with no way to get them back. A
    // device that genuinely wants them gone re-purges them on its own sweep
    // and writes its own ledger. Losing messages is the failure to avoid; a
    // purged message briefly reappearing until the local sweep runs is not.
    { pattern: 'cipherline_retention_purged_{uid}_',    match: 'prefix', include: false, why: 'Retention purge ledger — records what THIS device’s policy deleted; must not hide messages on a device that keeps longer' },
    // The first-run "set up storage on this device" marker. Excluded for the
    // same reason the settings are: it asserts "this DEVICE has chosen", and
    // restoring it onto a new device would skip the prompt and leave that
    // device on defaults nobody picked.
    { pattern: 'cipherline_notif_ask_{uid}',            match: 'exact',  include: false, why: 'Notification ask marker — "this device has been asked"; the OS permission is per machine, so it never travels' },
    { pattern: 'cipherline_device_storage_setup_{uid}', match: 'exact',  include: false, why: 'Device storage-setup marker — "this device has chosen its retention"; device-local by definition' },
    { pattern: 'cipherline_onboarding_r6_{uid}',        match: 'exact',  include: false, why: 'First-run setup resume point on THIS device (utils/onboardingProgress.ts); a restore must never reopen onboarding' },
    // Settings → Advanced → Screen share & stream stats (streamDiagnosticsPrefs.ts).
    // The codec choice describes THIS machine's GPU encoder; restored onto a
    // machine without that encoder it would force a software encode. The
    // overlay is a testing aid, not a preference worth carrying.
    { pattern: 'cipherline_screenshare_codec',          match: 'exact',  include: false, why: 'Screen-share encoder override — about this device’s GPU, never travels' },
    { pattern: 'cipherline_entrance_prefs_{uid}',   match: 'exact',  include: true,  why: 'Listener settings for other people\'s call entrance sounds: the global switch + the people you muted (utils/entrancePrefs.ts). Personal preference, nothing sent anywhere' },
    { pattern: 'cipherline_egg_progress_{uid}',        match: 'exact',  include: true,  why: 'Easter eggs FOUND (distinct ids, utils/eggProgress.ts) for the Egg hunter badge: account progress, so a restore on a new machine keeps it (the server also holds it; the union can only grow)' },
    { pattern: 'cipherline_calls_connected_{uid}',  match: 'exact',  include: true,  why: 'Count of calls that connected (an integer; utils/milestones.ts) — account progress toward the 100th-call moment, so a restore on a new machine neither resets it nor replays the 100th. Never who, when or how long' },
    { pattern: 'cipherline_egg_seen',                  match: 'exact',  include: false, why: 'Easter-egg ledger (which fired, how often, when — utils/easterEggs.ts): device-local rate-limit bookkeeping, a restore onto a new machine may happily re-tease you' },
    { pattern: 'cipherline_loading_game_best',          match: 'exact',  include: false, why: 'Firewall mini-game best score on the loading/offline screens — device-local, shown before sign-in' },
    { pattern: 'cipherline_stream_stats_hud',           match: 'exact',  include: false, why: 'Stream-stats overlay toggle — device-local testing aid' },
    // Settings → which "Advanced audio" / "Troubleshooting" … rows were left
    // open (components/settings/settingsDisclosureStore.ts). Pure UI layout
    // memory for this window; a restore has nothing to gain from it.
    { pattern: 'cipherline_settings_disclosures',       match: 'exact',  include: false, why: 'Settings disclosure rows left open — device-local UI layout, never travels' },
    // The colour picker's "Recent" row (utils/recentColours.ts): the last 8 colours committed on THIS
    // device. A UI nicety, not account data; a restore has nothing to gain from it.
    { pattern: 'cipherline_recent_colours',             match: 'exact',  include: false, why: 'Colour picker "Recent" row (utils/recentColours.ts) — device-local UI nicety, never travels' },
    // The "share the game window instead" hint (utils/shareFullscreenHint.ts) is
    // shown ONCE per account; whether this device has shown it is a device fact.
    { pattern: 'cipherline_share_window_hint_seen_{uid}', match: 'exact', include: false, why: '"Share the game window instead" hint shown once (utils/shareFullscreenHint.ts) — a per-device UI nicety, a restore must not carry it' },
    // Safety-number verification one-time markers (utils/safetyVerifyHint.ts, utils/firstVerification.ts):
    // the "make sure it's really them" hint is finished, and the first-verification ceremony has played.
    // One-time UI bookkeeping, and about state that never travels: the verification pins themselves are
    // never restored from a vault (kv_verify_v2_ above), so a restored device has nobody verified yet
    // and may say each once.
    { pattern: 'cipherline_safety_hint_done_{uid}',      match: 'exact',  include: false, why: 'One-time "make sure it\u2019s really them" safety-number hint finished (utils/safetyVerifyHint.ts) - one-time UI marker; the pins it is about are not restored either' },
    { pattern: 'cipherline_first_verify_played_{uid}',   match: 'exact',  include: false, why: 'First-verification ceremony already played (utils/firstVerification.ts) - one-time UI marker; the pins it is about are not restored either' },
    // The "video froze while gaming" offer's snooze / don't-ask-again flags
    // (utils/gamingVideoOffer.ts). About THIS machine's gaming load, like the
    // mode it offers (which lives in main's startup-flags.json, not here).
    // "Listening to ..." (utils/integrations/listeningPrefs.ts): whether THIS
    // computer's media session is read and shared. A per-device opt-in to read
    // local state; a restore onto another machine must never switch it on.
    { pattern: 'cipherline_listening_share_{uid}',      match: 'exact',  include: false, why: 'Share-what-I\u2019m-listening-to opt-in - per device (reads this machine\u2019s media session), never restored on' },
    { pattern: 'cipherline_listening_browser_{uid}',    match: 'exact',  include: false, why: 'Listening status: include browser players - per-device companion of the opt-in above' },
    { pattern: 'cipherline_gaming_video_offer',         match: 'exact',  include: false, why: 'Gaming-video freeze offer snooze — about this device’s gaming load, never travels' },
    { pattern: 'cipherline_allow_hevc',                 match: 'exact',  include: false, why: 'Allow H.265 when everyone supports it — about this device’s GPU, never travels' },
    { pattern: 'cipherline_share_low_layer',            match: 'exact',  include: false, why: 'Screen share lighter copy for viewers — about this device’s encoder, never travels' },
    // Camera quality (cameraQualityPrefs.ts) and the "PC is struggling" offer
    // (performanceOffer.ts): both describe THIS machine's CPU/GPU/camera.
    { pattern: 'cipherline_camera_quality',             match: 'exact',  include: false, why: 'Camera quality tier — what this PC/camera can sustain, never travels' },
    { pattern: 'cipherline_camera_codec',               match: 'exact',  include: false, why: 'Camera encoder override — about this device’s GPU, never travels' },
    { pattern: 'cipherline_incoming_video',             match: 'exact',  include: false, why: 'Incoming video quality (Auto/Reduced/Data saver) — about this PC and its connection, never travels' },
    { pattern: 'cipherline_perf_offer',                 match: 'exact',  include: false, why: 'Performance offer snooze / don’t-ask — about this machine, never travels' },
    // The app version whose "What's new" dialog was last opened or skipped (utils/whatsNew.ts): about THIS install
    // (restoring a backup onto a newer or older build must not decide whether its dialog shows).
    { pattern: 'cipherline_whats_new_seen',             match: 'exact',  include: false, why: 'Last app version whose What’s new was shown — describes this install, never travels' },
    // Crash / issue reporter (utils/diagnostics/autoSend.ts). Per account (the
    // report is linked to the account that sends it) but EXCLUDED: consent to
    // upload crash reports automatically is given on each device and must
    // never be switched on by restoring a backup onto a new machine — same
    // device-local class as the two diagnostics prefs above. The log is
    // bookkeeping (hashed crash signatures + times for the daily cap/dedupe).
    // Unsent composer drafts (utils/composerDrafts.ts): one record per account
    // holding half-typed message PLAINTEXT per conversation. Excluded on
    // purpose: it is a device-local convenience, not account data, and a backup
    // file is the one thing here that deliberately TRAVELS (Drive, a USB stick)
    // — copying unsent, possibly never-meant-to-be-sent text into it would
    // widen where plaintext lives for no benefit. A restore onto another
    // device also could not reattach it to anything: drafts are keyed by
    // conversation/channel ids that device may not have cached yet.
    { pattern: 'cipherline_composer_drafts_{uid}',      match: 'exact',  include: false, why: 'Unsent composer drafts (message plaintext) — device-local convenience; must not travel inside a backup file' },
    { pattern: 'cipherline_diag_auto_send_{uid}',       match: 'exact',  include: false, why: 'Automatically send crash reports — per-device consent, never restored' },
    { pattern: 'cipherline_diag_auto_send_log_{uid}',   match: 'exact',  include: false, why: 'Auto-send bookkeeping (hashed signatures + times) for the daily cap / dedupe' },
    { pattern: 'cipherline_beta_diag_{uid}',            match: 'exact',  include: false, why: 'Share beta diagnostics — per-device consent (closed beta), never restored' },
    { pattern: 'cipherline_beta_diag_notice_{uid}',     match: 'exact',  include: false, why: 'Beta diagnostics one-time notice seen — device-local UI bookkeeping' },
    { pattern: 'cipherline_beta_diag_rating_{uid}',     match: 'exact',  include: false, why: 'Call rating card frequency ledger (calls since last prompt + time) — device-local bookkeeping' },

    // ── Excluded: carried by structured vault fields (don't duplicate) ────
    { pattern: 'cipherline_convs_{uid}',                match: 'exact',  include: false, why: 'vault.topics' },
    { pattern: 'cipherline_msgs_{uid}',                 match: 'prefix', include: false, why: 'vault.history (messageStore)' },
    { pattern: 'cipherline_channel_msgs_{uid}',         match: 'prefix', include: false, why: 'vault.channelHistory (messageStore)' },
    { pattern: 'cipherline_hidden_convs_{uid}',         match: 'exact',  include: false, why: 'vault.hiddenConversations' },
    { pattern: 'cipherline_muted_convs_{uid}',          match: 'exact',  include: false, why: 'vault.mutedConversations' },
    { pattern: 'cipherline_pinned_{uid}',               match: 'exact',  include: false, why: 'vault.pinnedMessages' },
    { pattern: 'cipherline_local_channel_pins_{uid}',   match: 'exact',  include: false, why: 'vault.localChannelPins' },
    { pattern: 'cipherline_status_{uid}',               match: 'exact',  include: false, why: 'vault.userStatus' },
    { pattern: 'cipherline_status_text_{uid}',          match: 'exact',  include: false, why: 'vault.userStatus' },
    { pattern: 'cipherline_status_emoji_{uid}',         match: 'exact',  include: false, why: 'vault.userStatus' },
    { pattern: 'cipherline_status_expires_{uid}',       match: 'exact',  include: false, why: 'When the custom status clears — server-enforced; this copy only stops a stale status flashing at boot' },
    { pattern: 'cipherline_status_emoji_shared_{uid}', match: 'exact',  include: false, why: 'Which friends already hold the personal emoji used as a status - device-local delivery ledger (utils/personalEmoji/statusEmoji.ts)' },
    { pattern: 'cipherline_status_pending_{uid}',       match: 'exact',  include: false, why: 'Unsent status change made while offline — device-local, settled on the next connect (utils/ownStatusSync.ts)' },
    { pattern: 'cipherline_storage_policy_{uid}',       match: 'exact',  include: false, why: 'Retention policy — per-device, never travels; only its explicitly SAVED ids ride in vault.retentionSaves (retentionPortability.ts)' },
    { pattern: 'cipherline_voice_settings',             match: 'exact',  include: false, why: 'vault.voiceSettings' },
    { pattern: 'cipherline_keybinds',                   match: 'exact',  include: false, why: 'vault.keybinds' },
    { pattern: 'cipherline_keybinds_migrated_v1',       match: 'exact',  include: false, why: 'one-time keybind migration marker; per device, like the binds it guards' },
    { pattern: 'cipherline_game_settings_{uid}',        match: 'exact',  include: false, why: 'vault.gameSettings (per account since 2026-09)' },
    { pattern: 'cipherline_game_settings',              match: 'exact',  include: false, why: 'legacy device-global record, migration source only' },
    // GIF library. Per-account since 2026-09; the two unscoped patterns below
    // are the pre-scoping device-global records, kept as a migration source.
    // The scoped rules must come FIRST — `cipherline_gif_key_` as a prefix
    // would otherwise swallow `cipherline_gif_key_{uid}_…` too.
    { pattern: 'cipherline_gif_favorites_{uid}',        match: 'exact',  include: false, why: 'vault.gifFavorites' },
    { pattern: 'cipherline_gif_ledger_{uid}',           match: 'exact',  include: false, why: 'vault.gifLedger (sync tombstones — carried so a restore keeps deletions)' },
    { pattern: 'cipherline_gif_key_{uid}_',             match: 'prefix', include: false, why: 'vault.gifKeys' },
    { pattern: 'cipherline_gif_favorites',              match: 'exact',  include: false, why: 'legacy device-global record, migration source only' },
    { pattern: 'cipherline_gif_key_',                   match: 'prefix', include: false, why: 'legacy device-global record, migration source only' },
    // My Emojis (personal custom emojis). Library + per-item keys + the blob
    // index ride in the vault (utils/personalEmoji/backup.ts); the sealed image
    // files are `emoji:<id>` records. The sync bookkeeping is per device.
    { pattern: 'cipherline_emoji_library_{uid}',        match: 'exact',  include: false, why: 'vault.emojiLibrary' },
    { pattern: 'cipherline_emoji_index_{uid}',          match: 'exact',  include: false, why: 'vault.emojiIndex (size/mime/name of each stored image; last-used time is deliberately left out so viewing never churns a backup)' },
    { pattern: 'cipherline_emoji_key_{uid}_',           match: 'prefix', include: false, why: 'vault.emojiKeys' },
    { pattern: 'cipherline_emoji_sync_view_{uid}',      match: 'exact',  include: false, why: 'Emoji-sync bookkeeping (what this DEVICE knows about the personal_emojis slot - device-specific, must not restore)' },
    // Custom entrance sound: this record holds the per-file AES key of the
    // sealed `esound-<id>.enc` + an LWW stamp. The SOUND travels as
    // vault.entranceSound (bytes inline, inside the encrypted vault's meta
    // record) and is re-sealed under a fresh key on restore, so this
    // device-local key must not ride in the generic kv map.
    { pattern: 'cipherline_entrance_sound_{uid}',       match: 'exact',  include: false, why: 'vault.entranceSound (utils/customEntranceSound/transfer.ts)' },
    { pattern: 'cipherline_private_key',                match: 'exact',  include: false, why: 'per-device keypair — never leaves this device, not even in the vault (utils/crypto.ts BackupVault.privateKey)' },
    { pattern: 'cipherline_public_key',                 match: 'exact',  include: false, why: 'per-device keypair — never leaves this device, not even in the vault (utils/crypto.ts BackupVault.privateKey)' },
    { pattern: 'cipherline_device_id',                  match: 'exact',  include: false, why: 'vault.deviceId' },

    // ── Excluded: session / credentials / device identity ────────────────
    { pattern: 'cipherline_token',                      match: 'exact',  include: false, why: 'Session' },
    { pattern: 'cipherline_refresh_token',              match: 'exact',  include: false, why: 'Session' },
    { pattern: 'cipherline_user_id',                    match: 'exact',  include: false, why: 'Session' },
    { pattern: 'cipherline_is_pairing',                 match: 'exact',  include: false, why: 'Transient' },
    { pattern: 'cipherline_identity_pub_b64',           match: 'exact',  include: false, why: 'Device identity — never copied between devices' },

    // ── Excluded: caches, counters, bookkeeping, one-shot flags ──────────
    { pattern: 'cipherline_unread_',                    match: 'prefix', include: false, why: 'Counter' },
    { pattern: 'cipherline_mentions_',                  match: 'prefix', include: false, why: 'Counter' },
    { pattern: 'cipherline_channel_unread_',            match: 'prefix', include: false, why: 'Counter' },
    { pattern: 'cipherline_channel_mentions_',          match: 'prefix', include: false, why: 'Counter' },
    { pattern: 'cipherline_servers_{uid}',              match: 'exact',  include: false, why: 'Server-list cache' },
    { pattern: 'cipherline_srv_channels_{uid}',         match: 'prefix', include: false, why: 'Channel-list cache' },
    { pattern: 'cipherline_server_notif_defaults_{uid}', match: 'exact', include: false, why: 'Server-side defaults cache' },
    { pattern: 'cipherline_muted_servers_{uid}',        match: 'exact',  include: false, why: 'Legacy, migrated into server notif prefs' },
    { pattern: 'cipherline_pin_ledger_{uid}',           match: 'exact',  include: false, why: 'Pin-sync bookkeeping' },
    { pattern: 'cipherline_gif_sync_seen_{uid}',        match: 'exact',  include: false, why: 'GIF-sync bookkeeping (which slot revision this DEVICE applied — device-specific, must not restore)' },
    { pattern: 'cipherline_gif_sync_view_{uid}',        match: 'exact',  include: false, why: 'GIF-sync bookkeeping (what this DEVICE knows about the slot, for anti-entropy — device-specific, must not restore)' },
    { pattern: 'cipherline_achievements_sync_view_{uid}', match: 'exact', include: false, why: 'Achievements-sync bookkeeping (what this DEVICE knows about the achievements slot — device-specific, must not restore)' },
    { pattern: 'cipherline_achievements_{uid}',         match: 'exact',  include: true,  why: 'Achievement progress (utils/achievements/state.ts): per-device counters, unlocks and the Most-played opt-in. Account progress, so a restore keeps it; the merge is a CRDT (per-device max, sum across devices) so a restore can only add' },
    { pattern: 'cipherline_weekly_games_{uid}',         match: 'exact',  include: false, why: 'Rolling per-day play time on THIS machine (utils/achievements/mostPlayed.ts) — a week of device-local activity, expires on its own, must not travel' },
    { pattern: 'cipherline_profile_notes_sync_view_{uid}', match: 'exact', include: false, why: 'Notes-sync bookkeeping (what this DEVICE knows about the profile_notes slot — device-specific, must not restore)' },
    { pattern: 'cipherline_profile_notes_{uid}',        match: 'exact',  include: true,  why: 'Private notes on people (utils/profileNotes.ts): only you ever see them. Your own account data, so a restore keeps them; the merge is per-person last-writer-wins with tombstones, so a restore can only add or lose to a newer edit' },
    { pattern: 'cipherline_friend_anniversaries_{uid}', match: 'exact', include: false, why: 'Which friend anniversaries this DEVICE already toasted this year (utils/profileMoments.ts) — a per-device nudge ledger, restoring it would only suppress or repeat a toast' },
    { pattern: 'cipherline_saves_sync_view_{uid}',      match: 'exact',  include: false, why: 'Saves-sync bookkeeping (what this DEVICE knows about the personal_saves slot — device-specific, must not restore)' },
    { pattern: 'cipherline_local_channel_pin_ledger_{uid}', match: 'exact', include: false, why: 'Channel-save sync bookkeeping (LWW ledger; the saves themselves are vault.localChannelPins)' },
    { pattern: 'cipherline_last_activity_{uid}',        match: 'exact',  include: false, why: 'Derived from history' },
    { pattern: 'cipherline_last_dm_{uid}',              match: 'exact',  include: false, why: 'Navigation state' },
    { pattern: 'cipherline_last_group_{uid}',           match: 'exact',  include: false, why: 'Navigation state' },
    { pattern: 'cipherline_last_channel_{uid}',         match: 'exact',  include: false, why: 'Navigation state' },
    { pattern: 'cipherline_drive_last_backup_{uid}',    match: 'exact',  include: false, why: 'Backup bookkeeping' },
    { pattern: 'cipherline_backup_last_ts_{uid}',       match: 'exact',  include: false, why: 'Backup bookkeeping' },
    { pattern: 'cipherline_backup_fp_{uid}',            match: 'exact',  include: false, why: 'Backup bookkeeping (per-destination)' },
    { pattern: 'cipherline_backup_last_dest_{uid}',     match: 'exact',  include: false, why: 'Backup bookkeeping (per-destination clocks)' },
    // MUST stay excluded, and for a security reason rather than a size one:
    // this is the out-of-file anchor that says "the newest backup this DEVICE
    // wrote here". Carry it inside the backup and restoring an old file would
    // restore an old floor along with it — the rollback would authorise
    // itself. See backupGenerationFloor.ts.
    { pattern: 'cipherline_backup_gen_floor_{uid}',     match: 'exact',  include: false, why: 'Rollback floor — device-local by design; must never travel inside a backup' },
    { pattern: 'cipherline_backup_blocked_{uid}',       match: 'exact',  include: false, why: 'Backup bookkeeping' },
    { pattern: 'cipherline_auto_backup_cfg_{uid}',      match: 'exact',  include: false, why: 'Legacy, removed' },
    { pattern: 'cipherline_home_backup_muted_{uid}',    match: 'exact',  include: false, why: 'Nudge state' },
    { pattern: 'cipherline_removed_attachments_{uid}',  match: 'exact',  include: false, why: 'Bookkeeping' },
    { pattern: 'cipherline_seen_large_attachments',     match: 'exact',  include: false, why: 'Bookkeeping' },
    { pattern: 'avatar_key_fallback_',                  match: 'prefix', include: false, why: 'Non-Electron fallback; vault.avatarKeys covers Electron' },
    // Peer identity cache (user/device -> avatar attachment id + username).
    // EXCLUDED, and the call is closer than most of this list, so the reasoning
    // is written out.
    //
    // FOR including it: it is not secret (an attachment id opens nothing on its
    // own — the server still authorises every key and download — and a username
    // is visible to anyone who can read the message it labels), and carrying it
    // would make the first screen after a RESTORE paint as well as the first
    // screen after a restart does.
    //
    // AGAINST, and decisive: it is a map of who this account talks to. This app
    // keeps the social graph on-device only, and a backup file is the one thing
    // here that deliberately TRAVELS — to Google Drive, to a folder the user
    // copies to a USB stick. Widening where that map lives is a real cost.
    // Against which the benefit is close to zero: the blob cache it pairs with
    // (`avatars_dec`) is not in the backup either, so a restored device would
    // get the ids and none of the pictures — the metadata without the
    // experience — and would re-download every avatar exactly as it does today.
    // One directory fetch per conversation rebuilds the whole thing.
    { pattern: 'cipherline_peer_identity_{uid}',        match: 'exact',  include: false, why: 'Avatar-id / username cache — social-graph metadata that must not travel in a file; rebuilt by one directory fetch, and the blobs it points at are not backed up either' },
    { pattern: 'cipherline_first_friend_{uid}',         match: 'exact',  include: false, why: 'One-shot celebration' },
    // The Home easter-egg game's best score (utils/firewallBest.ts). A bit of
    // fun on this device, not account data: not worth a record in a file that
    // travels to Drive or a USB stick, and losing it to a restore costs nothing.
    { pattern: 'cipherline_firewall_best_{uid}',        match: 'exact',  include: false, why: 'Home easter-egg game best score — a toy, not account data; never travels' },
    // LEGACY: the first, local-only "eggs found" tally from the full-screen
    // moments branch. Nothing writes it any more; on account bind
    // utils/eggProgress.ts folds its registry ids into
    // cipherline_egg_progress_{uid} (above) and otherwise ignores it. Classified
    // like that key (include) so a backup taken on such a build still restores
    // the user's own progress — egg ids only, nothing about messages or people.
    { pattern: 'cipherline_eggs_found_{uid}',           match: 'exact',  include: true,  why: 'LEGACY easter eggs found (pre-sync tally; read-only, migrated into cipherline_egg_progress_{uid} on bind by utils/eggProgress.ts) — the user\'s own progress, egg ids only' },
    { pattern: 'cipherline_keys_spam_bag_{uid}',        match: 'exact',  include: false, why: 'Which Home spam-egg show Keys does next (utils/keysSpamStore.ts) — a toy, not account data; never travels' },
    { pattern: 'cipherline_pro_seen_{uid}',             match: 'exact',  include: false, why: 'Last tier this device saw (utils/proCelebration.ts) — gates the once-per-purchase Pro celebration; per-device UI state: a fresh device records what it first sees and does not celebrate' },
    { pattern: 'cipherline_trial_banner_dismissed_{uid}', match: 'exact', include: false, why: 'Billing banner state' },
    { pattern: 'cipherline_pastdue_banner_shows_{uid}', match: 'exact',  include: false, why: 'Billing banner state' },
    // Announcement-banner dismissals: ephemeral per-device UI state, same
    // class as the two billing-banner keys above. Excluded deliberately —
    // the server already resolves which banners apply to this user right
    // now (server-lean: it never learns who dismissed what), so there is no
    // account-level "dismissed" fact to restore; a restored device simply
    // re-dismisses on first sight if the banner is still live, which is a
    // one-click, low-stakes cost. It's also a poor fit for a backup that can
    // be months old: a dismissal list from then is mostly ids for banners
    // that no longer exist, and (per the bounded, LRU-capped store in
    // announcements.ts) restoring it could evict recent, still-relevant
    // dismissals in favor of stale ones.
    { pattern: 'cipherline_announcement_dismissed_{uid}', match: 'exact', include: false, why: 'Announcement-banner dismissal state (ephemeral per-device UI state)' },
    // Server storage-grace notice dismissals (components/server/ServerStorageBanner.tsx),
    // keyed by the API's notice_id. Same class as the announcement list above:
    // only the after-the-fact notices (trimmed / all set) are dismissible, the
    // API stops returning them on its own, and a restored device re-dismissing
    // once costs a click. It would also put a list of server-scoped notice ids
    // into a file that travels — not worth it for UI state.
    { pattern: 'cipherline_storage_notice_dismissed_{uid}', match: 'exact', include: false, why: 'Server storage-grace notice dismissal state (ephemeral per-device UI state)' },
    // Crash-recovery rejoin record (utils/callRejoinStore.ts). MUST stay
    // excluded, and for a security reason rather than a size one: for a DM/
    // group call it carries the call's E2EE key, which is deliberately
    // short-lived (rewritten every 30 s while the call is live, deleted when
    // it ends, ignored and deleted at startup once 150 s stale). A backup
    // would turn a key that is meant to die with the call into a durable
    // artifact — and the record is meaningless on another device or later
    // anyway: it names a live session on THIS device's call.
    { pattern: 'cipherline_call_rejoin_{uid}',          match: 'exact',  include: false, why: 'Crash-recovery call record incl. a DM call E2EE key — ephemeral by design, never backed up' },
    { pattern: 'cl_referral_welcome_{uid}',             match: 'exact',  include: false, why: 'One-shot' },
    // Signup attribution (utils/signupAttribution.ts). All four are one-shot or
    // install-local carry-over state — a referral/invite code waiting to be used
    // (expires after 14 days), the "already looked at the clipboard once" flag, and
    // the referrer's tag kept for the one-click friend request. None is account
    // data worth restoring, and the referrer tag is exactly the who-invited-whom
    // metadata that must not travel in a backup file.
    { pattern: 'cl_attr_pending_ref_v1',                match: 'exact',  include: false, why: 'One-shot carry-over of a referral code until signup uses it (14-day TTL)' },
    { pattern: 'cl_attr_pending_invite_v1',             match: 'exact',  include: false, why: 'One-shot carry-over of a server invite until the join prompt is answered (14-day TTL)' },
    { pattern: 'cl_attr_clipboard_checked_v1',          match: 'exact',  include: false, why: 'Install-local "first-launch clipboard hand-off already checked" flag' },
    { pattern: 'cl_referrer_{uid}',                     match: 'exact',  include: false, why: 'One-shot friend-request offer; who-invited-whom metadata must not travel in a file' },
    { pattern: 'cl_hx_{uid}',                           match: 'exact',  include: false, why: 'One-shot' },
    { pattern: 'sent_avatar_',                          match: 'prefix', include: false, why: 'Legacy marker' },
    { pattern: 'kv_verify_',                            match: 'prefix', include: false, why: 'Legacy v1 verification keys (v2 above is included)' },
    { pattern: 'cipherline_rcv_jwk_',                   match: 'prefix', include: false, why: 'Dead key' },
];

/** Electron SecureStore keys that are app preferences (included). Every
 *  other SecureStore key is key material or credentials and is excluded. */
export const APP_PREF_KEYS = [
    'minimizeToTray', 'startMinimized', 'gameCustomGames', 'gameIgnoredProcesses',
] as const;

/** SecureStore keys / prefixes that must never appear in a backup. Listed
 *  so the source-scan test can prove every `secureStore.set(` is classified. */
export const SECURE_STORE_EXCLUDED = [
    '__canary__', 'identity_priv', 'identity_pub', 'registration_id', 'signed_prekey_', 'otp_',
    'needs_bundle_reupload', '__eph_replay__', 'channel_keys:', 'protected_epochs:', 'avatar_key:',
    'backup_derived_keys', 'drive_backup_password', 'oauth:google:', 'loginItemDefaultApplied',
    // Excluded on purpose, and it is a security exclusion rather than a size
    // one. Restoring it would let a backup file silently move a machine onto
    // the staging update channel — autoDownload and autoInstallOnAppQuit are
    // both on, so that decides which binaries the machine installs. It is
    // also machine-local by nature. Changing channel goes through the
    // `updater:set-channel` IPC and its native confirmation dialog; see the
    // matching note in electron/secure-store-policy.ts.
    'updateChannel',
    // G4: the channel-message replay ledger — device-local security state,
    // same class as '__eph_replay__'.
    '__chan_replay__',
    // G8: "you've seen the weak-keystore notice" — describes THIS machine's
    // keystore, so restoring it elsewhere would suppress a true warning.
    'keyprot_notice_ack',
    // Crash reporter (electron/diagnostics.ts): crash records waiting for the
    // user to send or dismiss them. About THIS machine's crashes, and a backup
    // restored elsewhere would re-offer reports for crashes that machine never
    // had — device-local by definition.
    'diag_pending_crashes',
    // Staging lock (electron/staging-lock.ts): "this device passed the staging
    // password check", bound to the current verifier. Device-local by
    // definition, and a security exclusion like 'updateChannel': restoring it
    // would unlock staging builds on a machine that never entered the
    // password. Prefix also covers the dev-preview key.
    'staging_unlock',
    // F10: "this device has had its one legacy raw-record migration boot"
    // (electron/kv-crypto.ts). Device-local security state; restoring it
    // elsewhere would only close a window that device never had open.
    'kv_raw_migration_closed_v1',
];

const UID = '{uid}';

function ruleFor(key: string, userId: string): KvRule | null {
    for (const r of KV_RULES) {
        const p = r.pattern.split(UID).join(userId);
        if (r.match === 'exact' ? key === p : key.startsWith(p)) return r;
    }
    return null;
}

/** Whether a secureLocalStore key is backed up, excluded, or unknown. */
export function classifyKvKey(key: string, userId: string): 'include' | 'exclude' | 'unknown' {
    const r = ruleFor(key, userId);
    return r ? (r.include ? 'include' : 'exclude') : 'unknown';
}

/** Replace the account id in a key with the `{uid}` placeholder (export). */
export function toPortableKey(key: string, userId: string): string {
    return userId ? key.split(userId).join(UID) : key;
}
/** Inverse of toPortableKey (restore). */
export function fromPortableKey(key: string, userId: string): string {
    return key.split(UID).join(userId);
}

/** Collect every included key/value from a store that exposes
 *  `keysWithPrefix` + `getItem` (secureLocalStore), keyed portably. */
export function collectIncludedKv(
    store: { keysWithPrefix(prefix: string): string[]; getItem(key: string): string | null },
    userId: string,
): Record<string, string> {
    const out: Record<string, string> = {};
    // Every rule's literal prefix (up to any {uid}) narrows the scan.
    const prefixes = new Set(KV_RULES.filter(r => r.include).map(r => r.pattern.split(UID)[0]));
    const seen = new Set<string>();
    for (const prefix of prefixes) {
        for (const key of store.keysWithPrefix(prefix)) {
            if (seen.has(key)) continue;
            seen.add(key);
            if (classifyKvKey(key, userId) !== 'include') continue;
            const v = store.getItem(key);
            if (v !== null) out[toPortableKey(key, userId)] = v;
        }
    }
    return out;
}

/** Dispatched on `window` once importLocalHistory has finished applying a
 *  backup / history transfer to a RUNNING app. Hooks that cached a restored
 *  setting at mount (the server rail layout) re-read it on this, so a live
 *  restore — device-to-device history sync does not reload the page — is not
 *  left showing the pre-restore state that the user's next drag would then
 *  persist over the restored value. `detail.userId` is the restored account. */
export const BACKUP_RESTORED_EVENT = 'cipherline:backup-restored';

/**
 * The server rail is TWO keys for one setting: the v2 layout (order + folders)
 * and the legacy flat order. loadRailLayout prefers v2 when it exists. A backup
 * from a pre-folder build carries only the legacy order, so restored over a
 * device that already has a v2 record the restored order would be written but
 * never read — the restore would silently do nothing. When the backup has the
 * legacy order and NO layout, drop the local layout so the restored order is
 * authoritative. (A backup with neither key leaves the local rail alone.)
 * Returns whether a local layout was dropped.
 */
export function dropShadowingRailLayout(
    store: { removeItem(key: string): void },
    kv: Record<string, string>,
    userId: string,
): boolean {
    if (typeof kv['cipherline_server_rail_order_' + UID] !== 'string') return false;
    if (typeof kv['cipherline_server_rail_layout_' + UID] === 'string') return false;
    store.removeItem(`cipherline_server_rail_layout_${userId}`);
    return true;
}

// ── Custom notification sounds ──────────────────────────────────────────────
// Notification prefs point at custom sounds by absolute `file://` path on the
// machine that saved them. After a restore those paths belong to another
// machine (or another user directory), so re-point each reference at this
// machine's copy by filename, and fall back to the bundled default for any
// category whose file didn't make it.

const soundBasename = (p: string): string => p.replace(/^file:\/\//, '').split(/[\\/]/).pop() ?? '';
const isBundledSound = (p: string): boolean => p.startsWith('./') || p.startsWith('/sounds/') || p.startsWith('sounds/');

export interface SoundPrefsShape {
    sounds?: Record<string, { file?: string } & Record<string, unknown>>;
    custom_sounds?: { name: string; file: string }[];
    [k: string]: unknown;
}

export function repairSoundPaths<T extends SoundPrefsShape>(
    prefs: T,
    available: { name: string; file: string }[],
    defaults: Record<string, string>,
): { prefs: T; changed: boolean } {
    const byBase = new Map<string, string>();
    for (const s of available) byBase.set(soundBasename(s.file), s.file);
    let changed = false;
    const out: T = { ...prefs };

    if (Array.isArray(prefs.custom_sounds)) {
        const kept: { name: string; file: string }[] = [];
        for (const entry of prefs.custom_sounds) {
            if (!entry || typeof entry.file !== 'string') { changed = true; continue; }
            const here = byBase.get(soundBasename(entry.file));
            if (!here) { changed = true; continue; }
            if (here !== entry.file) changed = true;
            kept.push({ ...entry, file: here });
        }
        out.custom_sounds = kept;
    }

    if (prefs.sounds && typeof prefs.sounds === 'object') {
        const sounds: NonNullable<T['sounds']> = { ...prefs.sounds } as NonNullable<T['sounds']>;
        for (const [cat, p] of Object.entries(prefs.sounds)) {
            const file = p?.file;
            if (typeof file !== 'string' || isBundledSound(file)) continue;
            const here = byBase.get(soundBasename(file)) ?? defaults[cat];
            if (here && here !== file) {
                sounds[cat] = { ...p, file: here };
                changed = true;
            }
        }
        out.sounds = sounds;
    }
    return { prefs: out, changed };
}

/** Apply a portable kv map to the store for `userId`. Only keys the
 *  registry includes are written — a backup can't smuggle in session
 *  material or overwrite keys the vault carries structurally. */
export function applyIncludedKv(
    store: { setItem(key: string, value: string): void },
    kv: Record<string, string>,
    userId: string,
): number {
    let applied = 0;
    for (const [portable, value] of Object.entries(kv)) {
        if (typeof value !== 'string') continue;
        const key = fromPortableKey(portable, userId);
        if (classifyKvKey(key, userId) !== 'include') continue;
        store.setItem(key, value);
        applied++;
    }
    return applied;
}
