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
    { pattern: 'cipherline_server_rail_order_{uid}',    match: 'exact',  include: true,  why: 'Server rail drag-to-reorder order' },
    { pattern: 'cipherline_category_collapsed_{uid}_',  match: 'prefix', include: true,  why: 'Collapsed channel categories' },
    { pattern: 'cipherline_ignored_{uid}_',             match: 'prefix', include: true,  why: 'Ignored/blocked server members (safety)' },
    { pattern: 'kv_verify_v2_{uid}_',                   match: 'prefix', include: true,  why: 'Safety-number verification state per contact' },
    // Included for the same reason the pins above are, and it is a security
    // inclusion rather than a convenience one. The pins record what was
    // ACCEPTED (and which keys the user vouched for); this records what was
    // REJECTED and is still unresolved. Restoring only the first half would
    // bring a contact back looking verified/normal while the "…but something
    // changed after that" record was dropped on the floor — the recovery path
    // silencing an alarm. It also cannot be rebuilt from the pins: the
    // offending key is deliberately never written into the pin store, so
    // nothing else on disk remembers that it arrived. See senderWarningStore.ts
    // (`mergeWarnings`) for why restore unions this key instead of replacing it.
    { pattern: 'kv_warn_v1_{uid}',                      match: 'exact',  include: true,  why: 'Unresolved sender-identity warnings (key changed / unattributed) — not derivable from the pins' },
    // Included: this is the only record of which own devices this account had
    // already confirmed (docs/ghost-device.md). A fresh install restored from a
    // backup then alarms on devices added since, instead of re-baselining and
    // silently accepting whatever the server lists that day.
    { pattern: 'kv_own_devices_v1_{uid}',               match: 'exact',  include: true,  why: 'Own-device ledger (ghost-device alarm) — which own devices were confirmed' },
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
    // Settings → Advanced → Screen share & stream stats (streamDiagnosticsPrefs.ts).
    // The codec choice describes THIS machine's GPU encoder; restored onto a
    // machine without that encoder it would force a software encode. The
    // overlay is a testing aid, not a preference worth carrying.
    { pattern: 'cipherline_screenshare_codec',          match: 'exact',  include: false, why: 'Screen-share encoder override — about this device’s GPU, never travels' },
    { pattern: 'cipherline_stream_stats_hud',           match: 'exact',  include: false, why: 'Stream-stats overlay toggle — device-local testing aid' },

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
    { pattern: 'cipherline_status_pending_{uid}',       match: 'exact',  include: false, why: 'Unsent status change made while offline — device-local, settled on the next connect (utils/ownStatusSync.ts)' },
    { pattern: 'cipherline_storage_policy_{uid}',       match: 'exact',  include: false, why: 'Retention policy — per-device, never travels; only its explicitly SAVED ids ride in vault.retentionSaves (retentionPortability.ts)' },
    { pattern: 'cipherline_voice_settings',             match: 'exact',  include: false, why: 'vault.voiceSettings' },
    { pattern: 'cipherline_keybinds',                   match: 'exact',  include: false, why: 'vault.keybinds' },
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
    { pattern: 'cipherline_pro_welcomed_{uid}',         match: 'exact',  include: false, why: 'One-shot' },
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
