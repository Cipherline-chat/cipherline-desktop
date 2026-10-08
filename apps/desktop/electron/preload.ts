import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from './updater-state';
import type { LinkGrantPayload } from './link-grant';
import type { StagingLockStatus, StagingUnlockResult } from './staging-lock';
// webUtils was added in Electron 32 but is absent from the bundled .d.ts in
// this version of the electron package. Access it via require with a manual
// type annotation so tsc doesn't reject the import.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { webUtils } = require('electron') as {
    webUtils: { getPathForFile: (file: File) => string };
};

// ── Host platform ───────────────────────────────────────────────────────────
// `process.platform` is one of the few Node globals available inside a
// SANDBOXED preload (contextIsolation + sandbox). We must NOT import Node core
// modules like `os` here — that throws at load time and takes the whole
// contextBridge down (→ window.electronAPI undefined). The machine hostname,
// which does need `os`, is fetched lazily over IPC from the main process.
const HOST_PLATFORM: 'windows' | 'mac' | 'linux' =
    process.platform === 'darwin' ? 'mac'
    : process.platform === 'linux' ? 'linux'
    : 'windows';

// macOS major version (15 = Sequoia) or null off macOS / if unreadable.
// `process.getSystemVersion()` is available in a sandboxed preload (verified
// on Electron 43.2.0 / macOS 27: "27.0.0"). Only picks UI copy — the screen
// share picker's note about macOS's periodic "bypass the private window
// picker" consent (macOS 15+).
const MACOS_MAJOR: number | null = (() => {
    if (process.platform !== 'darwin') return null;
    try {
        const major = parseInt(String(process.getSystemVersion()).split('.')[0], 10);
        return Number.isFinite(major) && major > 0 ? major : null;
    } catch { return null; }
})();

// ── File-path cache ─────────────────────────────────────────────────────────
// Problem: when the renderer passes a File through contextBridge.exposeInMainWorld,
// the structured-clone loses the native OS file handle that webUtils needs.
// webUtils.getPathForFile(file) therefore returns '' for any File that came
// from the renderer via the context bridge.
//
// Fix: intercept file-input <change> and drag-and-drop <drop> events HERE in
// the preload using the capture phase — which fires BEFORE React's handlers.
// At that moment the File objects are still "native" (not bridge-cloned), so
// webUtils.getPathForFile() can extract the real disk paths.  We cache them
// keyed by (name + size + lastModified), the three primitive properties that
// survive the bridge transfer unchanged.
//
// When the renderer later calls window.electronAPI.getPathForFile(file), we
// look up the cache first, then fall back to the direct call (which may still
// work for files obtained without going through the bridge, e.g. in some
// Electron versions).
const _filePathCache = new Map<string, string>();

// Tell main a path is trustworthy for fs:encrypt-to-temp. Only called below
// with paths webUtils.getPathForFile() actually resolved from a native File
// handle — never with renderer-supplied strings — so a compromised renderer
// cannot use this channel to allowlist an arbitrary path (see main.ts's
// resolvedFilePaths for the other half of this check).
function _registerResolvedPath(p: string): void {
    try { ipcRenderer.send('fs:register-resolved-path', p); } catch { /* ignore */ }
}

function _cacheFile(file: File): void {
    try {
        const p = webUtils.getPathForFile(file);
        // Always log so the user can paste DevTools output if paths are still empty.
        console.log('[Preload] _cacheFile:', file.name, 'size:', file.size, '→ path:', p || '(empty)');
        if (p) {
            _filePathCache.set(`${file.name}|${file.size}|${file.lastModified}`, p);
            _registerResolvedPath(p);
        }
    } catch (err) {
        console.log('[Preload] _cacheFile error:', String(err));
    }
}

// Capture phase ensures we run before the renderer's React handlers.
window.addEventListener('change', (e: Event) => {
    try {
        const input = e.target as HTMLInputElement;
        console.log('[Preload] change event type:', input?.type, 'files:', input?.files?.length ?? 0);
        if (input?.type === 'file' && input.files) {
            for (let i = 0; i < input.files.length; i++) _cacheFile(input.files[i]);
        }
    } catch (err) {
        console.log('[Preload] change listener error:', String(err));
    }
}, true);

window.addEventListener('drop', (e: DragEvent) => {
    try {
        console.log('[Preload] drop event files:', e.dataTransfer?.files?.length ?? 0);
        if (e.dataTransfer?.files) {
            for (let i = 0; i < e.dataTransfer.files.length; i++) _cacheFile(e.dataTransfer.files[i]);
        }
    } catch (err) {
        console.log('[Preload] drop listener error:', String(err));
    }
}, true);

// ── Performance log: restore → first painted frame ─────────────────────────
// Main pings on every window restore/show; we answer after the renderer's
// next animation frame, so main can log how long the window took to actually
// paint again (the "minimized window won't open" symptom, measured). Lives
// here rather than in the app bundle so it works before React mounts and
// carries nothing but the ping's sequence number. Two rAFs: the first runs
// before the frame is produced, the second after it was.
ipcRenderer.on('perf:frame-ping', (_e, id: unknown) => {
    if (typeof id !== 'number') return;
    try {
        requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send('perf:frame-pong', id)));
    } catch { /* no DOM yet */ }
});

contextBridge.exposeInMainWorld('electronAPI', {
    // basic template for future IPC
    onReady: (callback: () => void) => ipcRenderer.on('ready', callback),
    getLocalIdentity: () => ipcRenderer.invoke('crypto:get-local-identity'),

    // Host platform ('windows' | 'mac' | 'linux') and machine name, resolved
    // synchronously in preload. Used to label devices in the pairing /
    // history-transfer flow and to gate platform-specific UI.
    platform: HOST_PLATFORM,
    macOSMajor: MACOS_MAJOR,
    getDeviceName: (): Promise<string> => ipcRenderer.invoke('app:get-device-name'),

    // Generate/load Signal identity and return the bundle for server upload.
    // `opts.unclaimedPrekeyIds` (GET /v1/keys/status) gates which held one-time
    // prekeys an EXISTING identity re-offers — see ensureSignalIdentity.
    ensureIdentityBundle: (deviceId: string, opts?: { unclaimedPrekeyIds?: number[] }) =>
        ipcRenderer.invoke('crypto:ensure-identity-bundle', deviceId, opts),

    // Generate a fresh rotation bundle (new SPK + 100 new OTPs) and return it.
    // Caller adds { device_id } and POSTs to /v1/keys/upload_bundle.
    // `rotateSpk` (default true) controls whether the SIGNED prekey is rotated
    // alongside the one-time prekeys. One-time prekeys are now spent per
    // message, so they need topping up far more often than the signed prekey
    // needs rotating — and rotating the SPK on every top-up would pile up
    // superseded private keys, each retained 35 days and tried on every
    // decrypt. See generateRotationBundle in signal-identity.ts.
    //
    // `unclaimedPrekeyIds` / `retiredPrekeyIds` come from GET /v1/keys/status
    // and are the CLIENT half of the one-time-prekey reuse fix: carry forward
    // only ids the server still lists as unclaimed, delete the privates the
    // server says are safe to forget, and — for ids in NEITHER list — keep the
    // private but stop offering the id. Omit them (a failed status call, an
    // older server) and the generator falls back to carrying what it holds and
    // deleting nothing. See generateRotationBundle for why conflating the two
    // lists would be a data-loss bug.
    //
    // `otpPoolLow` (boolean) = the status-aware mode: main mints only when the
    // pool is low, rotates the signed prekey only when its OWN clock agrees,
    // and answers null when nothing needs publishing.
    getRotationBundle: (opts?: {
        rotateSpk?: boolean;
        unclaimedPrekeyIds?: number[];
        retiredPrekeyIds?: number[];
        otpPoolLow?: boolean;
    }): Promise<{
        identity_key_pub_b64: string;
        registration_id: number;
        signed_prekey: { id: number; pub_b64: string; sig_b64: string };
        one_time_prekeys: { prekey_id: number; prekey_pub_b64: string }[];
    } | null> => ipcRenderer.invoke('keys:get-rotation-bundle', opts),

    // Lowest one-time-prekey id this device still holds a private for — the
    // `held_from` paging cursor for GET /v1/keys/status's retired_prekey_ids.
    // An integer or null; never key material.
    getLowestHeldOtpId: (): Promise<number | null> =>
        ipcRenderer.invoke('keys:lowest-held-otp-id'),

    // E2EE message encryption/decryption (runs in main process with Node crypto)
    // v:3: senderUserId is embedded inside the ciphertext (not sealed sender —
    // the server still records the sending device; see e2ee-engine.ts).
    // senderDeviceId is optional (RC-7 / Phase 5) — omit it and the wrapper
    // simply carries no `sd`, same as before this field existed.
    encryptMessage: (contentJson: string, senderUserId: string, devices: { device_id: string; spk_pub_b64: string; sig_b64?: string; identity_pub_b64?: string; otp_pub_b64?: string | null; otp_id?: number | null }[], senderDeviceId?: string) =>
        ipcRenderer.invoke('crypto:encrypt-message', contentJson, senderUserId, devices, senderDeviceId),
    // v2: also returns which devices actually got wrapped, so callers can
    // address recipient_device_ids to exactly that set (RC-2 fix).
    encryptMessageV2: (contentJson: string, senderUserId: string, devices: { device_id: string; spk_pub_b64: string; sig_b64?: string; identity_pub_b64?: string; otp_pub_b64?: string | null; otp_id?: number | null }[], senderDeviceId?: string): Promise<{ envelope_b64: string; wrapped_device_ids: string[] }> =>
        ipcRenderer.invoke('crypto:encrypt-message-v2', contentJson, senderUserId, devices, senderDeviceId),
    decryptMessage: (ciphertextB64: string, myDeviceId: string): Promise<{ contentJson: string; senderPub?: string; senderUserId?: string; senderDeviceId?: string; usedOneTimePrekey?: boolean }> =>
        ipcRenderer.invoke('crypto:decrypt-message', ciphertextB64, myDeviceId),
    getAvatarKey: (attachmentId: string) => ipcRenderer.invoke('secure:get-avatar-key', attachmentId),
    setAvatarKey: (attachmentId: string, keyB64: string, nonceB64: string) => ipcRenderer.invoke('secure:set-avatar-key', attachmentId, keyB64, nonceB64),
    // Availability of the device master key WITHOUT moving it across the
    // bridge — use this whenever the answer only gates UI.
    getLocalMasterKeyStatus: (): Promise<{ status: 'ok' | 'absent' | 'locked' }> =>
        ipcRenderer.invoke('secure:get-local-master-key-status'),
    // Encrypted key/value store. The master key stays in main: ciphertext goes
    // up, plaintext comes back, and vice versa. There is deliberately NO
    // channel here that returns the master key — see electron/kv-crypto.ts.
    secureKvOpen: (records: Array<{ k: string; o: string | null; b: Uint8Array }>): Promise<Array<{ k: string; v: string | null }>> =>
        ipcRenderer.invoke('securekv:open', records),
    secureKvSeal: (records: Array<{ k: string; o: string | null; v: string }>): Promise<Array<{ k: string; b: Uint8Array | null }>> =>
        ipcRenderer.invoke('securekv:seal', records),
    // A key SCOPED to the attachment/avatar blob cache — HKDF(master, "cl-blob-cache"),
    // not the master key. attachmentCache moves whole blobs (2 GiB cap), so the
    // bytes stay in the renderer and the key is narrowed instead. It opens the
    // blob cache and nothing else: not the key/value store, not the Signal
    // identity, not any backup container.
    getBlobCacheKey: (): Promise<{ status: 'ok'; keyB64: string } | { status: 'absent' } | { status: 'locked' }> =>
        ipcRenderer.invoke('secure:get-blob-cache-key'),
    // Recovery-key flows (export to a password manager; unlock a locked device).
    // Reveal is gated on a main-process confirmation dialog — see
    // electron/recovery-key-gate.ts. `declined` means the human said no (or a
    // decline is still in cooldown) and is NOT an error to surface as one;
    // `busy` means a confirmation is already on screen.
    revealRecoveryKey: (): Promise<
        { ok: true; keyB64: string } | { ok: false; reason: 'locked' | 'declined' | 'busy' }
    > => ipcRenderer.invoke('secure:reveal-recovery-key'),
    recoverWithKey: (keyB64: string): Promise<boolean> => ipcRenderer.invoke('secure:recover-with-key', keyB64),
    factoryResetSecureStore: (): Promise<boolean> => ipcRenderer.invoke('secure:factory-reset'),
    // Phase 7 / device sprawl: non-null when this session's Signal-identity
    // store was found corrupt and moved aside — see StorageCorruptedScreen.
    getSecureStoreCorruption: (): Promise<{ backupFileName: string } | null> =>
        ipcRenderer.invoke('secure:get-corruption-status'),
    // G8: how strongly the device master key is wrapped (Linux `basic_text`
    // is obfuscation, not encryption) + whether the one-time notice is due.
    getKeyProtection: (): Promise<{
        level: 'os_keystore' | 'obfuscated' | 'plaintext' | 'unknown';
        reason: 'backend' | 'legacy_wrap' | 'no_keystore' | null;
        backend: string | null;
        platform: string;
        showNotice: boolean;
    }> => ipcRenderer.invoke('secure:get-key-protection'),
    ackKeyProtectionNotice: (): Promise<boolean> => ipcRenderer.invoke('secure:ack-key-protection-notice'),

    // Backup / restore helpers — enumerate prefix-scoped secure-store entries
    // and read/write the on-disk GIF library so the encrypted vault can round-trip them.
    listAvatarKeys: (): Promise<Record<string, { keyB64: string; nonceB64: string }>> =>
        ipcRenderer.invoke('secure:list-avatar-keys'),
    listGifFiles: (): Promise<string[]> => ipcRenderer.invoke('fs:list-gif-files'),
    readGifFile: (id: string): Promise<Uint8Array> => ipcRenderer.invoke('fs:read-gif-file', id),
    writeGifFile: (id: string, data: Uint8Array): Promise<void> =>
        ipcRenderer.invoke('fs:write-gif-file', id, data),

    // Batch SecureStore ops. The main process accepts only the key names in
    // electron/secure-store-policy.ts — anything else is dropped, so these
    // cannot be used to reach identity keys, prekeys or channel keys.
    secureReplaceMany: (entries: Record<string, string>): Promise<boolean> =>
        ipcRenderer.invoke('secure:replace-many', entries),
    secureGetMany: (keys: string[]): Promise<Record<string, string | null>> =>
        ipcRenderer.invoke('secure:get-many', keys),
    secureDeleteMany: (keys: string[]): Promise<boolean> =>
        ipcRenderer.invoke('secure:delete-many', keys),

    // ── Notifications ──────────────────────────────────────────────────────────
    // Main process handles OS toast + badge; renderer decides what/when to fire.
    notifShow: (payload: {
        id: string; title: string; body: string; conv_id: string;
        hasReply?: boolean; replyPlaceholder?: string;
        /** Sender avatar as a small PNG data URL — validated in main (electron/notificationIcon.ts). */
        iconDataUrl?: string;
    }): Promise<void> => ipcRenderer.invoke('notif:show', payload),
    notifSetBadge: (count: number): Promise<void> =>
        ipcRenderer.invoke('notif:set-badge', count),
    notifFlashTaskbar: (): Promise<void> =>
        ipcRenderer.invoke('notif:flash-taskbar'),
    notifCloseAll: (): Promise<void> =>
        ipcRenderer.invoke('notif:close-all'),
    uploadCustomSound: (filename: string, data: Uint8Array): Promise<{ name: string; file: string }> =>
        ipcRenderer.invoke('fs:upload-custom-sound', filename, data),
    listCustomSounds: (): Promise<{ name: string; file: string }[]> =>
        ipcRenderer.invoke('fs:list-custom-sounds'),
    deleteCustomSound: (file: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('fs:delete-custom-sound', file),
    readCustomSound: (file: string): Promise<Uint8Array> =>
        ipcRenderer.invoke('fs:read-custom-sound', file),
    /** Subscribe to OS notification clicks. Returns an unsubscribe fn. */
    onNotificationClicked: (cb: (conv_id: string) => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, conv_id: string) => cb(conv_id);
        ipcRenderer.on('notification:clicked', wrapped);
        return () => ipcRenderer.removeListener('notification:clicked', wrapped);
    },
    /** Subscribe to inline toast reply events (macOS + Windows). Returns an unsubscribe fn. */
    onNotificationReplied: (cb: (data: { conv_id: string; text: string }) => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, data: { conv_id: string; text: string }) => cb(data);
        ipcRenderer.on('notification:replied', wrapped);
        return () => ipcRenderer.removeListener('notification:replied', wrapped);
    },
    /**
     * Tell main that the reply listener above is bound, draining any replies the
     * user submitted while it wasn't (e.g. across a renderer reload). Resolves
     * with how many were still queued. Call AFTER onNotificationReplied.
     */
    notifReplyReady: (): Promise<{ pending: number }> =>
        ipcRenderer.invoke('notif:reply-ready'),
    /** Push the current unread count + DND + status to main so the tray menu + badge stay in sync. */
    trayUpdateState: (state: { unreadCount: number; dndActive: boolean; dndManual: boolean; status: string; screenLockAvailable?: boolean }): Promise<void> =>
        ipcRenderer.invoke('tray:update-state', state),
    /** Push call + voice state (speaking/muted/deafened) so the tray icon shows the right indicator. */
    traySetCallSpeaking: (inCall: boolean, isSpeaking: boolean, isMuted: boolean, isDeafened: boolean): Promise<void> =>
        ipcRenderer.invoke('tray:call-speaking', inCall, isSpeaking, isMuted, isDeafened),
    onTraySetStatus: (cb: (status: 'online' | 'away' | 'dnd' | 'offline') => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, s: string) => cb(s as any);
        ipcRenderer.on('tray:set-status', wrapped);
        return () => ipcRenderer.removeListener('tray:set-status', wrapped);
    },
    onTrayToggleDnd: (cb: (enabled: boolean) => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, enabled: boolean) => cb(enabled);
        ipcRenderer.on('tray:toggle-dnd', wrapped);
        return () => ipcRenderer.removeListener('tray:toggle-dnd', wrapped);
    },
    /** Tray → renderer: the user picked "Lock". Only reachable when the
     *  renderer told the tray a Screen Lock PIN is configured. */
    onTrayLock: (cb: () => void): (() => void) => {
        ipcRenderer.on('tray:lock', cb);
        return () => ipcRenderer.removeListener('tray:lock', cb);
    },
    onTraySignOut: (cb: () => void): (() => void) => {
        ipcRenderer.on('tray:sign-out', cb);
        return () => ipcRenderer.removeListener('tray:sign-out', cb);
    },

    // Google Drive OAuth — link/unlink the user's Google account.
    // All token storage and refresh happens in the main process.
    gdriveAuthStart: (): Promise<{ email: string; name: string }> =>
        ipcRenderer.invoke('gdrive:auth-start'),
    gdriveAuthStatus: (): Promise<{ linked: boolean; email?: string; name?: string }> =>
        ipcRenderer.invoke('gdrive:auth-status'),
    gdriveDisconnect: (): Promise<void> =>
        ipcRenderer.invoke('gdrive:disconnect'),
    gdriveGetToken: (): Promise<string | null> =>
        ipcRenderer.invoke('gdrive:get-token'),

    // Screenshare overrides
    getDesktopSources: (types?: Array<'window' | 'screen'>, opts?: { thumbnails?: boolean }) =>
        ipcRenderer.invoke('desktop-capturer-get-sources', types, opts),
    resolveDesktopSource: (sourceId: string | null, withAudio?: boolean) => ipcRenderer.invoke('desktop-capturer-resolve', sourceId, withAudio),
    onShowScreensharePicker: (callback: () => void): (() => void) => {
        ipcRenderer.on('show-screenshare-picker', callback);
        return () => ipcRenderer.removeListener('show-screenshare-picker', callback);
    },
    // Desktop annotation overlay: strokes on your own screen share, drawn
    // over the real display (electron/annotation-overlay.ts). Resolves to the
    // show result: `{ ok, how, captured }` or `{ ok: false, reason }`.
    annotationOverlayShow: (sourceId: string): Promise<unknown> =>
        ipcRenderer.invoke('annot-overlay:show', sourceId),
    annotationOverlayHide: (): Promise<void> =>
        ipcRenderer.invoke('annot-overlay:hide'),
    annotationOverlayPush: (delta: unknown): void =>
        ipcRenderer.send('annot-overlay:delta', delta),

    /** macOS Screen Recording (TCC) status; 'not-applicable' on Windows/Linux. */
    getScreenCaptureAccess: (): Promise<string> =>
        ipcRenderer.invoke('screen-capture:get-access-status'),
    /** macOS only: open System Settings at Privacy & Security → Screen Recording.
     *  Takes no argument — the URL is a constant in the main process. */
    openScreenRecordingSettings: (): Promise<boolean> =>
        ipcRenderer.invoke('screen-capture:open-privacy-settings'),

    // Native per-app audio capture (Windows WASAPI ApplicationLoopback / macOS ScreenCaptureKit)
    getPidFromSourceId: (sourceId: string): Promise<number | null> =>
        ipcRenderer.invoke('audio:get-pid-from-source-id', sourceId),
    getOwnPid: (): Promise<number> =>
        ipcRenderer.invoke('audio:get-own-pid'),
    isAudioCaptureSupported: (): Promise<boolean> =>
        ipcRenderer.invoke('audio:is-capture-supported'),
    startWindowAudioCapture: (pid: number, mode: 'include' | 'exclude' = 'include'): Promise<boolean> =>
        ipcRenderer.invoke('audio:start-window-capture', pid, mode),
    stopWindowAudioCapture: (): Promise<void> =>
        ipcRenderer.invoke('audio:stop-window-capture'),
    onWindowAudioChunk: (
        callback: (chunk: { sampleRate: number; channels: number; data: ArrayBuffer }) => void
    ) => {
        ipcRenderer.removeAllListeners('audio:chunk');
        ipcRenderer.on('audio:chunk', (_event, chunk) => callback(chunk));
    },
    removeWindowAudioChunkListener: () => {
        ipcRenderer.removeAllListeners('audio:chunk');
    },
    // Reliability audit (Phase K): fires once when the native WASAPI addon
    // detects the captured process has exited mid-share — distinct from
    // silence (the process is gone, not just quiet). See audio_capture.cc's
    // IsProcessAlive.
    onWindowAudioProcessExited: (callback: () => void) => {
        ipcRenderer.removeAllListeners('audio:capture-process-exited');
        ipcRenderer.on('audio:capture-process-exited', () => callback());
    },
    removeWindowAudioProcessExitedListener: () => {
        ipcRenderer.removeAllListeners('audio:capture-process-exited');
    },
    // macOS ScreenCaptureKit: the capture could not start or was stopped
    // (reason: 'permission' = Screen Recording not granted, 'no-target',
    // 'stopped' = the system "Stop sharing" control, 'unsupported', 'error').
    onWindowAudioFailed: (callback: (info: { reason: string }) => void) => {
        ipcRenderer.removeAllListeners('audio:capture-failed');
        ipcRenderer.on('audio:capture-failed', (_event, info) => callback({ reason: String(info?.reason ?? 'error') }));
    },
    removeWindowAudioFailedListener: () => {
        ipcRenderer.removeAllListeners('audio:capture-failed');
    },

    // Display refresh rates — the hard ceiling on screen-share frame rate.
    getDisplayRefreshRates: (): Promise<Array<{ id: string; displayFrequency: number; isPrimary: boolean }>> =>
        ipcRenderer.invoke('display:get-refresh-rates'),

    // Stream-stats overlay: what the OS/Chromium side of a screen share looks
    // like (captured display's Hz, expected capturer, GPUs, HW-encode status),
    // and — when the capture timing log is on — Chromium's own per-frame
    // capture timing. Both read-only. Shapes: src/env.d.ts.
    getScreenShareDiagnostics: (sourceId: string): Promise<unknown> =>
        ipcRenderer.invoke('screenshare:get-diagnostics', sourceId),
    getScreenCaptureTiming: (): Promise<unknown> =>
        ipcRenderer.invoke('screenshare:get-capture-timing'),
    // In-call performance helper: { renderer, gpu } CPU % of one core.
    getProcessCpu: (): Promise<unknown> =>
        ipcRenderer.invoke('perf:get-process-cpu'),
    // Settings → Advanced → screen capture method / capture timing log.
    // Stored by main in <userData>/startup-flags.json and applied as Chromium
    // switches on the NEXT launch (electron/startup-flags.ts). Replies are
    // `unknown` on purpose — src/utils/startupFlags.ts narrows them.
    getStartupFlags: (): Promise<unknown> => ipcRenderer.invoke('app:get-startup-flags'),
    setStartupFlags: (patch: { screenCapturer?: 'auto' | 'dxgi' | 'wgc'; captureLog?: boolean; gamingVideo?: boolean }): Promise<unknown> =>
        ipcRenderer.invoke('app:set-startup-flags', patch),
    // "Prioritize call video while gaming": tells main a call started/ended so
    // it can raise / restore process priority (electron/gaming-video-mode.ts).
    // Main rejects anything but a boolean.
    setCallMediaActive: (active: boolean): Promise<void> =>
        ipcRenderer.invoke('call:set-media-active', active),
    relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),

    // System idle detection (for presence auto-away, and Screen Lock's inactivity timeout)
    getSystemIdleTime: (): Promise<number> => ipcRenderer.invoke('system:get-idle-time'),
    // Freeze diagnostic (Settings → Advanced → Performance log). Rows carry a
    // timestamp, a duration and static activity labels only.
    perfRecord: (rows: Array<{ at: number; ms: number; activity: string }>): Promise<number> =>
        ipcRenderer.invoke('perf:record', rows),
    perfGetLog: (): Promise<Array<{ at: number; source: 'main' | 'renderer'; ms: number; activity: string }>> =>
        ipcRenderer.invoke('perf:get-log'),
    perfClear: (): Promise<void> => ipcRenderer.invoke('perf:clear'),
    /** "Run a 60-second freeze capture": main lowers its stall threshold to
     *  100 ms and samples process CPU/memory every 2 s for `ms`. */
    perfStartCapture: (ms?: number): Promise<void> => ipcRenderer.invoke('perf:start-capture', ms),

    // Crash / issue reporter (electron/diagnostics.ts). Replies are `unknown`
    // on purpose — src/utils/diagnostics/ipc.ts narrows every field.
    diagGetSystemInfo: (): Promise<unknown> => ipcRenderer.invoke('diag:get-system-info'),
    diagGetPendingCrashes: (): Promise<unknown> => ipcRenderer.invoke('diag:get-pending-crashes'),
    diagClearPendingCrashes: (signatures?: string[]): Promise<void> => ipcRenderer.invoke('diag:clear-pending-crashes', signatures),
    diagMarkCrashesSeen: (signatures?: string[]): Promise<void> => ipcRenderer.invoke('diag:mark-crashes-seen', signatures),
    diagRecordRendererCrash: (payload: { name?: string; message?: string; stack?: string }): Promise<void> =>
        ipcRenderer.invoke('diag:record-renderer-crash', payload),
    /** Main shows the save dialog; only the report TEXT crosses the bridge. */
    diagSaveReport: (category: string, json: string): Promise<{ status: 'saved' | 'cancelled' }> =>
        ipcRenderer.invoke('diag:save-report', category, json),

    // Screen Lock: fired when the OS locks its screen or the machine suspends
    // (Windows + macOS reliably; Linux best-effort via suspend only).
    onOsLockScreen: (callback: () => void): (() => void) => {
        const wrapped = () => callback();
        ipcRenderer.on('os-lock-screen', wrapped);
        return () => ipcRenderer.removeListener('os-lock-screen', wrapped);
    },

    // Wake counterpart to onOsLockScreen — fires on resume-from-sleep and on
    // screen-unlock-without-suspend. Consumed by useRealtime.ts to force an
    // immediate WebSocket reconnect rather than waiting for the liveness
    // watchdog to notice the socket died silently across the sleep.
    onOsResume: (callback: () => void): (() => void) => {
        const wrapped = () => callback();
        ipcRenderer.on('os-resume', wrapped);
        return () => ipcRenderer.removeListener('os-resume', wrapped);
    },

    // Filesystem & dialogs (for backup/restore)
    // Combined: shows OS save-dialog then writes the file entirely in the main
    // process.  Safer than showSaveDialog + writeFile separately because the
    // chosen path never needs to pass assertInsideUserData.
    saveFileAs: (opts: any, data: Uint8Array): Promise<{ canceled: boolean; filePath?: string; size?: number }> =>
        ipcRenderer.invoke('fs:save-file-as', opts, data),
    showSaveDialog: (opts: any): Promise<any> => ipcRenderer.invoke('dialog:save', opts),
    showOpenDialog: (opts: any): Promise<any> => ipcRenderer.invoke('dialog:open', opts),
    writeFile: (filePath: string, data: Uint8Array): Promise<{ ok: boolean; size: number }> =>
        ipcRenderer.invoke('fs:write-file', filePath, data),
    writeBackupFile: (dir: string, filename: string, data: Uint8Array): Promise<{ ok: boolean; path: string; size: number }> =>
        ipcRenderer.invoke('fs:write-backup-file', dir, filename, data),
    readFile: (filePath: string): Promise<ArrayBuffer> =>
        ipcRenderer.invoke('fs:read-file', filePath),
    readDir: (dirPath: string): Promise<string[]> =>
        ipcRenderer.invoke('fs:read-dir', dirPath),
    deleteFile: (filePath: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('fs:unlink', filePath),
    registerDir: (dirPath: string): Promise<{ ok: boolean }> =>
        ipcRenderer.invoke('fs:register-dir', dirPath),

    // Streamed single-file backup writer (see backupContainer.ts / driveBackup.ts).
    // The renderer encrypts records and appends them through a session; commit
    // fsyncs and atomically renames the temp file over the final `.enc`, so a
    // crash mid-write can never leave a half-written backup as the only copy.
    // mode 'fresh' (default) writes `<name>.partial` and renames on commit;
    // 'update' opens the existing file for in-place append + pointer patch.
    backupBeginWrite: (dir: string, filename: string, mode: 'fresh' | 'update' = 'fresh'): Promise<{ sessionId: string; size: number }> =>
        ipcRenderer.invoke('backup:begin-write', dir, filename, mode),
    backupAppend: (sessionId: string, data: Uint8Array): Promise<void> =>
        ipcRenderer.invoke('backup:append', sessionId, data),
    backupWriteAt: (sessionId: string, offset: number, data: Uint8Array): Promise<void> =>
        ipcRenderer.invoke('backup:write-at', sessionId, offset, data),
    backupCommit: (sessionId: string): Promise<{ path: string; size: number }> =>
        ipcRenderer.invoke('backup:commit', sessionId),
    backupAbort: (sessionId: string): Promise<void> =>
        ipcRenderer.invoke('backup:abort', sessionId),
    // Random-access reads for restore — a backup can be hundreds of MB, and
    // the container format only needs the index + the records being applied.
    backupStat: (filePath: string): Promise<{ size: number; mtimeMs: number } | null> =>
        ipcRenderer.invoke('backup:stat', filePath),
    backupReadRange: (filePath: string, offset: number, length: number): Promise<ArrayBuffer> =>
        ipcRenderer.invoke('backup:read-range', filePath, offset, length),
    /** Scratch directory (under userData) where the Drive copy is staged
     *  before upload / after download. */
    backupStagingDir: (): Promise<string> =>
        ipcRenderer.invoke('backup:staging-dir'),
    // Drive transfers run in the main process (resumable, streamed from
    // disk, checksum-verified) — see electron/driveTransfer.ts.
    gdriveUploadFile: (folderId: string, fileName: string, filePath: string): Promise<{ id: string; size: number; md5Checksum: string }> =>
        ipcRenderer.invoke('gdrive:upload-file', folderId, fileName, filePath),
    gdriveDownloadFile: (fileId: string, fileName: string): Promise<{ path: string; size: number }> =>
        ipcRenderer.invoke('gdrive:download-file', fileId, fileName),
    onGdriveTransferProgress: (cb: (p: { kind: 'upload' | 'download'; done: number; total: number }) => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, p: { kind: 'upload' | 'download'; done: number; total: number }) => cb(p);
        ipcRenderer.on('gdrive:transfer-progress', wrapped);
        return () => ipcRenderer.removeListener('gdrive:transfer-progress', wrapped);
    },
    getUserDataPath: (): Promise<string> =>
        ipcRenderer.invoke('app:get-user-data-path'),

    // Fetch a remote URL through the main process, bypassing renderer CORS/hotlink restrictions.
    // Returns { b64: string, mimeType: string }.
    fetchBinary: (url: string): Promise<{ b64: string; mimeType: string }> =>
        ipcRenderer.invoke('net:fetch-binary', url),

    // Open URL in the system default browser (validated http/https only).
    openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),

    // Global keyboard shortcuts (controls that work even when Cipherline is not focused).
    // map: { accelerator: actionId } — synced whenever keybinds change. Returns
    // the action ids whose global registration failed (e.g. unsupported under
    // Wayland) so the renderer can fall back to a focused-window listener.
    syncGlobalShortcuts: (map: Record<string, string>): Promise<{ failed: string[] }> =>
        ipcRenderer.invoke('keybinds:sync-global-shortcuts', map),
    // Fired from main process when a global shortcut is pressed.
    onGlobalShortcut: (callback: (actionId: string) => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, actionId: string) => callback(actionId);
        ipcRenderer.on('global-shortcut-fired', wrapped);
        return () => ipcRenderer.removeListener('global-shortcut-fired', wrapped);
    },

    // Custom window controls (Windows / Linux)
    minimizeWindow: () => ipcRenderer.send('win:minimize'),
    maximizeWindow: () => ipcRenderer.send('win:maximize'),
    closeWindow: () => ipcRenderer.send('win:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('win:is-maximized'),
    onMaximizeChange: (callback: (maximized: boolean) => void): (() => void) => {
        const wrapped = (_e: Electron.IpcRendererEvent, val: boolean) => callback(val);
        ipcRenderer.on('win:maximized', wrapped);
        return () => ipcRenderer.removeListener('win:maximized', wrapped);
    },
    // Privacy: screen-capture protection toggle. When enabled, the window
    // appears blank in OS screenshots and (where supported) screen recordings.
    setContentProtection: (enabled: boolean) =>
        ipcRenderer.send('win:set-content-protection', enabled),

    // Game detection — notifies renderer when a game is started/stopped.
    // Returns an unsubscribe function. processName is the matched executable
    // name — what settings' ignore list operates on (Settings ▸ Game Activity
    // needs it to offer "ignore what's currently detected").
    onGameDetected: (cb: (data: { name: string; processName: string }) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, data: { name: string; processName: string }) => cb(data);
        ipcRenderer.on('game:detected', listener);
        return () => ipcRenderer.removeListener('game:detected', listener);
    },
    onGameStopped: (cb: () => void): (() => void) => {
        const listener = () => cb();
        ipcRenderer.on('game:stopped', listener);
        return () => ipcRenderer.removeListener('game:stopped', listener);
    },
    getCurrentGame: (): Promise<{ name: string; processName: string } | null> => ipcRenderer.invoke('game:get-current'),

    // Game settings — custom games, ignored processes, and running process list
    getRunningProcesses: (): Promise<string[]> => ipcRenderer.invoke('game:get-processes'),
    setCustomGames: (games: { processName: string; displayName: string }[]) =>
        ipcRenderer.send('game:set-custom-games', games),
    setIgnoredProcesses: (ignored: string[]) =>
        ipcRenderer.send('game:set-ignored', ignored),
    /** Settings → Game activity. Off stops the background process scan in
     *  main entirely; getCurrentGame() still answers on demand. */
    setGameDetectionEnabled: (enabled: boolean) =>
        ipcRenderer.send('game:set-enabled', enabled === true),

    // ── Sender Keys — channel message crypto ─────────────────────────────────
    // All crypto runs in the main process where Node.js's crypto module is
    // available. Channel keys are stored in SecureStore (DPAPI / Keychain).

    /** Encrypt a JSON content string for the current epoch of a text channel. */
    // `sender` (this device's own ids) is bound into the ciphertext (G4).
    encryptChannelMessage: (contentJson: string, channelId: string, sender?: { user_id?: string | null; device_id?: string | null }): Promise<{
        epoch: number;
        nonce_b64: string;
        ciphertext_b64: string;
        signature_b64: string;
    }> => ipcRenderer.invoke('channel:encrypt-message', contentJson, channelId, sender),

    /** Decrypt a channel message; verifies the sender Ed25519 signature first. */
    decryptChannelMessage: (params: {
        channel_id: string;
        epoch: number;
        nonce_b64: string;
        ciphertext_b64: string;
        signature_b64: string;
        sender_identity_pub_b64: string;
        // G4: the server row's own labels, checked against the bound context
        // and (message_id) fed to the replay ledger.
        message_id?: string | null;
        sender_user_id?: string | null;
        sender_device_id?: string | null;
    }): Promise<string> => ipcRenderer.invoke('channel:decrypt-message', params),

    /**
     * Store a channel key received via a `channel_key` per-recipient envelope.
     * Call this when the renderer decrypts a `channel_key` ClientContent.
     * `replaceIfFingerprintB64` is set only during split-brain repair: pass
     * the server-arbitrated winning fingerprint to allow replacing a locally
     * conflicting key for the same epoch. Returns which of 'stored' |
     * 'duplicate' | 'conflict' happened so the caller can react.
     */
    setChannelKey: (channelId: string, epoch: number, keyB64: string, rotatesAt: string, replaceIfFingerprintB64?: string): Promise<'stored' | 'duplicate' | 'conflict'> =>
        ipcRenderer.invoke('channel:set-key', channelId, epoch, keyB64, rotatesAt, replaceIfFingerprintB64),

    /** Returns the highest epoch we have a key for, or null if no key yet. */
    getLatestChannelEpoch: (channelId: string): Promise<number | null> =>
        ipcRenderer.invoke('channel:get-latest-epoch', channelId),

    /** All epoch numbers we hold for this channel (ascending; [] if none).
     *  Used to back-fill FULL history to keyless members, not just latest. */
    listChannelEpochs: (channelId: string): Promise<number[]> =>
        ipcRenderer.invoke('channel:list-epochs', channelId),

    /** RC-10 / Phase 6: tell the main process which epochs a pin references
     *  for this channel, so pruneOldKeys never drops the only local copy of
     *  a key a pinned message needs. Wholesale-replaces the set each call. */
    setProtectedEpochs: (channelId: string, epochs: number[]): Promise<void> =>
        ipcRenderer.invoke('channel:set-protected-epochs', channelId, epochs),

    /**
     * Retrieve a stored channel key as a base64 string (for distribution to
     * a newly joined member). Returns null if the key is not in local storage.
     */
    getChannelKey: (channelId: string, epoch: number): Promise<string | null> =>
        ipcRenderer.invoke('channel:get-key', channelId, epoch),

    /**
     * SHA-256 fingerprint (base64) of the key held for this epoch, or null.
     * Compared against the server's arbitrated fingerprint to detect a
     * split-brain divergence (two devices minted different keys for the
     * same epoch).
     */
    getChannelKeyFingerprint: (channelId: string, epoch: number): Promise<string | null> =>
        ipcRenderer.invoke('channel:get-fingerprint', channelId, epoch),

    /** epoch → fingerprint for every epoch this device holds. */
    listChannelEpochFingerprints: (channelId: string): Promise<Record<number, string>> =>
        ipcRenderer.invoke('channel:list-fingerprints', channelId),

    /**
     * Discard a locally held epoch key — used by split-brain repair when this
     * device lost the server-side arbitration race for that epoch.
     */
    discardChannelKey: (channelId: string, epoch: number): Promise<void> =>
        ipcRenderer.invoke('channel:discard-key', channelId, epoch),

    /**
     * Generate a new channel key epoch (for the rotation actor — typically the
     * admin/owner, the create-time minter, or fallback recovery rotation).
     * Returns the new key so it can be distributed to members via
     * per-recipient envelopes before the old epoch is retired.
     * @param atEpoch Explicit target epoch — used only by fallback recovery
     *   rotation to mint at a specific server-known epoch number.
     */
    rotateChannelKey: (channelId: string, atEpoch?: number): Promise<{
        epoch: number;
        keyB64: string;
        rotatesAt: string;
    }> => ipcRenderer.invoke('channel:rotate-key', channelId, atEpoch),

    // Auto-updater — full lifecycle (idle/available/downloading/ready/manual).
    // See electron/updater-state.ts for what each phase means and why 'manual'
    // exists (macOS/Linux can't always self-install). onUpdateState fires on
    // every transition; getUpdateState covers a renderer that mounted after an
    // earlier transition already happened (same cold-start problem deep links
    // solve below).
    /** The OS woke from sleep (or the screen unlocked). The renderer uses this
     *  to rebuild its WebSocket and re-hydrate, rather than waiting for the
     *  heartbeat-ack timeout to work out that the socket died during suspend. */
    onAppResumed: (cb: () => void): (() => void) => {
        const listener = () => cb();
        ipcRenderer.on('app:resumed', listener);
        return () => ipcRenderer.removeListener('app:resumed', listener);
    },
    /** ONE event per wake episode (see electron/power-events.ts), sent
     *  RESUME_NOTIFY_DELAY_MS after the OS signal so it is not stacked on the
     *  OS's own resume burst. `resume` then `unlock-screen` within a minute is
     *  a single event (reason 'resume+unlock'). Durations only, no ids. */
    onPowerResumed: (cb: (p: {
        reason: 'resume' | 'unlock' | 'resume+unlock' | 'clock-jump';
        asleepMs: number | null;
        lockedMs: number | null;
        at: number;
    }) => void): (() => void) => {
        const listener = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
        ipcRenderer.on('power:resumed', listener);
        return () => ipcRenderer.removeListener('power:resumed', listener);
    },
    /** The main window came back from minimized or hidden (tray), once per
     *  restore (the restore/show/focus burst is coalesced). */
    onWindowRestored: (cb: (p: { from: 'minimized' | 'hidden'; hiddenMs: number | null; at: number }) => void): (() => void) => {
        const listener = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
        ipcRenderer.on('window:restored', listener);
        return () => ipcRenderer.removeListener('window:restored', listener);
    },
    onUpdateState: (cb: (state: UpdateState) => void): (() => void) => {
        const listener = (_e: unknown, state: UpdateState) => cb(state);
        ipcRenderer.on('update:state', listener);
        return () => ipcRenderer.removeListener('update:state', listener);
    },
    getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('updater:get-state'),
    quitAndInstall: (): Promise<void> => ipcRenderer.invoke('updater:quit-and-install'),
    /** Force an update check now — the "Check for updates" control in
     *  Settings → Advanced. Resolves true when a real check was dispatched,
     *  false in a build with no updater to ask (dev server / smoke test).
     *  Rejects if the check itself fails, so the caller can show an error
     *  rather than a misleading "you're up to date". The RESULT of the check
     *  arrives on the existing `update:state` stream above, not here —
     *  checkForUpdates() resolves either way and can't tell them apart. */
    checkForUpdatesNow: (): Promise<boolean> => ipcRenderer.invoke('updater:check-now'),
    // For the 'manual' phase's download link, reuse the openExternal exposed
    // above (net:fetch-binary section) rather than adding a second path to
    // the same https-only shell:open-external gate (L2).
    // Channel selection — read/persist which update stream this client
    // follows. 'latest' is what real users get; 'staging' is opt-in pre-
    // release builds. See Settings → Advanced for the UI.
    getUpdateChannel: (): Promise<'latest' | 'staging'> =>
        ipcRenderer.invoke('updater:get-channel'),
    setUpdateChannel: (channel: 'latest' | 'staging'): Promise<'latest' | 'staging'> =>
        ipcRenderer.invoke('updater:set-channel', channel),
    // Staging lock — main owns the state and verifies the password (see
    // electron/staging-lock.ts). setUpdateChannel('staging') rejects with an
    // error whose message contains STAGING_LOCKED while this device is locked.
    getStagingLockStatus: (): Promise<StagingLockStatus> =>
        ipcRenderer.invoke('staging-lock:status'),
    unlockStaging: (password: string): Promise<StagingUnlockResult> =>
        ipcRenderer.invoke('staging-lock:unlock', password),
    relockStaging: (): Promise<StagingLockStatus> =>
        ipcRenderer.invoke('staging-lock:relock'),

    // ── Deep-link invite handling ─────────────────────────────────────────────
    // Called by App.tsx on mount. Returns an unsubscribe function.
    // When the user opens a cipherline://invite/<CODE> URL (via the web landing
    // page or a shared link), main sends 'deep-link:invite' with the code.
    onDeepLinkInvite: (cb: (code: string) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, code: string) => cb(code);
        ipcRenderer.on('deep-link:invite', listener);
        return () => ipcRenderer.removeListener('deep-link:invite', listener);
    },

    // Pull-based companion to onDeepLinkInvite.  Handles the cold-start race:
    // if the protocol URL arrived before React mounted and registered the push
    // listener, the code is stored in main-process state so the renderer can
    // fetch it synchronously on startup.  Clears the stored code on first read.
    getPendingDeepLinkCode: (): Promise<string | null> =>
        ipcRenderer.invoke('deep-link:get-pending'),

    // ── Referral deep-link (cipherline://ref/CODE) ───────────────────────────
    // Mirrors the invite-code pattern above but for referral codes, which
    // pre-fill the register form's referral code field.
    onDeepLinkRef: (cb: (code: string) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, code: string) => cb(code);
        ipcRenderer.on('deep-link:ref', listener);
        return () => ipcRenderer.removeListener('deep-link:ref', listener);
    },
    getPendingDeepLinkRef: (): Promise<string | null> =>
        ipcRenderer.invoke('deep-link:get-pending-ref'),

    // ── Install hand-off (first launch only) ─────────────────────────────────
    // Resolves to `{ kind: 'ref' | 'invite', code }` when the clipboard holds
    // exactly one of our own landing-page links, else null. Never returns raw
    // clipboard text. The renderer calls it at most once per install and asks
    // the person before using the result (src/utils/signupAttribution.ts).
    peekAttributionClipboard: (): Promise<{ kind: 'ref' | 'invite'; code: string } | null> =>
        ipcRenderer.invoke('attribution:peek-clipboard'),

    // ── File path resolution (Electron 32+) ──────────────────────────────────
    // File.path was removed from the renderer in Electron 32 for security.
    // webUtils.getPathForFile() is the official replacement; it runs in the
    // preload (Node context) and returns '' for in-memory / clipboard files.
    getPathForFile: (file: File): string => {
        // Check the pre-populated cache first (populated by the capture-phase
        // event listeners above, while the File was still a native OS handle).
        const cached = _filePathCache.get(`${file.name}|${file.size}|${file.lastModified}`);
        if (cached) return cached;
        // Direct call as fallback — works if the File was NOT transferred via
        // contextBridge (e.g. called from a preload-side helper in future).
        try {
            const p = webUtils.getPathForFile(file);
            if (p) _registerResolvedPath(p);
            return p;
        } catch { return ''; }
    },

    // ── Large-file streaming upload ───────────────────────────────────────────
    // For files > 200 MB the renderer cannot safely load the full plaintext +
    // ciphertext into the V8 heap (NotReadableError at ~2 GB+). These APIs
    // route encryption and upload through the main process instead.

    /** Stream-encrypt a file from disk to a temp path using Node.js crypto.
     *  Produces the same [IV ‖ ciphertext ‖ auth-tag] format as encryptBlob.
     *  Caller must delete the temp file when done (via deleteFile). */
    encryptFileToTemp: (filePath: string): Promise<{
        tempPath: string;
        keyB64: string;
        ivB64: string;
        encryptedSize: number;
    }> => ipcRenderer.invoke('fs:encrypt-to-temp', filePath),

    /** Stream a local file to a presigned PUT URL from the main process.
     *  Subscribe to onUploadProgress for progress events before calling. */
    streamUpload: (params: {
        url: string;
        filePath: string;
        contentType: string;
        size: number;
    }): Promise<void> => ipcRenderer.invoke('net:stream-upload', params),

    /** Subscribe to upload-progress events fired by streamUpload.
     *  Returns an unsubscribe function — call it when the upload completes. */
    onUploadProgress: (cb: (progress: { uploaded: number; total: number }) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, progress: { uploaded: number; total: number }) => cb(progress);
        ipcRenderer.on('net:upload-progress', listener);
        return () => ipcRenderer.removeListener('net:upload-progress', listener);
    },

    /** Subscribe to encryption-progress events fired by encryptFileToTemp.
     *  Returns an unsubscribe function — call it after encryptFileToTemp resolves. */
    onEncryptProgress: (cb: (progress: { encrypted: number; total: number }) => void): (() => void) => {
        const listener = (_event: Electron.IpcRendererEvent, progress: { encrypted: number; total: number }) => cb(progress);
        ipcRenderer.on('net:encrypt-progress', listener);
        return () => ipcRenderer.removeListener('net:encrypt-progress', listener);
    },

    // ── Chunk-based streaming encryption ─────────────────────────────────────
    // The renderer reads the File in 16 MB slices (File.slice().arrayBuffer()) and
    // streams each chunk here for AES-256-GCM encryption in the main process.
    // Replaces getPathForFile + encryptFileToTemp — no file-path dependency,
    // works for any file size without risking V8 heap exhaustion.

    /** Open a new encryption session. Returns a sessionId to pass to subsequent calls. */
    chunkEncryptBegin: (): Promise<{ sessionId: string }> =>
        ipcRenderer.invoke('crypto:chunk-encrypt-begin'),

    /** Encrypt and write the next chunk. Call repeatedly for each 16 MB slice. */
    chunkEncryptWrite: (sessionId: string, chunk: Uint8Array): Promise<void> =>
        ipcRenderer.invoke('crypto:chunk-encrypt-write', sessionId, chunk),

    /** Finalise the cipher, flush the temp file, and return key material + path. */
    chunkEncryptEnd: (sessionId: string): Promise<{
        tempPath: string; keyB64: string; ivB64: string; encryptedSize: number;
    }> => ipcRenderer.invoke('crypto:chunk-encrypt-end', sessionId),

    /** Abort and clean up a session after an error. Safe to call even if end was called. */
    chunkEncryptAbort: (sessionId: string): Promise<void> =>
        ipcRenderer.invoke('crypto:chunk-encrypt-abort', sessionId),

    // ── System behavior settings ──────────────────────────────────────────────
    // These are persisted on the main-process side (OS login items / secureStore).
    // The renderer reads on mount and writes on toggle — no server involvement.
    getStartWithWindows: (): Promise<boolean> => ipcRenderer.invoke('app:get-start-with-windows'),
    setStartWithWindows: (enabled: boolean): Promise<void> => ipcRenderer.invoke('app:set-start-with-windows', enabled),
    getStartMinimized: (): Promise<boolean> => ipcRenderer.invoke('app:get-start-minimized'),
    setStartMinimized: (enabled: boolean): Promise<void> => ipcRenderer.invoke('app:set-start-minimized', enabled),
    getMinimizeToTray: (): Promise<boolean> => ipcRenderer.invoke('app:get-minimize-to-tray'),
    setMinimizeToTray: (enabled: boolean): Promise<void> => ipcRenderer.invoke('app:set-minimize-to-tray', enabled),

    // Read plain-text clipboard content via the main process.
    // navigator.clipboard.readText() in the renderer requires a user-gesture
    // permission that isn't reliable in Electron (fails silently on window
    // focus events). The main-process clipboard module has no such restriction.
    readClipboard: (): Promise<string> => ipcRenderer.invoke('clipboard:read'),
    writeClipboard: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),
    // Sign an official-build attestation token (null in dev/forks without a secret).
    attestSign: (): Promise<string | null> => ipcRenderer.invoke('attest:sign'),
    // Solve a registration proof-of-work challenge (null if disabled/no solution).
    solvePow: (challenge: string, difficulty: number): Promise<string | null> =>
        ipcRenderer.invoke('pow:solve', challenge, difficulty),
    // Prove possession of this device's Signal identity key for registration.
    getDeviceRegisterProof: (userId: string, proofTs: number): Promise<{ identityPub: string; sig: string } | null> =>
        ipcRenderer.invoke('crypto:device-register-proof', userId, proofTs),
    // C-2b: sign this device's history-sync capability advertisement with the
    // identity key, so the approver can distinguish it from a flag the relaying
    // server flipped. null when the identity is unavailable — the caller must
    // then abandon the request, never send it unsigned.
    getHistoryRequestProof: (userId: string, requestingDeviceId: string, ts: number): Promise<{ identityPub: string; sig: string } | null> =>
        ipcRenderer.invoke('crypto:history-request-proof', userId, requestingDeviceId, ts),

    // ── QR sign-in (link) — see electron/link-grant.ts for the full design.
    // The ephemeral private key never crosses this bridge in either direction;
    // these calls only ever move the PUBLIC key, a fingerprint, and (once
    // opened) the grant itself.
    // Mint the ephemeral keypair. Pass '' to mint before the server-issued
    // link_id is known (see main.ts's 'link:begin' handler for why), then bind
    // it with linkBind once the POST that creates it returns.
    linkBegin: (linkId: string): Promise<{ ekPubB64: string; fingerprint: string }> =>
        ipcRenderer.invoke('link:begin', linkId),
    linkBind: (linkId: string): Promise<void> => ipcRenderer.invoke('link:bind', linkId),
    // Opens the sealed grant for the in-progress session; rejects on ANY
    // failure (bad envelope, wrong key, tampered ciphertext, mismatched link
    // id) with no fallback path.
    linkOpen: (envelopeB64: string, linkId: string): Promise<LinkGrantPayload> =>
        ipcRenderer.invoke('link:open', envelopeB64, linkId),
    linkEnd: (): Promise<void> => ipcRenderer.invoke('link:end'),
    // The mirror role: THIS desktop is the signed-in device approving a phone
    // that scanned its invite QR. Seals the (token-free, v2) grant to the
    // phone's ephemeral public key. No key material of ours is involved — the
    // seal mints and discards its own one-shot X25519 pair in main.
    linkSeal: (payload: LinkGrantPayload, ekPubB64: string, linkId: string): Promise<string> =>
        ipcRenderer.invoke('link:seal', payload, ekPubB64, linkId),

    // Fires when the OS-level BrowserWindow gains focus (user switches back
    // from another app). More reliable than window 'focus' in the renderer.
    onWindowFocus: (cb: () => void): (() => void) => {
        ipcRenderer.on('window:focus', cb);
        return () => ipcRenderer.removeListener('window:focus', cb);
    },

    // Continuity (cross-device attention routing) — the immediate,
    // off-cycle "definitely not attentive" signals useRealtime.ts sends a
    // presence:heartbeat{active:false} on. See main.ts's 'blur'/'minimize'
    // BrowserWindow listeners for why these are pushed from main rather than
    // relying solely on the renderer's own window 'blur' DOM event.
    onWindowBlur: (cb: () => void): (() => void) => {
        ipcRenderer.on('window:blur', cb);
        return () => ipcRenderer.removeListener('window:blur', cb);
    },
    onWindowMinimize: (cb: () => void): (() => void) => {
        ipcRenderer.on('window:minimize', cb);
        return () => ipcRenderer.removeListener('window:minimize', cb);
    },
    onWindowHide: (cb: () => void): (() => void) => {
        ipcRenderer.on('window:hide', cb);
        return () => ipcRenderer.removeListener('window:hide', cb);
    },
    // Fires from app.on('before-quit') — best-effort last chance to report
    // active:false before the socket dies with the process. See main.ts.
    onBeforeQuit: (cb: () => void): (() => void) => {
        ipcRenderer.on('app:before-quit', cb);
        return () => ipcRenderer.removeListener('app:before-quit', cb);
    },

    // Reliability audit (Phase J): the renderer's main thread has stopped
    // responding to input (frozen UI). This does NOT mean the call/audio is
    // dead — audio worklets run on their own real-time thread — so this is
    // surfaced as an informational banner with an opt-in reload, never an
    // auto-kill.
    onRendererUnresponsive: (cb: () => void): (() => void) => {
        ipcRenderer.on('main:renderer-unresponsive', cb);
        return () => ipcRenderer.removeListener('main:renderer-unresponsive', cb);
    },
    onRendererResponsive: (cb: () => void): (() => void) => {
        ipcRenderer.on('main:renderer-responsive', cb);
        return () => ipcRenderer.removeListener('main:renderer-responsive', cb);
    },
});
