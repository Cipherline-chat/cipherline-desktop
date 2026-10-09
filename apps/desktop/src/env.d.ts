/// <reference types="vite/client" />

export {};

declare global {
    // Mirrors electron/updater-state.ts's UpdateState — see that file's
    // module doc for what each phase means and why 'manual' exists.
    type UpdateStateShape =
        | { phase: 'idle' }
        | { phase: 'available'; version: string }
        | { phase: 'downloading'; version: string; percent: number }
        | { phase: 'ready'; version: string }
        | { phase: 'manual'; version: string; downloadUrl: string };

    interface ElectronAPI {
        onReady: (callback: () => void) => void;
        getLocalIdentity: () => Promise<string | null>;
        /** Host platform, resolved synchronously in preload via process.platform. */
        platform: 'windows' | 'mac' | 'linux';
        /** macOS major version (15 = Sequoia); null off macOS or when unreadable. Absent on an older preload. */
        macOSMajor?: number | null;
        /** Machine hostname (from the main process), used as a friendly device label. */
        getDeviceName: () => Promise<string>;
        getDesktopSources: (types?: Array<'window' | 'screen'>, opts?: { thumbnails?: boolean }) => Promise<Array<{ id: string, name: string, thumbnailDataUrl: string }>>;
        resolveDesktopSource: (sourceId: string | null, withAudio?: boolean) => Promise<void>;
        onShowScreensharePicker: (callback: () => void) => () => void;
        /** Desktop annotation overlay for the local screen / window share
         *  (docs/video-annotation-design.md, Phase 5). Resolves to the show
         *  result, with a refusal reason when nothing can be overlaid; a main
         *  process older than that resolves a bare boolean. */
        annotationOverlayShow?: (sourceId: string) => Promise<boolean | import('./utils/annotationOverlayTypes').OverlayShowResult>;
        annotationOverlayHide?: () => Promise<void>;
        annotationOverlayPush?: (delta: import('./utils/annotationOverlayTypes').OverlayDelta) => void;
        /** macOS Screen Recording (TCC) status — exactly Electron's
         *  getMediaAccessStatus strings, or 'not-applicable' off macOS.
         *  Optional: an older preload won't have it. */
        getScreenCaptureAccess?: () => Promise<import('./utils/screenCapturePermission').ScreenCaptureAccess>;
        /** macOS only: opens System Settings → Privacy & Security → Screen
         *  Recording. No argument — the URL is hardcoded in the main process. */
        openScreenRecordingSettings?: () => Promise<boolean>;
        getAvatarKey: (attachmentId: string) => Promise<{ keyB64: string, nonceB64: string } | null>;
        setAvatarKey: (attachmentId: string, keyB64: string, nonceB64: string) => Promise<boolean>;
        /** Enumerate every `avatar_key:*` entry in the secure store — used
         *  by the encrypted-backup exporter. */
        listAvatarKeys: () => Promise<Record<string, { keyB64: string; nonceB64: string }>>;
        getSystemIdleTime: () => Promise<number>;
        perfRecord?: (rows: Array<{ at: number; ms: number; activity: string }>) => Promise<number>;
        perfGetLog?: () => Promise<Array<{ at: number; source: 'main' | 'renderer' | 'event' | 'metrics'; ms: number; activity: string }>>;
        perfClear?: () => Promise<void>;
        /** Lower main's stall threshold to 100 ms and sample per-process
         *  CPU/memory every 2 s for `ms` (default 60 s). */
        perfStartCapture?: (ms?: number) => Promise<void>;
        /** Crash / issue reporter (electron/diagnostics.ts). `unknown` replies
         *  are narrowed by src/utils/diagnostics/ipc.ts. Optional: an older
         *  main process does not have them. */
        diagGetSystemInfo?: () => Promise<unknown>;
        diagGetPendingCrashes?: () => Promise<unknown>;
        diagClearPendingCrashes?: (signatures?: string[]) => Promise<void>;
        diagMarkCrashesSeen?: (signatures?: string[]) => Promise<void>;
        diagRecordRendererCrash?: (payload: { name?: string; message?: string; stack?: string }) => Promise<void>;
        diagSaveReport?: (category: string, json: string) => Promise<{ status: 'saved' | 'cancelled' }>;
        onOsLockScreen: (callback: () => void) => () => void;
        onOsResume: (callback: () => void) => () => void;
        /** Per-display refresh rate. Screen capture cannot exceed it — a
         *  `displayFrequency` of 0 means the platform didn't report one. */
        getDisplayRefreshRates?: () => Promise<Array<{ id: string; displayFrequency: number; isPrimary: boolean }>>;
        /** Stream-stats overlay diagnostics for a screen-share source. Typed
         *  `unknown` on purpose: src/utils/screenShareDiagnostics.ts narrows
         *  it field by field (parseMainDiagnostics), so an older/newer main
         *  process can never feed the overlay a shape it trusts blindly. */
        getScreenShareDiagnostics?: (sourceId: string) => Promise<unknown>;
        /** Chromium's per-frame capture timing (only while the capture timing
         *  log is on; otherwise resolves null). Narrowed by parseCaptureTiming. */
        getScreenCaptureTiming?: () => Promise<unknown>;
        /** Settings → Advanced startup flags (screen capture method, capture
         *  timing log), kept by main in <userData>/startup-flags.json and
         *  applied on the next launch. `unknown` on purpose: narrowed by
         *  src/utils/startupFlags.ts parseStartupFlagsState. Optional because
         *  an older main process does not have them. */
        getStartupFlags?: () => Promise<unknown>;
        /** Rejects on an unknown key or a value outside the enum. */
        setStartupFlags?: (patch: { screenCapturer?: 'auto' | 'dxgi' | 'wgc'; captureLog?: boolean; gamingVideo?: boolean }) => Promise<unknown>;
        /** Quit normally and start again (Electron relauncher). */
        relaunchApp?: () => Promise<void>;
        /** A call started (true) / ended (false) — main raises / restores
         *  process priority while "Prioritize call video while gaming" is on
         *  (electron/gaming-video-mode.ts). Optional: older main processes. */
        setCallMediaActive?: (active: boolean) => Promise<void>;

        // On-disk GIF library — each favorite lives as an AES-GCM-encrypted
        // `.enc` file under userData/cipherline-gifs/. Backup reads every
        // file via IPC; restore writes them back.
        listGifFiles: () => Promise<string[]>;
        readGifFile: (id: string) => Promise<Uint8Array>;
        writeGifFile: (id: string, data: Uint8Array) => Promise<void>;

        // Generate/load Signal identity and return the bundle for server upload.
        // `is_new`: this call minted the identity. For an existing identity the
        // one-time prekeys are newest-first, capped at 200, and gated by
        // `opts.unclaimedPrekeyIds` when given (may then be EMPTY).
        ensureIdentityBundle: (deviceId: string, opts?: { unclaimedPrekeyIds?: number[] }) => Promise<{
            device_id: string;
            is_new?: boolean;
            identity_key_pub_b64: string;
            registration_id: number;
            signed_prekey: { id: number; pub_b64: string; sig_b64: string };
            one_time_prekeys: { prekey_id: number; prekey_pub_b64: string }[];
        }>;
        // Top-up / signed-prekey rotation bundle (see preload.ts). With
        // `otpPoolLow` set, null means "nothing needs publishing".
        getRotationBundle?: (opts?: {
            rotateSpk?: boolean;
            unclaimedPrekeyIds?: number[];
            retiredPrekeyIds?: number[];
            otpPoolLow?: boolean;
        }) => Promise<{
            identity_key_pub_b64: string;
            registration_id: number;
            signed_prekey: { id: number; pub_b64: string; sig_b64: string };
            one_time_prekeys: { prekey_id: number; prekey_pub_b64: string }[];
        } | null>;
        // Paging cursor for GET /v1/keys/status `held_from`. Integer or null.
        getLowestHeldOtpId?: () => Promise<number | null>;

        // E2EE message encryption/decryption (ECIES v:3 sealed sender, runs in main process)
        // senderDeviceId is optional (RC-7 / Phase 5 — TOFU per (user, device)).
        encryptMessage: (contentJson: string, senderUserId: string, devices: { device_id: string; spk_pub_b64: string; sig_b64?: string; identity_pub_b64?: string; otp_pub_b64?: string | null; otp_id?: number | null }[], senderDeviceId?: string) => Promise<string>;
        // v2: also returns which devices actually got wrapped (RC-2 fix — see encryptAndAddress.ts).
        encryptMessageV2: (contentJson: string, senderUserId: string, devices: { device_id: string; spk_pub_b64: string; sig_b64?: string; identity_pub_b64?: string; otp_pub_b64?: string | null; otp_id?: number | null }[], senderDeviceId?: string) => Promise<{ envelope_b64: string; wrapped_device_ids: string[] }>;
        decryptMessage: (ciphertextB64: string, myDeviceId: string) => Promise<{ contentJson: string; senderPub?: string; senderUserId?: string; senderDeviceId?: string; usedOneTimePrekey?: boolean }>;

        // Native WASAPI ApplicationLoopback audio capture (Windows)
        getPidFromSourceId: (sourceId: string) => Promise<number | null>;
        getOwnPid: () => Promise<number>;
        /** Returns true only if the native audio_capture.node addon loaded successfully
         *  (Windows only). Renderer should gate native capture on this, not on the mere
         *  presence of startWindowAudioCapture (which is always exposed by preload). */
        isAudioCaptureSupported: () => Promise<boolean>;
        startWindowAudioCapture: (pid: number, mode?: 'include' | 'exclude') => Promise<boolean>;
        stopWindowAudioCapture: () => Promise<void>;
        onWindowAudioChunk: (
            callback: (chunk: { sampleRate: number; channels: number; data: ArrayBuffer }) => void
        ) => void;
        removeWindowAudioChunkListener: () => void;
        /** Fires once when the native addon detects the captured process exited
         *  mid-share (distinct from silence — see audio_capture.cc's IsProcessAlive). */
        onWindowAudioProcessExited: (callback: () => void) => void;
        removeWindowAudioProcessExitedListener: () => void;
        onWindowAudioFailed: (callback: (info: { reason: string }) => void) => void;
        removeWindowAudioFailedListener: () => void;

        // Filesystem & dialogs (for backup/restore)
        saveFileAs: (opts: {
            title?: string;
            defaultPath?: string;
            filters?: { name: string; extensions: string[] }[];
        }, data: Uint8Array) => Promise<{ canceled: boolean; filePath?: string; size?: number }>;
        showSaveDialog: (opts: {
            title?: string;
            defaultPath?: string;
            filters?: { name: string; extensions: string[] }[];
            properties?: string[];
        }) => Promise<{ canceled: boolean; filePath?: string }>;
        showOpenDialog: (opts: {
            title?: string;
            defaultPath?: string;
            filters?: { name: string; extensions: string[] }[];
            properties?: ('openFile' | 'openDirectory' | 'multiSelections' | 'showHiddenFiles' | 'createDirectory' | 'promptToCreate' | 'noResolveAliases' | 'treatPackageAsDirectory' | 'dontAddToRecent')[];
        }) => Promise<{ canceled: boolean; filePaths: string[] }>;
        writeFile: (filePath: string, data: Uint8Array) => Promise<{ ok: boolean; size: number }>;
        writeBackupFile: (dir: string, filename: string, data: Uint8Array) => Promise<{ ok: boolean; path: string; size: number }>;
        readFile: (filePath: string) => Promise<ArrayBuffer>;
        readDir: (dirPath: string) => Promise<string[]>;
        deleteFile: (filePath: string) => Promise<{ ok: boolean }>;
        registerDir: (dirPath: string) => Promise<{ ok: boolean }>;
        // Streamed single-file backup writer + ranged reader (backupContainer.ts).
        backupBeginWrite: (dir: string, filename: string, mode?: 'fresh' | 'update') => Promise<{ sessionId: string; size: number }>;
        backupAppend: (sessionId: string, data: Uint8Array) => Promise<void>;
        backupWriteAt: (sessionId: string, offset: number, data: Uint8Array) => Promise<void>;
        backupCommit: (sessionId: string) => Promise<{ path: string; size: number }>;
        backupAbort: (sessionId: string) => Promise<void>;
        backupStat: (filePath: string) => Promise<{ size: number; mtimeMs: number } | null>;
        backupReadRange: (filePath: string, offset: number, length: number) => Promise<ArrayBuffer>;
        backupStagingDir: () => Promise<string>;
        gdriveUploadFile: (folderId: string, fileName: string, filePath: string) => Promise<{ id: string; size: number; md5Checksum: string }>;
        gdriveDownloadFile: (fileId: string, fileName: string) => Promise<{ path: string; size: number }>;
        onGdriveTransferProgress: (cb: (p: { kind: 'upload' | 'download'; done: number; total: number }) => void) => (() => void);

        // Auto-updater — full lifecycle. Canonical shape lives in
        // electron/updater-state.ts (UpdateState); mirrored here rather than
        // imported since this is an ambient .d.ts for the renderer and that
        // module is main-process-only. Keep the two in sync by hand.
        //
        // 'manual' exists because auto-install isn't reliable on every
        // platform (see that file's module doc) — the renderer must be able
        // to render "here's a direct download link" as a first-class state,
        // not treat it as an error.
        /** Fires when the OS resumes from sleep / unlocks. Returns an unsubscribe. */
        onAppResumed: (callback: () => void) => () => void;
        /** ONE coalesced event per wake episode (electron/power-events.ts),
         *  sent ~1.5 s after the OS signal. Durations only. */
        onPowerResumed?: (callback: (p: {
            reason: 'resume' | 'unlock' | 'resume+unlock' | 'clock-jump';
            asleepMs: number | null;
            lockedMs: number | null;
            at: number;
        }) => void) => () => void;
        /** The main window came back from minimized / hidden (tray) — once per
         *  restore, the restore/show/focus burst coalesced. */
        onWindowRestored?: (callback: (p: { from: 'minimized' | 'hidden'; hiddenMs: number | null; at: number }) => void) => () => void;
        onUpdateState: (callback: (state: UpdateStateShape) => void) => () => void;
        getUpdateState: () => Promise<UpdateStateShape>;
        quitAndInstall: () => Promise<void>;
        /** Force an update check now (Settings → Advanced). True = a real
         *  check was dispatched; false = this build has no updater to ask
         *  (dev server / smoke test). Rejects if the check fails. The outcome
         *  itself lands on onUpdateState, not in this return value. */
        checkForUpdatesNow: () => Promise<boolean>;
        // Update channel — 'latest' is the default real-user stream,
        // 'staging' is the opt-in pre-release stream backed by
        // staging.yml/staging-mac.yml in the same updates bucket.
        getUpdateChannel: () => Promise<'latest' | 'staging'>;
        setUpdateChannel: (channel: 'latest' | 'staging') => Promise<'latest' | 'staging'>;
        // Staging lock (electron/staging-lock.ts; shapes mirrored by hand —
        // src/ must not import from electron/). Main owns the state and the
        // password check; setUpdateChannel('staging') rejects with a message
        // containing 'STAGING_LOCKED' while locked.
        getStagingLockStatus: () => Promise<{
            /** The lock exists in this build at all (packaged, not smoke test, or dev preview). */
            enforced: boolean;
            /** Show the full-screen unlock screen until unlocked. */
            isStagingBuild: boolean;
            unlocked: boolean;
            retryAfterMs: number;
        }>;
        /** Password ≤ 256 chars; main rejects anything else. */
        unlockStaging: (password: string) => Promise<{ ok: boolean; retryAfterMs: number }>;
        relockStaging: () => Promise<{ enforced: boolean; isStagingBuild: boolean; unlocked: boolean; retryAfterMs: number }>;

        // Custom window controls (Windows / Linux only — not invoked on macOS)
        minimizeWindow: () => void;
        maximizeWindow: () => void;
        closeWindow: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;

        /** Returns the absolute filesystem path for a File object.
         *  Replaces File.path which was removed in Electron 32.
         *  Returns '' for in-memory / clipboard files that have no disk path. */
        getPathForFile: (file: File) => string;

        // Large-file streaming upload (files > 200 MB)
        encryptFileToTemp: (filePath: string) => Promise<{
            tempPath: string;
            keyB64: string;
            ivB64: string;
            encryptedSize: number;
        }>;
        streamUpload: (params: {
            url: string;
            filePath: string;
            contentType: string;
            size: number;
        }) => Promise<void>;
        onUploadProgress: (cb: (progress: { uploaded: number; total: number }) => void) => (() => void);
        onEncryptProgress: (cb: (progress: { encrypted: number; total: number }) => void) => (() => void);

        // Chunk-based file encryption — no file-path dependency, safe for any file size.
        // The renderer reads File.slice().arrayBuffer() in 16 MB increments and streams
        // each chunk to the main process for AES-256-GCM encryption.
        chunkEncryptBegin: () => Promise<{ sessionId: string }>;
        chunkEncryptWrite: (sessionId: string, chunk: Uint8Array) => Promise<void>;
        chunkEncryptEnd: (sessionId: string) => Promise<{ tempPath: string; keyB64: string; ivB64: string; encryptedSize: number }>;
        chunkEncryptAbort: (sessionId: string) => Promise<void>;

        // Sender-key channel crypto
        encryptChannelMessage: (contentJson: string, channelId: string, sender?: { user_id?: string | null; device_id?: string | null }) => Promise<{
            epoch: number;
            nonce_b64: string;
            ciphertext_b64: string;
            signature_b64: string;
        }>;
        decryptChannelMessage: (params: {
            channel_id: string;
            epoch: number;
            nonce_b64: string;
            ciphertext_b64: string;
            signature_b64: string;
            sender_identity_pub_b64: string;
            message_id?: string | null;
            sender_user_id?: string | null;
            sender_device_id?: string | null;
        }) => Promise<string>;
        setChannelKey: (channelId: string, epoch: number, keyB64: string, rotatesAt: string, replaceIfFingerprintB64?: string) => Promise<'stored' | 'duplicate' | 'conflict'>;
        getLatestChannelEpoch: (channelId: string) => Promise<number | null>;
        listChannelEpochs: (channelId: string) => Promise<number[]>;
        setProtectedEpochs: (channelId: string, epochs: number[]) => Promise<void>;
        getChannelKey: (channelId: string, epoch: number) => Promise<string | null>;
        getChannelKeyFingerprint: (channelId: string, epoch: number) => Promise<string | null>;
        listChannelEpochFingerprints: (channelId: string) => Promise<Record<number, string>>;
        discardChannelKey: (channelId: string, epoch: number) => Promise<void>;
        rotateChannelKey: (channelId: string, atEpoch?: number) => Promise<{ epoch: number; keyB64: string; rotatesAt: string }>;
        getLocalMasterKeyStatus: () => Promise<{ status: 'ok' | 'absent' | 'locked' }>;
        // NOTE: there is deliberately no `getLocalMasterKeyEx` here any more.
        // The device master key does not cross the context bridge; the two
        // channels below do its work in the main process instead.
        secureKvOpen: (records: Array<{ k: string; o: string | null; b: Uint8Array }>) => Promise<Array<{ k: string; v: string | null }>>;
        secureKvSeal: (records: Array<{ k: string; o: string | null; v: string }>) => Promise<Array<{ k: string; b: Uint8Array | null }>>;
        getBlobCacheKey: () => Promise<{ status: 'ok'; keyB64: string } | { status: 'absent' } | { status: 'locked' }>;
        /** Gated on a main-process confirmation dialog (electron/recovery-key-gate.ts).
         *  Returns a DISCRIMINATED result, never a bare string: a decline must not be
         *  reported to the user as "unavailable on this device". */
        revealRecoveryKey: () => Promise<
            | { ok: true; keyB64: string }
            | { ok: false; reason: 'locked' | 'declined' | 'busy' }
            | null
        >;
        recoverWithKey: (keyB64: string) => Promise<boolean>;
        factoryResetSecureStore: () => Promise<boolean>;
        getSecureStoreCorruption: () => Promise<{ backupFileName: string } | null>;
        getKeyProtection?: () => Promise<{
            level: 'os_keystore' | 'obfuscated' | 'plaintext' | 'unknown';
            reason: 'backend' | 'legacy_wrap' | 'no_keystore' | null;
            backend: string | null;
            platform: string;
            showNotice: boolean;
        }>;
        ackKeyProtectionNotice?: () => Promise<boolean>;
        fetchBinary: (url: string) => Promise<{ b64: string; mimeType: string }>;
        openExternal: (url: string) => Promise<void>;
        syncGlobalShortcuts: (map: Record<string, string>) => Promise<{ failed: string[] }>;
        onGlobalShortcut: (callback: (actionId: string) => void) => () => void;
        getUserDataPath: () => Promise<string>;
        setContentProtection: (enabled: boolean) => void;
        onDeepLinkInvite: (cb: (code: string) => void) => (() => void);
        getPendingDeepLinkCode: () => Promise<string | null>;
        onDeepLinkRef: (cb: (code: string) => void) => (() => void);
        getPendingDeepLinkRef: () => Promise<string | null>;
        /** First-launch install hand-off: one of OUR landing-page links on the
         *  clipboard (`{kind, code}`), else null. Never raw clipboard text. */
        peekAttributionClipboard: () => Promise<{ kind: 'ref' | 'invite'; code: string } | null>;
        onGameDetected: (cb: (data: { name: string; processName: string }) => void) => (() => void);
        onGameStopped: (cb: () => void) => (() => void);
        getCurrentGame: () => Promise<{ name: string; processName: string } | null>;
        /** Settings → Game activity off stops main's background process scan. */
        setGameDetectionEnabled?: (enabled: boolean) => void;
        getRunningProcesses: () => Promise<string[]>;

        // System behavior toggles (Appearance → System section in Settings)
        // "Start at login" on every platform (the name predates mac/Linux).
        getStartWithWindows: () => Promise<boolean>;
        /** supported=false in dev builds; needsApproval = macOS 13+ "allow in Login Items". */
        getLoginItemState?: () => Promise<{ supported: boolean; enabled: boolean; needsApproval: boolean }>;
        /** Resolves with the state re-read from the OS after the write (older builds: void). */
        setStartWithWindows: (enabled: boolean) => Promise<{ supported: boolean; enabled: boolean; needsApproval: boolean } | void>;
        getStartMinimized: () => Promise<boolean>;
        setStartMinimized: (enabled: boolean) => Promise<void>;
        getMinimizeToTray: () => Promise<boolean>;
        setMinimizeToTray: (enabled: boolean) => Promise<void>;
        readClipboard: () => Promise<string>;
        writeClipboard: (text: string) => Promise<void>;
        attestSign: () => Promise<string | null>;
        solvePow: (challenge: string, difficulty: number) => Promise<string | null>;
        getDeviceRegisterProof: (userId: string, proofTs: number) => Promise<{ identityPub: string; sig: string } | null>;
        /** C-2b — sign the history-sync capability advertisement with this
         *  device's identity key. null when the identity is unavailable; the
         *  caller must abandon the request rather than send it unsigned. */
        getHistoryRequestProof: (userId: string, requestingDeviceId: string, ts: number) => Promise<{ identityPub: string; sig: string } | null>;

        // ── QR sign-in (link) — electron/link-grant.ts holds the ephemeral
        // X25519 private key; it never crosses this bridge. docs/QR-LINKING.md §2.
        /** Mint the ephemeral keypair. Pass '' to mint before the server-issued
         *  link_id is known, then bind it with linkBind once the POST that
         *  creates it returns (see main.ts's 'link:begin' handler doc). */
        linkBegin: (linkId: string) => Promise<{ ekPubB64: string; fingerprint: string }>;
        /** Attach the real link_id to the session started by linkBegin(''). */
        linkBind: (linkId: string) => Promise<void>;
        /** Opens the sealed grant for the in-progress session. Rejects on ANY
         *  failure (bad envelope, wrong key, tampered ciphertext, mismatched
         *  link id) — there is no unsealed fallback to degrade to. */
        linkOpen: (envelopeB64: string, linkId: string) => Promise<import('./types/link').LinkGrantPayload>;
        linkEnd: () => Promise<void>;
        /** Mirror role (this desktop approves a phone that scanned its
         *  invite): seals a v2 grant to the phone's ephemeral key. */
        linkSeal: (payload: import('./types/link').LinkGrantPayload, ekPubB64: string, linkId: string) => Promise<string>;

        onWindowFocus: (cb: () => void) => (() => void);
        /** Continuity (cross-device attention routing) — see preload.ts and
         *  main.ts for why blur/minimize/quit are pushed from main rather
         *  than relying only on the renderer's own DOM events. */
        onWindowBlur: (cb: () => void) => (() => void);
        onWindowMinimize: (cb: () => void) => (() => void);
        onWindowHide: (cb: () => void) => (() => void);
        onBeforeQuit: (cb: () => void) => (() => void);
        // Reliability audit (Phase J): main-process-detected renderer hang/recovery,
        // informational only — never implies the call/audio pipeline died.
        onRendererUnresponsive: (cb: () => void) => (() => void);
        onRendererResponsive: (cb: () => void) => (() => void);

        // Batch SecureStore ops, restricted to electron/secure-store-policy.ts's
        // allowlist — unknown key names are silently dropped by main.
        secureReplaceMany: (entries: Record<string, string>) => Promise<boolean>;
        secureGetMany: (keys: string[]) => Promise<Record<string, string | null>>;
        secureDeleteMany: (keys: string[]) => Promise<boolean>;

        // ── Notifications ────────────────────────────────────────────────────
        notifShow: (payload: {
            id: string; title: string; body: string; conv_id: string;
            hasReply?: boolean; replyPlaceholder?: string;
            /** Sender avatar, 96x96 PNG data URL; main validates it and falls back to the app icon. */
            iconDataUrl?: string;
        }) => Promise<void>;
        notifSetBadge: (count: number) => Promise<void>;
        notifFlashTaskbar: () => Promise<void>;
        notifCloseAll: () => Promise<void>;
        uploadCustomSound: (filename: string, data: Uint8Array) => Promise<{ name: string; file: string }>;
        listCustomSounds: () => Promise<{ name: string; file: string }[]>;
        deleteCustomSound: (file: string) => Promise<{ ok: boolean }>;
        readCustomSound: (file: string) => Promise<Uint8Array>;
        onNotificationClicked: (cb: (conv_id: string) => void) => (() => void);
        onNotificationReplied: (cb: (data: { conv_id: string; text: string }) => void) => (() => void);
        notifReplyReady: () => Promise<{ pending: number }>;
        trayUpdateState: (state: { unreadCount: number; dndActive: boolean; dndManual: boolean; status: string; screenLockAvailable?: boolean }) => Promise<void>;
        traySetCallSpeaking: (inCall: boolean, isSpeaking: boolean, isMuted: boolean, isDeafened: boolean) => Promise<void>;
        onTraySetStatus: (cb: (status: 'online' | 'away' | 'dnd' | 'offline') => void) => (() => void);
        onTrayToggleDnd: (cb: (enabled: boolean) => void) => (() => void);
        onTrayLock: (cb: () => void) => (() => void);
        onTraySignOut: (cb: () => void) => (() => void);

        // Google Drive integration — OAuth link/unlink.
        // startOAuth opens the system browser; the main process handles the
        // loopback redirect and token exchange transparently.
        gdriveAuthStart: () => Promise<{ email: string; name: string }>;
        gdriveAuthStatus: () => Promise<{ linked: boolean; email?: string; name?: string }>;
        gdriveDisconnect: () => Promise<void>;
        gdriveGetToken: () => Promise<string | null>;
    }

    interface Window {
        electronAPI?: ElectronAPI;
    }

    /**
     * Window Controls Overlay API — present when Electron is painting native
     * caption buttons over the page (main.ts's `titleBarOverlay`). Not in TS's
     * DOM lib yet, so declared here.
     *
     * `visible` is the ground truth for "are native window controls already on
     * screen", which is how Dashboard's <WindowControls> avoids drawing a
     * second, overlapping set of them.
     */
    interface WindowControlsOverlay {
        readonly visible: boolean;
        getTitlebarAreaRect(): DOMRect;
    }
    interface Navigator {
        readonly windowControlsOverlay?: WindowControlsOverlay;
    }
}
