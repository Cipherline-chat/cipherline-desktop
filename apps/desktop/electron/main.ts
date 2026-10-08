import { app, BrowserWindow, ipcMain, desktopCapturer, session, dialog, powerMonitor, shell, globalShortcut, safeStorage, Menu, MenuItem, clipboard, systemPreferences, screen } from 'electron';
import * as http from 'http';
import * as https from 'https';
import { assertPublicHttpUrl, pinnedLookup } from './net-guard';
import type { AppUpdater } from 'electron-updater';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as nodeCrypto from 'crypto';
import { getLocalIdentityPub, migrateSpkPubIfMissing, ensureSignalIdentity, signIdentityMessage, generateRotationBundle, lowestHeldOtpId, type StatusAwareRotationOptions } from './signal-identity';
import { SpkCandidateOrder } from './spk-candidates';
import { detectCurrentGame, getCurrentGameCached, getRunningProcessList, setCustomGames, setIgnoredProcesses, nextGamePollDelayMs, GAME_POLL_MS, GAME_POLL_SETTLE_MS } from './game-detector';
import { secureStore } from './storage';
import { shouldShowKeyProtectionNotice, keyProtectionNoticeToken } from './key-protection';
import { KvCrypto } from './kv-crypto';
import { isRendererSecureKey, filterRendererSecureKeys } from './secure-store-policy';
import { createRecoveryKeyGate } from './recovery-key-gate';
import { startOAuth, getAccessToken, revokeTokens, getLinkedAccount } from './googleDriveAuth';
import { uploadFileResumable, downloadFileToPath } from './driveTransfer';
import { showAnnotationOverlay, hideAnnotationOverlay, pushAnnotationOverlayDelta, setAnnotationOverlayNative, annotationOverlayPrecheck, type OverlayDelta, type OverlayShowResult } from './annotation-overlay';
import { thumbnailJpegDataUrl } from './thumbnailDataUrl';
import { createDesktopSourcesBroker } from './desktop-sources';
import { parseAttributionClipboard, parseAttributionArgv } from './attribution-link';
import {
  showNotification,
  closeAllNotifications,
  registerNotificationReplyBridge,
  markRendererReplyListenerLost,
} from './notifications';
import { setBadgeCount, flashTaskbar, applyWindowsCallOverlay } from './badge';
import { setupTray, updateTrayMenu, getTray, setTrayCallState } from './tray';
import type { TrayMenuState } from './tray';
import { encryptForDevices, decryptWithRetainedSpks, encryptChannelMessage, decryptChannelMessage, flushReplayCache, type DevicePub } from './e2ee-engine';
import { setChannelKey, getChannelKey, getLatestEpoch, listChannelEpochs, rotateChannelKey, pruneOldKeys, getChannelKeyFingerprint, listChannelEpochFingerprints, discardChannelKey, setProtectedEpochs } from './channel-keys';
import { installerSplashHtml } from './installer-splash';
import { shouldGiveUpOnCrashLoop } from './crashLoopPolicy';
import { watchLinuxScreenLock } from './linux-screensaver';
import { showAndFocusWindow } from './window-focus';
import {
  FOCUS_ENDPOINT,
  isTrustedHandoffRequest,
  decodeHandoffBody,
  handoffResponseBody,
  handOffToRunningInstance,
  MAX_HANDOFF_BODY,
} from './instance-handoff';
import {
  onUpdateAvailable,
  onDownloadProgress,
  onUpdateDownloaded,
  onUpdateError,
  pickDownloadUrl,
  UPDATE_BASE_URL,
  type UpdateState as UpdateStateT,
  type UpdateFileInfo as UpdateFileInfoT,
} from './updater-state';
import { syncKdeGlobalShortcuts, teardownKdeGlobalShortcuts } from './kde-global-shortcuts';
import { isTrustedSenderUrl, channelRequiresSenderCheck } from './ipc-guard';
import {
  buildChromiumMediaSwitches, captureLogSwitches, expectedScreenCapturer,
  windowsBuildFromRelease, parseCaptureTimingLog, summarizeGpuDevices,
  decideAutoScreenCapturer, gpuTopologyFromInfo, parseGpuTopologyHint, serializeGpuTopologyHint,
  resolveCapturedDisplayHz, GPU_TOPOLOGY_FILENAME, GPU_TOPOLOGY_MAX_BYTES,
  pickerEnumeration, parseSourcesHelperFailure, serializeSourcesHelperFailure,
  SOURCES_HELPER_FAILURE_FILENAME, SOURCES_HELPER_FAILURE_MAX_BYTES,
} from './capture-flags';
import { createSourcesHelperClient, launchSourcesHelper } from './sources-helper-client';
import { SOURCES_HELPER_FLAG, type ListedSource } from './sources-helper-protocol';
import {
  STARTUP_FLAGS_FILENAME, CAPTURE_LOG_FILENAME, CAPTURE_LOG_MAX_BYTES, DEFAULT_STARTUP_FLAGS,
  readStartupFlagsFile, writeStartupFlagsFile, resolveStartupFlags, validateStartupFlagsPatch,
  prepareCaptureLogFiles, enforceCaptureLogCap,
} from './startup-flags';
import { freezeMonitor } from './freeze-monitor';
import {
  gamingVideoStartupSwitches, validateCallMediaActive, CallPriorityBooster, PRIORITY_REAPPLY_MS,
} from './gaming-video-mode';
import { PowerCoordinator, type PowerSignal } from './power-events';
import { wireWindowDiagnostics, summarizeAppMetrics, summarizeGpuFeatureStatus, describeChildProcessGone } from './lifecycle-diagnostics';
import { powChallengeToHash } from './pow-challenge';
import {
  PendingCrashStore, mainScrubber, crashFromMainError, crashFromRenderGone, crashFromChildGone,
  crashFromRendererReport, rotateSessionMarker, clearSessionMarker, parseSignatures, buildSystemInfo,
  reportChannel, validateReportFile, defaultReportFileName, UNCLEAN_EXIT_MARKER_FILE,
  type GpuInfoLike,
} from './diagnostics';
import { beginLinkSession, bindLinkSession, openActiveLinkSession, endLinkSession, sealLinkGrant, type LinkGrantPayload } from './link-grant';
import {
  STAGING_VERIFIER, verifyPassword, isAcceptablePasswordInput, createAttemptLimiter,
  readUnlockFileSync, removeUnlockFile, UNLOCK_FILENAME, PREVIEW_UNLOCK_FILENAME,
  STAGING_UNLOCK_STORE_KEY, PREVIEW_UNLOCK_STORE_KEY, serializeUnlockMarker, resolveRememberedUnlock,
  resolveStagingLockMode, decideSetChannel, STAGING_LOCKED_ERROR,
  type StagingLockStatus, type StagingUnlockResult,
} from './staging-lock';

// ── MED-3: ONE dev/prod switch, anchored to app.isPackaged ─────────────────
//
// Every dev-vs-prod security decision in this file used to key off the
// presence of `VITE_DEV_SERVER_URL`: IPC sender trust, navigation pinning,
// redirect pinning, the CSP's `unsafe-eval`/`unsafe-inline`, upload TLS
// verification (`rejectUnauthorized: false`), the updater, and DevTools.
// Setting a user-level environment variable on Windows needs no elevation, so
// one `setx VITE_DEV_SERVER_URL ...` turned all six off at once in a shipped
// build. `app.isPackaged` cannot be set from the environment — it is derived
// from the executable Electron is running as — so it is the only honest
// answer to "is this a real install?".
//
// The rule now: a relaxation requires BOTH a non-packaged build AND (where the
// relaxation is about talking to the dev server) the dev URL. Reading
// `process.env.VITE_DEV_SERVER_URL` anywhere else in this file is a bug —
// use `DEV_SERVER_URL`.
//
// Dev workflow is unchanged: `npm run dev:windows` runs `electron .`
// unpackaged, so `app.isPackaged` is false and `DEV_SERVER_URL` is exactly the
// env value it has always been. What changed is only the packaged case, where
// the variable is now ignored.
const IS_PACKAGED = app.isPackaged;
const DEV_SERVER_URL: string | undefined =
  IS_PACKAGED ? undefined : (process.env.VITE_DEV_SERVER_URL || undefined);
const IS_SMOKE_TEST = !!process.env.CIPHERLINE_SMOKE_TEST;
// The updater only exists in a real install. Previously each of the four
// updater call sites made this decision for itself off the dev URL, and they
// had already drifted (`set-channel` and `quit-and-install` checked only the
// dev URL; the registration block and `check-now` also checked the smoke
// test). One constant, used by all of them.
const UPDATER_ENABLED = IS_PACKAGED && !IS_SMOKE_TEST;

// electron-updater is loaded on first use, never at startup. Requiring it
// (js-yaml, semver, fs-extra, builder-util-runtime, …) is synchronous and was
// measured at ~350 ms on the dev box — spent at module load, before
// app.ready, on the critical path to the window appearing, in every build
// including dev and the smoke test where it is never used at all. The proxy
// keeps every `autoUpdater.x` call site as it was.
let loadedAutoUpdater: AppUpdater | null = null;
const loadAutoUpdater = (): AppUpdater => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  if (!loadedAutoUpdater) loadedAutoUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater;
  return loadedAutoUpdater;
};
const autoUpdater = new Proxy({} as AppUpdater, {
  get: (_t, prop) => {
    const u = loadAutoUpdater();
    const v = Reflect.get(u, prop, u);
    return typeof v === 'function' ? v.bind(u) : v;
  },
  set: (_t, prop, value) => Reflect.set(loadAutoUpdater(), prop, value),
});

// Native per-app audio capture: WASAPI ApplicationLoopback on Windows
// (src-native/audio_capture.cc), ScreenCaptureKit on macOS 13+
// (src-native/audio_capture_mac.mm). Same addon name and JS surface on both;
// absent on Linux, where the renderer falls back to Chromium loopback.
// Loaded inside app.whenReady() — see below — so that Electron's COM apartment and
// audio subsystems are fully initialized before mmdevapi.dll is pulled in.
let audioCaptureAddon: {
  // macOS only: false below macOS 13 (the addon still loads there). The Windows
  // addon has no such export — being loaded is being supported.
  isSupported?(): boolean;
  getPidFromSourceId(sourceId: string): number | null;
  startCapture(
    pid: number,
    mode: 'include' | 'exclude',
    // Either a normal PCM chunk, or one of two one-shot, terminal signals:
    // { processExited: true } (Phase K — the include-target quit; see
    // audio_capture.cc's IsProcessAlive) and, macOS only, { failed: true, … }
    // (Screen Recording not granted, ScreenCaptureKit stopped, target not found).
    callback: (chunk:
      | { sampleRate: number; channels: number; data: Buffer }
      | { processExited: true }
      | { failed: true; reason: string; message: string }) => void
  ): void;
  stopCapture(): void;
} | null = null;

/** True when the native addon is loaded AND this OS can actually run it. */
function nativeAudioCaptureAvailable(): boolean {
  if (!audioCaptureAddon) return false;
  return audioCaptureAddon.isSupported ? audioCaptureAddon.isSupported() : true;
}

// ── Crash / issue reporter: pending crash records (electron/diagnostics.ts) ──
// Records are JS-level only (error name, scrubbed message + stack, process
// type, Electron's reason enum, exit code) — no minidumps, no crashReporter.
// Held in memory until SecureStore is ready, then persisted ENCRYPTED under
// 'diag_pending_crashes' (excluded from backups — see backupRegistry.ts). The
// renderer offers to send them on the next boot; nothing is uploaded from here.
const pendingCrashes = new PendingCrashStore();
const safeOsUsername = (): string | undefined => {
  try { return os.userInfo().username || undefined; } catch { return undefined; }
};
let diagScrubberCache: ReturnType<typeof mainScrubber> | null = null;
const diagScrubber = () => (diagScrubberCache ??= mainScrubber(os.homedir(), safeOsUsername()));
const recordCrash = (build: () => Parameters<PendingCrashStore['add']>[0]): void => {
  // A crash handler must never throw — that would turn one crash into two.
  try { pendingCrashes.add(build()); } catch (e) { console.error('[Main] could not record crash:', e); }
};

// Catch any main-process crash before Electron's own error handling swallows it.
process.on('uncaughtException', (err) => {
  console.error('[Main] uncaughtException:', err);
  recordCrash(() => crashFromMainError(err, 'uncaughtException', Date.now(), app.getVersion(), diagScrubber()));
});
process.on('unhandledRejection', (reason) => {
  console.error('[Main] unhandledRejection:', reason);
  recordCrash(() => crashFromMainError(reason, 'unhandledRejection', Date.now(), app.getVersion(), diagScrubber()));
});

// Unclean-exit detector: a marker in userData written once this instance is
// definitely the live one (first createWindow) and removed on a clean quit or
// an OS shutdown / log-off. Found at the next launch → 'unclean_exit'. Packaged
// builds only (a dev session killed with Ctrl+C would otherwise prompt every
// launch); CIPHERLINE_DIAG_UNCLEAN_EXIT=1 opts a dev run in. Never under the
// smoke test — no startup disk writes there (CLAUDE.md, smoke-test trap).
const SESSION_MARKER_ENABLED = !IS_SMOKE_TEST && (IS_PACKAGED || process.env.CIPHERLINE_DIAG_UNCLEAN_EXIT === '1');
let sessionMarkerPath: string | null = null;
const startSessionMarker = (): void => {
  if (!SESSION_MARKER_ENABLED || sessionMarkerPath) return;
  sessionMarkerPath = path.join(app.getPath('userData'), UNCLEAN_EXIT_MARKER_FILE);
  recordCrash(() => rotateSessionMarker(fs, sessionMarkerPath!, app.getVersion(), Date.now()));
};
const endSessionMarker = (): void => {
  if (sessionMarkerPath) clearSessionMarker(fs, sessionMarkerPath);
};

// Dev mode: treat the Vite dev server origin as a secure context so that
// window.crypto.subtle (WebCrypto) is available over plain HTTP.
// Only activates in an unpackaged build with a dev server (see DEV_SERVER_URL
// above) — a packaged build is unaffected no matter what the environment says.
const devUrl = DEV_SERVER_URL;
if (devUrl) {
  app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', devUrl);
}

// Ensure OS notifications attribute to "Cipherline" rather than "Electron"
// (dev) and group correctly in the Windows Action Center.
app.setName('Cipherline');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.cipherline.desktop');
}

// Suppress Chromium-native error spam.
//
// In dev we get a constant stream of `socket_manager.cc(147)] Failed to
// resolve address for stun.l.google.com errorcode: -105` — Chromium's
// internal WebRTC stack does periodic STUN connectivity probes via its
// built-in async DNS resolver, which can fail even when Windows nslookup
// resolves the same hostname fine (Chromium uses its own DoH/async resolver
// rather than the OS stub on a code path we can't override from JS).
//
// What we tried that didn't work:
//   • `rtcConfig.iceServers = []` on the LiveKit Room — affects our
//     RTCPeerConnection but not Chromium's internal probes
//   • `--force-fieldtrials=WebRTC-StunProbe/Disabled/` — doesn't gate this
//     code path
//   • Hooking `process.stderr.write` in the main process — only catches
//     the main process; the noise comes from a Chromium child process
//     (renderer/utility) whose stderr Chromium pipes directly to the
//     terminal, bypassing any Node-level intercept
//
// The probes don't affect Cipherline calls — LiveKit's SFU delivers its
// own ICE candidates over the signaling WS, and on the LAN dev box the
// media goes direct to `node_ip:7881/7882`. Calls work; the lines are
// pure noise.
//
// `--log-level=3` tells Chromium to only emit FATAL log entries — drops
// the INFO/WARNING/ERROR Chromium-internal lines (where this STUN noise
// lives) but does NOT touch our app's `console.log` / `console.error` /
// `console.warn` calls — those go through V8 and the renderer DevTools
// console regardless of this flag. So application-level logging is
// unaffected; only Chromium's own native logging is suppressed.
//
// This stays on even with the opt-in capture-timing log below: that log is
// made of --vmodule VLOGs, which bypass the minimum severity, and keeping
// the minimum at FATAL is exactly what keeps renderer console output and
// URLs OUT of the log file (measured — see captureLogSwitches).
app.commandLine.appendSwitch('log-level', '3');

// ── Startup flags (Settings → Advanced → screen capture) ─────────────────
// The two capture test switches below are Chromium command-line switches,
// so they must be known NOW, before app.ready — when SecureStore/safeStorage
// is not yet usable. They live in a small non-secret JSON file instead
// (<userData>/startup-flags.json, see ./startup-flags.ts), written only via
// the `app:set-startup-flags` IPC and applied on the next launch.
// Precedence: env var > file > default. The smoke test never reads or
// writes the file, so a stale file on a CI runner cannot change what the
// gate measures.
const USER_DATA_DIR = app.getPath('userData');
const STARTUP_FLAGS_PATH = path.join(USER_DATA_DIR, STARTUP_FLAGS_FILENAME);
const STARTUP_FLAGS = resolveStartupFlags({
  file: IS_SMOKE_TEST ? { ...DEFAULT_STARTUP_FLAGS } : readStartupFlagsFile(STARTUP_FLAGS_PATH),
  env: {
    CIPHERLINE_SCREEN_CAPTURER: process.env.CIPHERLINE_SCREEN_CAPTURER,
    CIPHERLINE_CAPTURE_LOG: process.env.CIPHERLINE_CAPTURE_LOG,
  },
  packaged: IS_PACKAGED,
});
const CAPTURE_LOG_ENABLED = STARTUP_FLAGS.captureLog;

// ── Staging lock (Settings → Advanced → Update channel; staging builds) ──
// A password gate on pre-release access, owned HERE rather than in the
// renderer: main verifies the password, holds the unlocked state, and
// `updater:set-channel` refuses 'staging' while locked. The renderer's unlock
// screen and prompt are UX on top. A deterrent, not a security boundary —
// see the header of ./staging-lock.ts for exactly why.
//
// Never under the smoke test (resolveStagingLockMode returns not-enforced, so
// there is no file read here and no write ever happens for it), and never in
// an unpackaged build unless CIPHERLINE_STAGING_LOCK_PREVIEW=1 asks for a
// preview — which a packaged build ignores. The unlock is remembered in the
// encrypted SecureStore (a marker bound to the current password verifier),
// so it is only known once the store is ready: `stagingUnlocked` starts
// LOCKED and is settled by loadRememberedStagingUnlock() at the storeReady
// barrier, before any staging-lock IPC handler exists or the window opens.
// Any problem reading it means "locked" and never blocks startup.
const STAGING_LOCK = resolveStagingLockMode({
  packaged: IS_PACKAGED,
  smokeTest: IS_SMOKE_TEST,
  version: app.getVersion(),
  previewEnv: process.env.CIPHERLINE_STAGING_LOCK_PREVIEW,
});
/** Legacy plaintext unlock file — read once to migrate, then deleted. */
const STAGING_UNLOCK_PATH = path.join(
  USER_DATA_DIR, STAGING_LOCK.preview ? PREVIEW_UNLOCK_FILENAME : UNLOCK_FILENAME,
);
const STAGING_UNLOCK_KEY = STAGING_LOCK.preview ? PREVIEW_UNLOCK_STORE_KEY : STAGING_UNLOCK_STORE_KEY;
let stagingUnlocked = !STAGING_LOCK.enforced;
const stagingAttempts = createAttemptLimiter();
const stagingLockStatus = (): StagingLockStatus => ({
  enforced: STAGING_LOCK.enforced,
  isStagingBuild: STAGING_LOCK.isStagingBuild,
  unlocked: isStagingUnlocked(),
  retryAfterMs: stagingAttempts.retryAfterMs(),
});

// The remembered unlock lives in SecureStore. Every touch of it below is
// gated on stagingStoreUsable(): never under the smoke test (its store is
// pathless — a write there failed every staging build once, see CLAUDE.md /
// the smoke-test SecureStore trap), never before init, never while the
// keystore is locked (get() is null and set() throws there).
function stagingStoreUsable(): boolean {
  return STAGING_LOCK.enforced && !IS_SMOKE_TEST && secureStore.status() === 'ok';
}

function readStagingMarker(): string | null {
  if (!stagingStoreUsable()) return null;
  try { return secureStore.get(STAGING_UNLOCK_KEY); } catch { return null; }
}

/**
 * Called once, at the storeReady barrier (before the staging-lock IPC
 * handlers are registered and before the window exists). Settles
 * `stagingUnlocked` from the marker; a legacy plaintext file from an older
 * build is accepted only while the verifier is unchanged, copied into the
 * store, and deleted once the store write is on disk.
 */
function loadRememberedStagingUnlock(): void {
  if (!STAGING_LOCK.enforced || IS_SMOKE_TEST) return;
  const legacyFileValid = readUnlockFileSync(STAGING_UNLOCK_PATH);
  const r = resolveRememberedUnlock({
    enforced: true, marker: readStagingMarker(), legacyFileValid, verifier: STAGING_VERIFIER,
  });
  stagingUnlocked = r.unlocked;
  if (r.source === 'marker') {
    // Leftover from a migration interrupted after the store write.
    if (legacyFileValid) removeUnlockFile(STAGING_UNLOCK_PATH);
  } else if (r.source === 'legacy-file' && stagingStoreUsable()) {
    void rememberStagingUnlock().then((ok) => { if (ok) removeUnlockFile(STAGING_UNLOCK_PATH); });
  }
  console.log('[Main/StagingLock] remembered unlock:', r.source);
}

/** Write the marker (bound to the current verifier) and wait for it to reach disk. */
async function rememberStagingUnlock(): Promise<boolean> {
  if (!stagingStoreUsable()) return false;
  try {
    secureStore.set(STAGING_UNLOCK_KEY, serializeUnlockMarker(STAGING_VERIFIER, Date.now()));
    await secureStore.whenDurable();
    return true;
  } catch (e) {
    console.warn('[Main/StagingLock] could not remember the unlock:', (e as NodeJS.ErrnoException)?.code ?? 'error');
    return false;
  }
}

function forgetStagingUnlock(): void {
  if (stagingStoreUsable()) {
    try { secureStore.delete(STAGING_UNLOCK_KEY); } catch { /* reported by the store */ }
  }
  removeUnlockFile(STAGING_UNLOCK_PATH);
}

/**
 * The live answer. While locked it re-reads the marker, so a keystore that
 * was locked at boot and recovered later (StorageLockedScreen) is honoured
 * without a relaunch. Only a VALID marker for the current verifier unlocks.
 */
function isStagingUnlocked(): boolean {
  if (!stagingUnlocked && stagingStoreUsable()) {
    stagingUnlocked = resolveRememberedUnlock({
      enforced: true, marker: readStagingMarker(), legacyFileValid: false, verifier: STAGING_VERIFIER,
    }).unlocked;
  }
  return stagingUnlocked;
}
// Frame timings only (see captureLogSwitches); ≤ CAPTURE_LOG_MAX_BYTES, with
// the previous launch's copy kept alongside as capture-debug.prev.log. On
// Windows: %APPDATA%\Cipherline\capture-debug.log.
const CAPTURE_LOG_FILE = path.join(USER_DATA_DIR, CAPTURE_LOG_FILENAME);

// ── Screen capture + hardware encode (Chromium media switches) ───────────
// The full source-cited explanation lives in ./capture-flags.ts. In short:
//
//  • Chromium caps desktop capture at half a core: the next grab is
//    scheduled max(2 × last grab's duration, 1/requested fps) after the last
//    one (desktop_capture_device.cc, kDefaultMaximumCpuConsumptionPercentage
//    = 50). That is the ~52 fps ceiling on a 1440p screen share, whatever the
//    encoder or codec. This app used to append
//    `webrtc-max-cpu-consumption-percentage=100` to lift it; Chromium 150 has
//    no such switch (measured: Chromium logs max_cpu_consumption_percentage=
//    50 with or without it), so it is gone rather than left looking like a fix.
//  • What we CAN pick is the OS capturer (most of that per-grab duration):
//    Settings → Advanced → Screen capture method (or, overriding it,
//    CIPHERLINE_SCREEN_CAPTURER=dxgi|wgc) forces DXGI Desktop Duplication or
//    Windows.Graphics.Capture for screens. Automatic = DXGI on Windows 11
//    24H2+, except on a hybrid-GPU machine, before we know the GPU layout,
//    or after the out-of-process picker failed, where it is WGC with DXGI
//    disabled (before 24H2: Chromium's own DXGI) — measured on the owner's
//    Win11 26200 box: DXGI grab 3.6 ms vs WGC ≈9.7 ms at 1440p, and
//    Chromium's 2×-grab rule turns 9.7 ms into a ~52 fps ceiling. Whenever
//    DXGI is enabled here, the share picker lists sources in a helper
//    process with DXGI disabled (PICKER_ENUMERATION) — never on main. The
//    GPU layout comes from the previous launch (gpu-topology.json), because
//    this switch must be set before Chromium can report GPUs. Full rationale
//    and DXGI failure modes: decideAutoScreenCapturer in ./capture-flags.ts.
//  • PlatformH264CbpEncoding (Windows): lets Chromium use a hardware encoder
//    for the H.264 profile LiveKit actually negotiates (Constrained
//    Baseline). Without it every LiveKit H.264 share on Windows was OpenH264.
//  • Settings → Advanced → Capture timing log (or, in an unpackaged build,
//    CIPHERLINE_CAPTURE_LOG=1/0): Chromium writes its per-frame capture
//    timing to <userData>/capture-debug.log, which the stream-stats overlay
//    reads back — the direct measurement of the throttle.
//
// Chromium keeps only the LAST value of a repeated switch, so every
// enable/disable-features entry must go through this one call.
const SCREEN_CAPTURER_PREF = STARTUP_FLAGS.screenCapturer;
const GPU_TOPOLOGY_PATH = path.join(USER_DATA_DIR, GPU_TOPOLOGY_FILENAME);
/** GPU layout from the previous launch; null on the first launch / smoke test. */
const GPU_TOPOLOGY_AT_START = (() => {
  if (IS_SMOKE_TEST || process.platform !== 'win32') return null;
  try {
    const st = fs.statSync(GPU_TOPOLOGY_PATH);
    if (st.size > GPU_TOPOLOGY_MAX_BYTES) return null;
    return parseGpuTopologyHint(fs.readFileSync(GPU_TOPOLOGY_PATH, 'utf8'));
  } catch {
    return null;
  }
})();
// "The out-of-process picker could not start" on a previous launch of this
// version → Automatic falls back to WGC (see decideAutoScreenCapturer).
const SOURCES_HELPER_FAILURE_PATH = path.join(USER_DATA_DIR, SOURCES_HELPER_FAILURE_FILENAME);
const SOURCES_HELPER_FAILED_AT_START = (() => {
  if (IS_SMOKE_TEST || process.platform !== 'win32') return false;
  try {
    const st = fs.statSync(SOURCES_HELPER_FAILURE_PATH);
    if (st.size > SOURCES_HELPER_FAILURE_MAX_BYTES) return false;
    return parseSourcesHelperFailure(fs.readFileSync(SOURCES_HELPER_FAILURE_PATH, 'utf8'), app.getVersion());
  } catch {
    return false;
  }
})();
const AUTO_CAPTURER = decideAutoScreenCapturer({
  platform: process.platform,
  windowsBuild: process.platform === 'win32' ? windowsBuildFromRelease(os.release()) : null,
  gpu: GPU_TOPOLOGY_AT_START,
  helperFailed: SOURCES_HELPER_FAILED_AT_START,
});
// Where desktopCapturer.getSources() runs: in a helper process whenever DXGI
// is enabled in THIS process (the picker must never initialise DXGI on the
// main thread — the 2026-10-07 freeze), in-process otherwise. The env knob
// exists to exercise the helper on non-Windows harnesses; unpackaged only.
const PICKER_ENUMERATION = pickerEnumeration({
  platform: process.platform,
  pref: SCREEN_CAPTURER_PREF,
  autoBackend: AUTO_CAPTURER.backend,
  forceHelper: !IS_PACKAGED && process.env.CIPHERLINE_SOURCES_HELPER === '1',
});
// "Prioritize call video while gaming" (Settings → Voice & Video), launch-time
// half: keep Chromium from backgrounding/occlusion-throttling the app when a
// fullscreen game covers it. See ./gaming-video-mode.ts. Its disable-features
// entry is MERGED into the one media list below, never appended on its own.
const GAMING_VIDEO_AT_LAUNCH = STARTUP_FLAGS.gamingVideo;
// Runtime half: ABOVE_NORMAL process priority for every Cipherline process
// while (setting on) AND (a call is running), Windows only, restored to each
// process's own previous priority afterwards. Follows the SAVED setting, so
// turning it on or off takes effect immediately (no restart). The renderer
// reports the call via `call:set-media-active`; a renderer reload or crash
// ends the "call" here too (see createWindow).
const callPriority = new CallPriorityBooster({
  platform: process.platform,
  listPids: () => app.getAppMetrics().map(m => m.pid),
  getPriority: (pid) => os.getPriority(pid),
  setPriority: (pid, priority) => os.setPriority(pid, priority),
});
let callPriorityTimer: ReturnType<typeof setInterval> | null = null;
const syncCallPriority = (change: { enabled?: boolean; inCall?: boolean }) => {
  if (change.enabled !== undefined) callPriority.setEnabled(change.enabled);
  if (change.inCall !== undefined) callPriority.setInCall(change.inCall);
  if (callPriority.active && !callPriorityTimer) {
    callPriorityTimer = setInterval(() => callPriority.tick(), PRIORITY_REAPPLY_MS);
    callPriorityTimer.unref?.();
  } else if (!callPriority.active && callPriorityTimer) {
    clearInterval(callPriorityTimer);
    callPriorityTimer = null;
  }
};
syncCallPriority({ enabled: GAMING_VIDEO_AT_LAUNCH });
{
  const gamingSwitches = gamingVideoStartupSwitches(GAMING_VIDEO_AT_LAUNCH, process.platform);
  for (const name of gamingSwitches.switches) app.commandLine.appendSwitch(name);
  const media = buildChromiumMediaSwitches(process.platform, SCREEN_CAPTURER_PREF, AUTO_CAPTURER.backend);
  media.disableFeatures.push(...gamingSwitches.disableFeatures);
  if (GAMING_VIDEO_AT_LAUNCH) {
    console.log(`[Main] Gaming video mode ON at launch: ${[...gamingSwitches.switches, ...gamingSwitches.disableFeatures.map(f => `disable-features=${f}`)].join(', ')}`);
  }
  if (media.enableFeatures.length) {
    app.commandLine.appendSwitch('enable-features', media.enableFeatures.join(','));
  }
  if (media.disableFeatures.length) {
    app.commandLine.appendSwitch('disable-features', media.disableFeatures.join(','));
  }
  for (const [name, value] of captureLogSwitches(CAPTURE_LOG_ENABLED, CAPTURE_LOG_FILE, { packaged: IS_PACKAGED })) {
    app.commandLine.appendSwitch(name, value);
  }
  // Off: delete any stale log. On: keep last launch's as .prev (if within the
  // cap) and start empty, so the overlay only ever parses this run's capture.
  // Never throws. Skipped under the smoke test (it never enables the log).
  if (!IS_SMOKE_TEST) prepareCaptureLogFiles(USER_DATA_DIR, CAPTURE_LOG_ENABLED);
  if (CAPTURE_LOG_ENABLED) {
    // Chromium has no size limit of its own on this file and appends for as
    // long as a share runs; hold it under the cap.
    setInterval(() => { void enforceCaptureLogCap(CAPTURE_LOG_FILE); }, 15_000).unref();
    console.log(`[Main] Capture-timing log ON (${STARTUP_FLAGS.source.captureLog}) → ${CAPTURE_LOG_FILE}`);
  }
  // In the Performance log too, so a diagnostics report says which capturer
  // (and whether DXGI was in the process at all) without a console.
  freezeMonitor.event('capture:switches', 0,
    `pref=${SCREEN_CAPTURER_PREF} auto=${AUTO_CAPTURER.backend} enable=${media.enableFeatures.join(',') || '-'} disable=${media.disableFeatures.join(',') || '-'} picker=${PICKER_ENUMERATION}${SOURCES_HELPER_FAILED_AT_START ? ' helper-failed-last-launch' : ''}`);
  if (SCREEN_CAPTURER_PREF !== 'auto') {
    console.log(`[Main] Screen capturer forced: ${SCREEN_CAPTURER_PREF} (${STARTUP_FLAGS.source.screenCapturer})`);
  } else if (process.platform === 'win32') {
    console.log(`[Main] Screen capturer auto: ${AUTO_CAPTURER.backend} (${AUTO_CAPTURER.why})`);
  }
}

// ── Linux screen share (Wayland) ─────────────────────────────────────────
//
// This is the fix for "screen share brings up a Chrome-looking picker
// instead of Cipherline's own, and it doesn't actually work after you
// choose something": that picker isn't ours. setDisplayMediaRequestHandler
// below (search for it) intercepts getDisplayMedia and shows our own
// ScreenSharePickerModal via 'show-screenshare-picker' — the exact same
// code path Windows uses. On a Wayland session, two things were missing
// for it to work the same way there:
//
//   1. Without --ozone-platform-hint, Electron runs as an X11 client under
//      XWayland rather than a native Wayland client. desktopCapturer then
//      uses the legacy X11 capture backend, which can enumerate windows
//      that belong to XWayland but generally can't produce real frames for
//      native Wayland surfaces — sources may LIST, but the resulting stream
//      is blank/frozen. That's "I select one and it doesn't work."
//   2. Without WebRTCPipeWireCapturer, Chromium's PipeWire-backed capturer
//      (the thing that talks to the xdg-desktop-portal ScreenCast portal
//      and is what actually captures Wayland surface content) isn't
//      guaranteed on. When it's off, Chromium can silently fall back to
//      its OWN built-in getDisplayMedia picker instead of ever reaching
//      setDisplayMediaRequestHandler — which is the literal "Chrome-looking
//      selector" being reported: it's Chromium's picker, not Cipherline's.
//
// Together these make desktopCapturer.getSources() return real,
// screenshottable Wayland sources, keep getDisplayMedia routed through our
// own handler, and let Windows and Linux go through the identical picker
// and IPC flow from here on.
//
// Linux-only: Ozone is a Linux windowing concept and Chromium ignores both
// switches elsewhere, but scoping explicitly avoids any surprise on a
// platform where nothing here is relevant. Under X11 (not Wayland) this
// is a no-op — Ozone auto-detects and stays on the X11 backend, matching
// today's already-working behavior.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  // WebRTCPipeWireCapturer is appended with the other media features above
  // (buildChromiumMediaSwitches) — a second 'enable-features' append here
  // would replace that list rather than add to it.
}

let mainWindow: BrowserWindow | null = null;

// Fixed port (not 0/random) so the renderer's origin is stable across launches.
// Random ports would give a different origin every run, wiping localStorage
// (auth tokens, keys) and IndexedDB (message/attachment caches) each time —
// Chromium keys per-origin storage on full host+port.
//
// Module scope rather than local to createWindow because a *second* launch also
// needs it: when this port is already bound, that second instance talks to the
// running one over it (see handOffToRunningInstance) instead of failing.
//
// The smoke test is the one deliberate exception. It is a throwaway launch that
// only checks the renderer paints — it has no local data whose origin needs
// preserving. And on a machine that is BOTH a CI runner and someone's test PC
// (a normal setup here), the fixed port would be held by their own running
// client, so the build would fail with a bare "no window" timeout that names
// nothing about the real cause. A separate port keeps a running client and a
// build from colliding.
const CIPHERLINE_PROD_PORT = IS_SMOKE_TEST ? 42918 : 42917;
// Set to true before calling app.quit() so the minimize-to-tray close intercept
// lets the quit go through rather than just hiding the window.
// Wrapped in an object so tray.ts callbacks can read the latest value by reference.
// Both `isQuitting` and `isQuittingRef.value` must be kept in sync.
let isQuitting = false;
const isQuittingRef = { value: false };
function setIsQuitting(v: boolean) { isQuitting = v; isQuittingRef.value = v; }

// Current tray menu state — kept in sync by IPC pushes from the renderer.
let trayState: TrayMenuState = { unreadCount: 0, dndActive: false, dndManual: false, status: 'online' };

/** Create or destroy the system-tray icon depending on the `enabled` flag.
 *  Delegates to tray.ts which owns the full menu logic. */
function updateTray(enabled: boolean): void {
  if (!mainWindow) return;
  setupTray(enabled, mainWindow, isQuittingRef, trayState);
}

// ── Window geometry persistence ───────────────────────────────────────────────
// Saves/restores window size, position and maximised state across launches.
// Uses a plain JSON file in the Electron userData directory (no encryption
// needed — geometry isn't sensitive). Sidebar widths are already persisted as
// ratios in the renderer's localStorage; only the OS-level window state is
// handled here.
interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const WINDOW_STATE_FILE = () =>
  path.join(app.getPath('userData'), 'window-state.json');

/**
 * Read the last saved state; returns sane defaults on any error.
 *
 * This naturally satisfies both geometry requirements without branching on
 * install-vs-update:
 *  - First install — no window-state.json exists yet, so we fall through to
 *    `defaults`: 1280×720 (Discord's first-launch size), no x/y so Electron
 *    centres it on the primary display.
 *  - Update / normal launch — window-state.json lives in userData, which
 *    survives updates, so the geometry the user left the window at (saved on
 *    every move/resize and on close, i.e. right before the update applied on
 *    quit) is restored verbatim.
 */
function loadWindowState(): WindowState {
  const defaults: WindowState = { width: 1280, height: 720, isMaximized: false };
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE(), 'utf8');
    const saved = JSON.parse(raw) as Partial<WindowState>;

    const width  = typeof saved.width  === 'number' && saved.width  >= 800  ? saved.width  : defaults.width;
    const height = typeof saved.height === 'number' && saved.height >= 560  ? saved.height : defaults.height;

    // Verify the saved position is still on a connected display.
    // If the user has disconnected/rearranged monitors we fall back to centred
    // rather than opening in an invisible off-screen position.
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const { x, y, width: dw, height: dh } = d.workArea;
        // Require at least a 100×100 portion of the window to be visible.
        const wRight  = saved.x! + width;
        const wBottom = saved.y! + height;
        return (
          wRight  > x + 100 &&
          saved.x! < x + dw - 100 &&
          wBottom > y + 100 &&
          saved.y! < y + dh - 100
        );
      });
      if (onScreen) {
        return { x: saved.x, y: saved.y, width, height, isMaximized: !!saved.isMaximized };
      }
    }

    // Position unknown or off-screen — let the OS centre the window.
    return { width, height, isMaximized: !!saved.isMaximized };
  } catch {
    return defaults;
  }
}

/** Write the current window state to disk. Call on move/resize/close. */
function saveWindowState(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  const isMaximized = win.isMaximized();
  // getNormalBounds returns the restored (un-maximised) size/position so we
  // remember the sensible size even when the user closes while maximised.
  const { x, y, width, height } = win.getNormalBounds();
  const state: WindowState = { x, y, width, height, isMaximized };
  try { fs.writeFileSync(WINDOW_STATE_FILE(), JSON.stringify(state)); } catch {}
}

async function createWindow(csp: string, startHidden = false) {
  // This instance is the live one now (the lock and the port hand-off are
  // behind us), so it may take over the unclean-exit marker. Once per launch.
  startSessionMarker();
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    // Explicit, not left to fall back: index.html's own <title> takes over
    // once the page finishes loading anyway (Electron applies the loaded
    // document's <title> over this option), so this only matters for the
    // brief pre-load window — but set it for real rather than relying on
    // that fallback chain, which is exactly what let the npm workspace name
    // ("desktop") leak into the Windows taskbar hover tooltip before.
    title: 'Cipherline',
    // When the installer splash is showing, the main window is built up behind
    // it and only revealed once startup work completes (see finalizeInstaller).
    show: !startHidden,
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    // Floor sized so the 4-pane layout never cramps/wraps: rail (68) + chat
    // list (~264) + a comfortable chat column (~400) + context panel (~250) +
    // resize handles. Below this the chat column would squeeze and text wraps.
    minWidth: 1000,
    // 720 keeps the tall sign-up form from clipping; the auth screen also
    // scrolls as a safety net below this.
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer sandbox: load-bearing per CLAUDE.md ("never weaken"). Set
      // explicitly so a future preload edit can't silently drop the sandbox.
      sandbox: true,
      // Disable Chromium's background throttling: when the window is hidden or
      // minimized, Chromium normally freezes timers (including our 15s WS
      // heartbeat) and suspends network I/O (ERR_NETWORK_IO_SUSPENDED). That
      // kills the WebSocket, forces a reconnect loop that itself stalls while
      // backgrounded, and results in the "slow messages / had to restart to
      // receive" / flaky typing indicators the user reported. A messaging app
      // needs identical fidelity foreground vs background — no reason to keep
      // the default here.
      backgroundThrottling: false,
      // Spell check is on by default in Electron, but explicit is clearer.
      // The actual suggestion menu is wired below via webContents.on('context-menu').
      spellcheck: true,
    },
    // frame:false removes the OS titlebar entirely on Windows/Linux.
    // On macOS, titleBarStyle:'hiddenInset' keeps the native traffic lights.
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Native window-controls overlay — WINDOWS ONLY. Colours match the app's
    // top drag bar — `bg-cl-abyss` (#0B0F1E) with cl-text glyphs (#F4F7FF) and
    // the same 34px height — so the min/maximise/close buttons blend into the
    // titlebar instead of sitting on a mismatched near-black strip.
    //
    // NOT on Linux, despite Electron supporting it there. Dashboard.tsx's
    // <WindowControls> draws its own design-system caption buttons on Linux
    // (its guard is `if (isMac || isWindows) return null`), on the assumption
    // — stated in its own comment — that the native overlay isn't available
    // there. That assumption is wrong on Electron 43: the overlay DOES render
    // on Linux, on top of the custom buttons. The native overlay is narrower
    // than the three custom buttons (120px total), so it covered the custom
    // maximise/close but left the custom minimise sticking out to its left —
    // the stray dash beside the minimize button. Reproduced exactly, and
    // fixed, in a minimal harness toggling only this one option.
    //
    // If this ever needs revisiting: `navigator.windowControlsOverlay.visible`
    // in the renderer is the ground truth for whether the native overlay is
    // being drawn (true on Windows, and on Linux only when this option is
    // set). WindowControls checks it as a backstop.
    titleBarOverlay: process.platform === 'win32' ? {
      color: '#0B0F1E',
      symbolColor: '#F4F7FF',
      height: 34
    } : undefined,
    // NOT transparent, deliberately. Windows 11's DWM rounds the corners of
    // an opaque frameless window by itself, so transparency buys nothing
    // visible here — while a transparent window has documented costs on
    // Windows (Electron's "Transparent windows" limitations: not resizable
    // the native way, no maximize via the system menu / title-bar
    // double-click) and composites per-pixel alpha in DWM on every frame.
    // backgroundColor below paints the window before the renderer does.
    transparent: false,
    backgroundColor: '#0B0F1E',
  });

  // HIGH-17: Enable screen-capture protection immediately on window creation
  // as a transient safe-by-default state for the brief window before the
  // renderer mounts and pushes the user's actual, persisted preference via
  // win:set-content-protection (usePrivacySettings.ts — default OFF, opt-in
  // via Settings → Privacy & Safety; see the comment near that IPC handler
  // below). Users who've opted IN keep protection continuously (their
  // persisted `true` is what gets pushed); users who haven't will see it
  // flip off within milliseconds of launch. This comment previously claimed
  // "Default is always ON," which contradicted the renderer's actual
  // steady-state default (OFF) — corrected here, no behavior change.
  try { mainWindow.setContentProtection(true); } catch { /* older Electron */ }

  // Restore maximised state AFTER the window is created so minWidth/minHeight
  // are already applied and the window chrome is fully initialised. When the
  // installer splash is up the window is still hidden — maximising a hidden
  // window can be dropped on show(), so defer it to finalizeInstaller (which
  // maximises right after revealing the window) instead.
  if (savedState.isMaximized) {
    if (startHidden) pendingMainMaximize = true;
    else mainWindow.maximize();
  }

  // Persist window geometry on move/resize (debounced to avoid hammering disk
  // during live dragging) and immediately on close so the last position is
  // always captured even if the app is force-quit.
  let _saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  const debouncedSaveState = () => {
    if (_saveStateTimer) clearTimeout(_saveStateTimer);
    _saveStateTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) saveWindowState(mainWindow);
      _saveStateTimer = null;
    }, 600);
  };
  mainWindow.on('resize', debouncedSaveState);
  mainWindow.on('move',   debouncedSaveState);
  // P2-ELEC-8: register AFTER mainWindow is assigned so they're not no-ops.
  mainWindow.on('maximize',   () => mainWindow?.webContents.send('win:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximized', false));
  // OS-level window focus / attention pushes for the renderer (P2-ELEC-8 again:
  // these were registered in the IPC block before this window existed, so
  // they were no-ops — see the note there). Bound to THIS window, which also
  // covers a window re-created after a renderer crash.
  //  - focus: the renderer's DOM 'focus' is unreliable when switching back
  //    from another native app; BrowserWindow 'focus' fires unconditionally.
  //  - blur / minimize / hide: Continuity's "definitely not attentive"
  //    signals (useRealtime.ts sends an off-cycle presence:heartbeat
  //    {active:false} on each). 'minimize' and 'hide' get their own push
  //    because some window managers don't blur on minimise, and close-to-tray
  //    hides without blurring.
  //  - minimize / hide / focus also drive the renderer's idle-motion gate
  //    (src/utils/idleMotion.ts): with backgroundThrottling:false the page is
  //    never told it is hidden, so this is the only way it learns to stop
  //    decorative animation while nobody can see it.
  {
    const win = mainWindow;
    const push = (channel: string) => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel);
    };
    win.on('focus', () => push('window:focus'));
    win.on('blur', () => push('window:blur'));
    win.on('minimize', () => push('window:minimize'));
    // Guarded (push): 'hide' can also fire while a window is being torn down.
    win.on('hide', () => push('window:hide'));
  }
  // Also flush immediately on close so a quick quit doesn't miss the last resize.
  // When minimize-to-tray is enabled and the user isn't explicitly quitting,
  // intercept the close and hide the window to the tray instead.
  // Windows force-shutdown / restart / log-off: the OS ends the session
  // without a normal quit. That is a clean end, not a crash — drop the
  // unclean-exit marker (powerMonitor 'shutdown' covers macOS/Linux).
  mainWindow.on('session-end', () => endSessionMarker());
  mainWindow.on('close', (e) => {
    if (_saveStateTimer) { clearTimeout(_saveStateTimer); _saveStateTimer = null; }
    saveWindowState(mainWindow!);
    // secureStore.get() now THROWS if the store never initialized (it used to
    // return a null that callers could not tell from "never set"). That is the
    // behaviour we want everywhere else, but an exception thrown out of a
    // 'close' handler would leave the user with a window they cannot close.
    // Read defensively here and treat any failure as "tray disabled", which is
    // the safe default: the window closes.
    let minimizeToTray = false;
    try { minimizeToTray = secureStore.get('minimizeToTray') === 'true'; } catch { /* store unavailable */ }
    if (!isQuitting && minimizeToTray) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Screen-capture protection: blanks Cipherline's window in OS-level
  // screenshots + screen recordings where the platform honours the flag
  // (Windows: full coverage; macOS: screenshots only, recordings bypass).
  // User-controllable via Settings → Privacy & Safety. Default OFF — the
  // renderer pushes the persisted preference up on startup via the
  // win:set-content-protection IPC once AuthContext mounts.

  // CRIT-8: Block all renderer navigations away from the app origin.
  // Prevents HTML injection → external page load → full node privilege escalation.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { event.preventDefault(); return; }
    const devUrl = DEV_SERVER_URL;
    if (devUrl) {
      const devParsed = new URL(devUrl);
      if (parsed.host !== devParsed.host) event.preventDefault();
    } else {
      // L1: check full origin (scheme+host+port) — any other port on 127.0.0.1 is not our app
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '42917') event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { event.preventDefault(); return; }
    const devUrl = DEV_SERVER_URL;
    if (devUrl) {
      const devParsed = new URL(devUrl);
      if (parsed.host !== devParsed.host) event.preventDefault();
    } else {
      // L1: check full origin (scheme+host+port) — any other port on 127.0.0.1 is not our app
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '42917') event.preventDefault();
    }
  });

  // HIGH-16: DevTools in dev only. In production, block the shortcut and close
  // DevTools if somehow opened (e.g. via remote debugging).
  if (DEV_SERVER_URL) {
    // P2-ELEC-23: Use a window-local shortcut (before-input-event) instead of
    // globalShortcut so Ctrl+Shift+I is only intercepted while Cipherline is
    // focused — not stolen from other apps (e.g. browser DevTools).
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'I' || !input.shift) return;
      const isMod = process.platform === 'darwin' ? input.meta : input.control;
      if (!isMod) return;
      event.preventDefault();
      if (mainWindow?.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow?.webContents.openDevTools();
      }
    });
  } else if (!IS_SMOKE_TEST) {
    // In CI smoke test, leave DevTools open so Playwright's CDP can attach.
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow?.webContents.closeDevTools();
    });
  }

  const url = DEV_SERVER_URL;
  console.log('[Main] VITE_DEV_SERVER_URL:', url || '(not set)');
  
  if (url) {
    console.log(`[Main] Attempting to load URL: ${url}`);
    mainWindow.loadURL(url);
    // Dev only (this branch never runs packaged). DevTools no longer opens by
    // itself: measured with the freeze harness against the Tier-1 dev setup,
    // an open DevTools roughly doubled the app's own freezes (time to
    // interactive 22.8 s vs 13-14.7 s; worst renderer stall 5.3 s vs 1.8-2.6 s;
    // main-process stalls 6.5 s total vs 1.5 s) — DevTools instruments every
    // DOM mutation and retains every logged object. Ctrl+Shift+I still opens
    // it, and CIPHERLINE_DEVTOOLS=1 restores the old always-open behaviour.
    if (process.env.CIPHERLINE_DEVTOOLS === '1') mainWindow.webContents.openDevTools();
  } else {
    // Production — serve the bundled dist/ folder via a local HTTP server on a
    // random loopback port.  This gives the renderer an http://127.0.0.1:PORT
    // origin instead of the null origin produced by file://, which fixes
    // third-party embeds (YouTube, etc.) that reject null-origin parent pages.
    const distDir = path.join(__dirname, '../dist');
    const MIME: Record<string, string> = {
      '.html': 'text/html', '.js': 'application/javascript',
      '.css': 'text/css',   '.json': 'application/json',
      '.png': 'image/png',  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.wav': 'audio/wav',  '.mp3': 'audio/mpeg',  '.webp': 'image/webp',
    };
    const prodServer = http.createServer((req, res) => {
      let urlPath = (req.url || '/').split('?')[0];

      // ── Second-instance handoff ────────────────────────────────────────────
      // A second launch can't bind this port, so it POSTs here instead: we come
      // to the front, take any deep link it was carrying, and it exits silently.
      // Checked BEFORE the SPA fallback below, which would otherwise answer
      // this path with index.html.
      //
      // Reachable only from loopback (listen() binds 127.0.0.1), but a web page
      // in any browser on this machine can also reach loopback, so: POST-only,
      // and rejected outright if the request carries the headers a browser
      // always attaches to a cross-site request. Our own second instance sends
      // neither. The capability behind it is "raise a window and hand over a
      // cipherline:// URL", which any local process already has via the
      // registered protocol handler — this adds no new authority, and the invite
      // it can deliver still lands on a modal the user has to accept.
      if (urlPath === FOCUS_ENDPOINT) {
        if (!isTrustedHandoffRequest(req.method, req.headers as Record<string, unknown>)) {
          res.writeHead(403); res.end(); return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_HANDOFF_BODY) { body = ''; req.destroy(); }
        });
        req.on('end', () => {
          showAndFocusWindow(mainWindow);
          const deepLink = decodeHandoffBody(body);
          if (deepLink) {
            const inviteCode = parseInviteUrl(deepLink);
            if (inviteCode) sendDeepLinkInvite(inviteCode);
            else {
              const refCode = parseReferralUrl(deepLink);
              if (refCode) sendDeepLinkRef(refCode);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(handoffResponseBody());
        });
        return;
      }

      let abs = path.join(distDir, urlPath === '/' ? 'index.html' : urlPath);
      // Path-traversal guard
      if (!abs.startsWith(distDir)) { res.writeHead(403); res.end(); return; }
      // SPA fallback — any path that isn't a real file serves index.html
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        abs = path.join(distDir, 'index.html');
      }
      const ext  = path.extname(abs).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      // Set CSP directly on every response from our local server. This is the
      // primary CSP mechanism in production — no dependency on onHeadersReceived.
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Security-Policy': csp,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      fs.createReadStream(abs).pipe(res);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          prodServer.removeListener('error', onError);
          reject(err);
        };
        prodServer.once('error', onError);
        prodServer.listen(CIPHERLINE_PROD_PORT, '127.0.0.1', () => {
          prodServer.removeListener('error', onError);
          resolve();
        });
      });
    } catch (err: any) {
      if (IS_SMOKE_TEST) {
        // In CI smoke test, dialogs would block forever — log and exit instead.
        // Name EADDRINUSE explicitly: the smoke test's only symptom is "no
        // window within 30s", so without this the actual cause never reaches
        // the build log.
        if (err?.code === 'EADDRINUSE') {
          console.error(
            `[Main] smoke test could not bind port ${CIPHERLINE_PROD_PORT} — something else is already using it. ` +
            `If this machine also runs a Cipherline client, that client is on 42917 and should not conflict; ` +
            `check for a stale smoke-test process.`
          );
        } else {
          console.error('[Main] HTTP server failed in smoke test:', err?.message || err);
        }
        app.exit(1);
        return;
      }
      if (err?.code === 'EADDRINUSE') {
        // Almost certainly another Cipherline. Hand this launch over to it —
        // raise its window, pass along any deep link — and disappear without a
        // word. This is what the user wanted by double-clicking the icon.
        const handedOff = await handOffToRunningInstance(CIPHERLINE_PROD_PORT, extractDeepLinkFromArgv(process.argv));
        if (handedOff) {
          console.log('[Main] port held by a running Cipherline — focused it and exiting quietly');
          app.exit(0);
          return;
        }
        // Nothing of ours answered, so the port belongs to some other program.
        // Telling the user "Cipherline is already running" here would be a lie
        // and would send them hunting for a process that doesn't exist.
        dialog.showErrorBox(
          'Cipherline can’t start',
          `Another program on this computer is using port ${CIPHERLINE_PROD_PORT}, which Cipherline needs.\n\n` +
          `Close that program and try again. Cipherline uses a fixed port so your messages and keys stay ` +
          `readable between launches — moving to a different one would lock you out of your own local data.`
        );
      } else {
        dialog.showErrorBox('Failed to start Cipherline', `Internal HTTP server error: ${err?.message || err}`);
      }
      app.quit();
      return;
    }
    console.log(`[Main] Serving dist/ on http://127.0.0.1:${CIPHERLINE_PROD_PORT}/`);
    mainWindow.loadURL(`http://127.0.0.1:${CIPHERLINE_PROD_PORT}/`);
  }

  // Diagnostic listeners
  //
  // did-fail-load fires for FAR more than "the app is broken": every iframe on
  // the page reports through it too, as does any load Chromium cancels or
  // deliberately refuses, and any blip in connectivity. Waking from sleep tears
  // down in-flight requests with ERR_NETWORK_CHANGED (-21), so a modal here
  // meant the Stripe checkout iframe reconnecting after a wake threw a blocking
  // "Load Failure" box at the user about something that isn't their problem and
  // that they can't act on.
  //
  // Benign codes, never worth a dialog:
  //   -3  ERR_ABORTED             — a navigation superseded or cancelled before
  //                                 it finished. Fires on ordinary in-app
  //                                 navigation and on subframe teardown.
  //   -20 ERR_BLOCKED_BY_CLIENT
  //   -27 ERR_BLOCKED_BY_RESPONSE — something the app's own CSP or navigation
  //                                 guard deliberately refused. Working as
  //                                 designed.
  //
  // The one failure genuinely worth interrupting someone over is the app SHELL
  // failing in the main frame — that leaves a blank window with no way out.
  // Even then, try to recover before saying anything: a wake-time blip should
  // heal itself, per the no-manual-refresh goal.
  const BENIGN_ERROR_CODES = new Set([-3, -20, -27]);
  const appShellUrl = url || `http://127.0.0.1:${CIPHERLINE_PROD_PORT}/`;
  const SHELL_RETRY_LIMIT = 5;
  let shellRetries = 0;

  mainWindow.webContents.on('did-finish-load', () => { shellRetries = 0; });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (BENIGN_ERROR_CODES.has(errorCode)) return;

    if (!isMainFrame) {
      console.warn(`[Main] subframe failed to load (ignored): ${validatedURL} — ${errorDescription} (${errorCode})`);
      return;
    }

    console.error(`[Main] Failed to load URL: ${validatedURL}`);
    console.error(`[Main] Error: ${errorDescription} (${errorCode})`);

    // A main-frame navigation somewhere other than our own shell is not a
    // startup failure — nothing to interrupt the user about.
    if (!validatedURL.startsWith(appShellUrl)) return;

    if (shellRetries < SHELL_RETRY_LIMIT) {
      const delay = Math.min(500 * 2 ** shellRetries, 8000);
      shellRetries += 1;
      console.warn(`[Main] shell load failed — retry ${shellRetries}/${SHELL_RETRY_LIMIT} in ${delay}ms`);
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.loadURL(appShellUrl);
      }, delay);
      return;
    }

    // Out of retries: the window is blank and staying that way, so this one
    // does warrant telling the user. (Skipped under the smoke test, where a
    // modal would block the build forever.)
    if (!IS_SMOKE_TEST) {
      dialog.showErrorBox('Load Failure', `Failed to load ${validatedURL}\nError: ${errorDescription} (${errorCode})`);
    }
  });

  // ── Renderer crash recovery ────────────────────────────────────────────
  // Reliability-audit fix: this used to be log + a blocking dialog with NO
  // recovery at all — the user had to manually relaunch the whole app and
  // manually re-navigate/rejoin anything (including a call) from scratch.
  //
  // Recovery is reload-in-place (`webContents.reload()`), not a full window
  // recreate via createWindow(). render-process-gone means the renderer
  // process died — the BrowserWindow shell and its webContents are still
  // alive, so reload() is the minimal, canonical fix: it reuses the exact
  // same window/webContents object and every listener already attached to
  // it (this handler included), with none of a recreate's extra surface
  // (new window bounds/focus/tray-association wiring, reassigning the
  // module-level `mainWindow` reference, redoing whatever depends on it).
  //
  // The reload itself is deferred (setTimeout, not called synchronously
  // from inside this event callback) — a documented Electron footgun:
  // calling loadURL/reload synchronously from inside render-process-gone
  // has caused whole-app crashes on some Electron versions.
  //
  // Crash-loop guard: a crash-on-load bug would otherwise reload forever in
  // a tight loop. Track recent crash timestamps and give up (falling back
  // to the pre-fix dialog) after too many in too short a window, rather
  // than looping indefinitely.
  const recentCrashTimestamps: number[] = [];
  const CRASH_LOOP_WINDOW_MS = 60_000;
  const CRASH_LOOP_THRESHOLD = 3;

  // A renderer that is gone or has navigated (reload) has no call any more:
  // put the gaming-video priority boost back now rather than waiting for a
  // `call:set-media-active false` that will never come.
  mainWindow.webContents.on('did-navigate', () => syncCallPriority({ inCall: false }));
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    console.error(`[Main] Renderer process gone: ${details.reason} (${details.exitCode})`);
    syncCallPriority({ inCall: false });
    // Crash reporter: a pending record the reloaded renderer offers to send.
    // Recording only — the recovery behaviour below is unchanged.
    recordCrash(() => crashFromRenderGone(details, Date.now(), app.getVersion()));

    if (IS_SMOKE_TEST) return; // a dialog/reload loop would hang CI

    const giveUp = shouldGiveUpOnCrashLoop(recentCrashTimestamps, Date.now(), CRASH_LOOP_WINDOW_MS, CRASH_LOOP_THRESHOLD);
    if (giveUp) {
      console.error(`[Main] ${recentCrashTimestamps.length} renderer crashes within ${CRASH_LOOP_WINDOW_MS}ms — giving up on auto-recovery`);
      dialog.showErrorBox('Renderer Process Gone', `Renderer process crashed or was killed.\nReason: ${details.reason}\nExit Code: ${details.exitCode}\n\nCipherline tried to recover automatically but the renderer kept crashing. Please restart the app.`);
      return;
    }

    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      console.warn('[Main] Reloading renderer after crash — any call in progress will need to be rejoined manually.');
      mainWindow.webContents.reload();
    }, 0);
  });
  // Deliberately out of scope: a one-click "rejoin call?" prompt after this
  // recovery reload. It would need a minimal {kind, id} descriptor persisted
  // outside the renderer (the reload wipes React state) plus wiring into
  // three different rejoin paths (DM/group call, voice channel, huddle),
  // each with its own join semantics. That's real surface area for a
  // reliability pass to add, not just harden — the reload itself (call
  // survives if audio/LiveKit's own reconnect logic holds; user manually
  // rejoins if not) is the safe, load-bearing fix. Tracked as a follow-up,
  // not done here.

  // ── Hung (not crashed) renderer detection ──────────────────────────────
  // A frozen main thread (a runaway synchronous loop, a pathological React
  // render) is a DIFFERENT failure mode from a crash — the renderer process
  // is alive, just not responding to input. Surfacing this matters
  // specifically for calls: the audio pipeline (AudioWorklets, the RNNoise/
  // AGC worklets) runs on the browser's dedicated real-time audio thread,
  // isolated from the main thread — a frozen UI does NOT necessarily mean a
  // frozen call. Auto-killing the renderer here would end a perfectly
  // working call over what might just be a UI hang; instead, tell the user
  // and let them decide whether to force a reload.
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Main] Renderer unresponsive');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main:renderer-unresponsive');
    }
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[Main] Renderer responsive again');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main:renderer-responsive');
    }
  });

  // ── Right-click spell-check menu ─────────────────────────────────────
  // Chromium has spell check on by default but Electron doesn't ship a
  // suggestion menu — the user gets red squiggles under typos with no way
  // to fix them. Wire one up: when the user right-clicks inside any
  // editable element, build a context menu from `params.dictionarySuggestions`
  // (Chromium's top suggestions for the misspelled word at the cursor),
  // plus the standard cut/copy/paste actions for any selection.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    // Spelling suggestions for an editable, misspelled word.
    if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        menu.append(new MenuItem({
          label: suggestion,
          click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
        }));
      }
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({
        label: 'Add to dictionary',
        click: () => mainWindow?.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }

    // Standard editing actions — only show when applicable.
    if (params.isEditable) {
      menu.append(new MenuItem({ label: 'Cut',   role: 'cut',   enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ label: 'Copy',  role: 'copy',  enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    } else if (params.selectionText && params.selectionText.trim().length > 0) {
      menu.append(new MenuItem({
        label: 'Copy',
        click: () => clipboard.writeText(params.selectionText),
      }));
    }

    if (menu.items.length > 0) menu.popup({ window: mainWindow! });
  });

  // Performance log: window lifecycle, restore → first frame, hangs, crashes
  // (lifecycle-diagnostics.ts). `window:restored` is the renderer's single,
  // coalesced "I'm visible again" signal.
  windowDiagnostics?.dispose();
  const diag = wireWindowDiagnostics(mainWindow as unknown as Parameters<typeof wireWindowDiagnostics>[0], {
    monitor: freezeMonitor,
    sampleMetrics,
    onRestored: (p) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('window:restored', p);
      }
    },
  });
  windowDiagnostics = diag;
  mainWindow.once('ready-to-show', () => {
    freezeMonitor.event('startup:ready-to-show', Math.round(process.uptime() * 1000), 'ms since process start');
  });
  mainWindow.webContents.once('did-finish-load', () => {
    freezeMonitor.event('startup:did-finish-load', Math.round(process.uptime() * 1000), 'ms since process start');
    // One GPU feature snapshot per session, once things have settled.
    setTimeout(() => {
      try { freezeMonitor.event('gpu:features', 0, summarizeGpuFeatureStatus(app.getGPUFeatureStatus())); } catch { /* unavailable */ }
      sampleMetrics('startup', 0);
    }, 5000).unref();
  });

  mainWindow.on('closed', () => {
    diag.dispose();
    if (windowDiagnostics === diag) windowDiagnostics = null;
    mainWindow = null;
    hideAnnotationOverlay();   // never outlive the window that drives it
  });
}

// ── Deep-link helpers ─────────────────────────────────────────────────────────

/**
 * Parse `cipherline://invite/<CODE>` from a URL string.
 * Returns the invite code, or null if the URL doesn't match.
 */
function parseInviteUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'cipherline:') return null;
    if (u.host !== 'invite') return null;
    const code = u.pathname.replace(/^\/+/, '').trim();
    return code || null;
  } catch {
    return null;
  }
}

/**
 * Parse `cipherline://ref/<CODE>` from a URL string.
 * Returns the referral code, or null if the URL doesn't match.
 */
function parseReferralUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'cipherline:') return null;
    if (u.host !== 'ref') return null;
    const code = u.pathname.replace(/^\/+/, '').trim().toUpperCase();
    return code || null;
  } catch {
    return null;
  }
}

/**
 * Extract the first `cipherline://` deep-link URL from a process.argv array.
 * Electron includes the URL as the last argument on Windows/Linux cold starts.
 */
function extractDeepLinkFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith('cipherline://')) return arg;
  }
  return null;
}

/**
 * Cold-start / race-condition buffer: if the renderer hasn't mounted its
 * IPC listener yet when a deep-link URL arrives, we park the code here and
 * serve it via 'deep-link:get-pending' so App.tsx can pull it on startup.
 */
let pendingDeepLinkCode: string | null = null;
let pendingDeepLinkRef: string | null = null;

/**
 * Send the invite code to the renderer.
 * If the window exists the code is pushed immediately via IPC.
 * If it doesn't (or isn't ready yet) the code is stored in
 * pendingDeepLinkCode and the renderer pulls it via getPendingDeepLinkCode().
 */
function sendDeepLinkInvite(code: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deep-link:invite', code);
    // Also stash so the renderer can recover it if the push arrives before
    // the IPC listener is registered (React useEffect timing race).
    pendingDeepLinkCode = code;
  } else {
    pendingDeepLinkCode = code;
  }
}

/**
 * Send a referral code to the renderer (pre-fills the register form).
 */
function sendDeepLinkRef(code: string) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('deep-link:ref', code);
    pendingDeepLinkRef = code;
  } else {
    pendingDeepLinkRef = code;
  }
}

// Verify that the IPC sender is our renderer (not a rogue frame injected via
// XSS or a malicious iframe). The decision itself lives in ./ipc-guard so it
// can be unit tested without Electron; this is the thin event-shaped adapter.
//
// You should not normally need to call this by hand — installIpcSenderGuard()
// below applies it to every ipcMain registration. The explicit calls left in
// the handlers are belt-and-braces, not the load-bearing control.
function isTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
    return isTrustedSenderUrl(event.senderFrame?.url, DEV_SERVER_URL, CIPHERLINE_PROD_PORT);
}

/**
 * MED-4/5 — make the sender check the DEFAULT, not something a handler author
 * has to remember.
 *
 * Wraps `ipcMain.handle` / `ipcMain.handleOnce` / `ipcMain.on` / `ipcMain.once`
 * so every channel registered from this point on is origin-checked before the
 * real listener ever sees the arguments. This is what stops HIGH-2
 * (`updater:set-channel` shipped with no check, surrounded by 77 handlers that
 * had one) from recurring: forgetting the line is now harmless, and skipping
 * the check deliberately means adding the channel to `UNGUARDED_IPC_CHANNELS`
 * in ipc-guard.ts — which is currently, and verifiably, empty.
 *
 * Installed at module scope, BEFORE this file's first `ipcMain.handle` call and
 * before any module that registers handlers inside a function called later
 * (electron/notifications.ts's `notif:reply-ready` is the only one), so the
 * coverage is total rather than "everything I remembered to move".
 *
 * Failure modes match what the hand-written checks did: `invoke` handlers throw
 * (the renderer's `invoke` promise rejects), fire-and-forget `on` listeners drop
 * the message silently — there is nobody to report an error to.
 *
 * `once`/`handleOnce` are wrapped too even though nothing uses them today, so
 * that reaching for one later is not an accidental hole. Note the one-shot is
 * consumed by a rejected message rather than re-armed: fail-closed (the
 * listener never runs) but not re-usable. If a real `once` consumer ever
 * appears, re-arm on rejection.
 */
// ── Freeze diagnostic (Settings → Advanced → Performance log) ────────────
// Main-process event-loop stalls plus renderer long tasks, with the activity
// that overlapped each one. In memory only; see electron/freeze-monitor.ts.
freezeMonitor.startLoopMonitor();

function installIpcSenderGuard(): void {
    const rawHandle = ipcMain.handle.bind(ipcMain);
    const rawHandleOnce = ipcMain.handleOnce.bind(ipcMain);
    const rawOn = ipcMain.on.bind(ipcMain);
    const rawOnce = ipcMain.once.bind(ipcMain);

    type InvokeListener = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
    type SendListener = (event: Electron.IpcMainEvent, ...args: unknown[]) => void;

    const guardInvoke = (channel: string, listener: InvokeListener): InvokeListener => {
        if (!channelRequiresSenderCheck(channel)) return listener;
        return (event, ...args) => {
            if (!isTrustedSender(event)) {
                console.error(`[Main/IPC] rejected '${channel}' from untrusted sender: ${event.senderFrame?.url ?? '(no url)'}`);
                throw new Error('Untrusted IPC sender');
            }
            return listener(event, ...args);
        };
    };

    const guardSend = (channel: string, listener: SendListener): SendListener => {
        if (!channelRequiresSenderCheck(channel)) return listener;
        return (event, ...args) => {
            if (!isTrustedSender(event)) {
                console.error(`[Main/IPC] dropped '${channel}' from untrusted sender: ${event.senderFrame?.url ?? '(no url)'}`);
                return;
            }
            listener(event, ...args);
        };
    };

    // Every invoke is also a named activity for the freeze log, so a main-
    // process stall is reported as e.g. "ipc:securekv:open" rather than as an
    // anonymous gap. The label is the channel NAME only — never an argument.
    // `perf:*` is excluded so reading the log never shows up in it.
    const tracked = (channel: string, listener: InvokeListener): InvokeListener =>
        channel.startsWith('perf:')
            ? listener
            : (event, ...args) => freezeMonitor.track(`ipc:${channel}`, () => listener(event, ...args));

    ipcMain.handle = ((channel: string, listener: InvokeListener) =>
        rawHandle(channel, tracked(channel, guardInvoke(channel, listener)))) as typeof ipcMain.handle;
    ipcMain.handleOnce = ((channel: string, listener: InvokeListener) =>
        rawHandleOnce(channel, tracked(channel, guardInvoke(channel, listener)))) as typeof ipcMain.handleOnce;
    ipcMain.on = ((channel: string, listener: SendListener) =>
        rawOn(channel, guardSend(channel, listener))) as typeof ipcMain.on;
    ipcMain.once = ((channel: string, listener: SendListener) =>
        rawOnce(channel, guardSend(channel, listener))) as typeof ipcMain.once;
}

installIpcSenderGuard();

// Freeze diagnostic IPC. Read-only for the log, plus a renderer → main push of
// the renderer's own long tasks (re-validated in recordFromRenderer: labels
// must match a strict pattern, so no data-derived string can be stored).
ipcMain.handle('perf:record', (_event, rows: unknown) => freezeMonitor.recordFromRenderer(rows));
ipcMain.handle('perf:get-log', () => freezeMonitor.snapshot());
ipcMain.handle('perf:clear', () => { freezeMonitor.clear(); });

// ── Crash / issue reporter IPC (electron/diagnostics.ts) ─────────────────
// Every channel is origin-checked by installIpcSenderGuard() above. Nothing
// here uploads anything: the renderer builds, scrubs, previews and sends the
// report itself through the authenticated API client.
//
// diag:get-system-info — SystemInfo for a report, plus { homeDir, osUsername }
// which the renderer uses ONLY as scrubber input (never placed in a payload).
ipcMain.handle('diag:get-system-info', async () => {
  let gpuInfo: GpuInfoLike | null = null;
  try { gpuInfo = await app.getGPUInfo('basic') as GpuInfoLike; } catch { gpuInfo = null; }
  let gpuFeatureStatus: Record<string, unknown> | null = null;
  try { gpuFeatureStatus = app.getGPUFeatureStatus() as unknown as Record<string, unknown>; } catch { /* unavailable */ }
  let stored: string | null = null;
  try { stored = secureStore.get('updateChannel'); } catch { /* store not ready */ }
  let displays: Electron.Display[] = [];
  let primaryId: number | null = null;
  try { displays = screen.getAllDisplays(); primaryId = screen.getPrimaryDisplay().id; } catch { /* headless */ }
  const system = buildSystemInfo({
    appVersion: app.getVersion(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpus: os.cpus(),
    totalMemBytes: os.totalmem(),
    gpuInfo,
    gpuFeatureStatus,
    displays,
    primaryDisplayId: primaryId,
    hardwareAcceleration: typeof app.isHardwareAccelerationEnabled === 'function' ? app.isHardwareAccelerationEnabled() : true,
    uptimeS: process.uptime(),
    channel: reportChannel(IS_PACKAGED, stored, app.getVersion()),
  });
  return { system, scrub: { homeDir: os.homedir(), osUsername: safeOsUsername() ?? null } };
});
ipcMain.handle('diag:get-pending-crashes', () => pendingCrashes.all());
// No argument = all; otherwise only the given signatures.
ipcMain.handle('diag:clear-pending-crashes', (_e, signatures: unknown) => { pendingCrashes.remove(parseSignatures(signatures)); });
ipcMain.handle('diag:mark-crashes-seen', (_e, signatures: unknown) => { pendingCrashes.markSeen(parseSignatures(signatures)); });
// The root React error boundary's last words. Untrusted strings, scrubbed
// again here with main's own scrubber before they are stored.
ipcMain.handle('diag:record-renderer-crash', (_e, payload: unknown) => {
  recordCrash(() => crashFromRendererReport(payload, Date.now(), app.getVersion(), diagScrubber()));
});
// "Save to file": main owns the dialog and the path; the renderer supplies
// only the already-scrubbed report text, which is validated (string, ≤ 512 KiB,
// a JSON object) and written verbatim.
ipcMain.handle('diag:save-report', async (_e, category: unknown, content: unknown) => {
  const v = validateReportFile(category, content);
  if (!v.ok) throw new Error(`Invalid report: ${v.error}`);
  const opts: Electron.SaveDialogOptions = {
    title: 'Save diagnostic report',
    defaultPath: path.join(app.getPath('downloads'), defaultReportFileName(v.category, new Date())),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const result = mainWindow && !mainWindow.isDestroyed()
    ? await dialog.showSaveDialog(mainWindow, opts)
    : await dialog.showSaveDialog(opts);
  if (result.canceled || !result.filePath) return { status: 'cancelled' as const };
  await fs.promises.writeFile(result.filePath, v.text, { encoding: 'utf8', mode: 0o600 });
  return { status: 'saved' as const };
});

// ── Performance log: lifecycle + resources (see lifecycle-diagnostics.ts) ──
// Per-process CPU/memory, summed per process TYPE. Throttled so the restore /
// stall / periodic triggers can never stack up into their own load.
let lastMetricsAt = 0;
function sampleMetrics(why: string, minGapMs = 2000): void {
  const t = Date.now();
  if (t - lastMetricsAt < minGapMs) return;
  lastMetricsAt = t;
  try { freezeMonitor.metrics(`${why}: ${summarizeAppMetrics(app.getAppMetrics(), process.memoryUsage())}`); } catch { /* before ready */ }
}
// After a long main stall, record what every process was doing right then.
let lastStallMetricsAt = 0;
freezeMonitor.onStall = (ms) => {
  if (ms < 1000 || Date.now() - lastStallMetricsAt < 5000) return;
  lastStallMetricsAt = Date.now();
  sampleMetrics('after-stall', 0);
};
// "Run a 60-second freeze capture" (Settings → Advanced → Performance log):
// main stalls from 100 ms, metrics every 2 s, then back to normal.
let captureTimer: ReturnType<typeof setInterval> | null = null;
ipcMain.handle('perf:start-capture', (_e, ms: unknown) => {
  const dur = typeof ms === 'number' && Number.isFinite(ms) ? Math.min(Math.max(ms, 5000), 5 * 60_000) : 60_000;
  freezeMonitor.startCapture(dur);
  sampleMetrics('capture', 0);
  if (captureTimer) clearInterval(captureTimer);
  const until = Date.now() + dur;
  captureTimer = setInterval(() => {
    if (Date.now() >= until) {
      if (captureTimer) clearInterval(captureTimer);
      captureTimer = null;
      freezeMonitor.event('capture:end');
      sampleMetrics('capture', 0);
      return;
    }
    sampleMetrics('capture', 0);
  }, 2000);
});
// Restore → next painted frame: the preload answers main's ping after two
// animation frames (see preload.ts and wireWindowDiagnostics).
let windowDiagnostics: ReturnType<typeof wireWindowDiagnostics> | null = null;
ipcMain.on('perf:frame-pong', (_e, id: unknown) => {
  if (typeof id === 'number') windowDiagnostics?.onFramePong(id);
});

// One coalesced picture of sleep/lock/wake (see power-events.ts). The
// powerMonitor listeners are attached once the app is ready.
const power = new PowerCoordinator((p) => {
  freezeMonitor.event('power:resumed-notify', 0, `reason=${p.reason} asleep=${p.asleepMs ?? 'none'} locked=${p.lockedMs ?? 'none'}`);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('power:resumed', p);
  }
});
power.onPhase((phase) => {
  if (phase === 'suspend') {
    freezeMonitor.pause();
    // Nothing written-behind may be lost to a battery dying in sleep.
    try { secureStore.flush(); } catch { /* logged by the store */ }
  } else {
    freezeMonitor.unpause();
  }
});
freezeMonitor.onClockJump = (ms) => power.noteClockJump(ms);

// Renderer pulls any pending deep-link code on startup — clears on first read.
ipcMain.handle('deep-link:get-pending', () => {
  const code = pendingDeepLinkCode;
  pendingDeepLinkCode = null;
  return code;
});

// Renderer pulls any pending referral code on startup — clears on first read.
ipcMain.handle('deep-link:get-pending-ref', () => {
  const code = pendingDeepLinkRef;
  pendingDeepLinkRef = null;
  return code;
});

// First-launch install hand-off. The referral / server-invite landing pages copy
// their own link to the clipboard when a visitor without Cipherline clicks "Get
// Cipherline"; the sign-in screen asks this ONCE per install whether such a link
// is waiting. The answer is only ever one of OUR links (strictly matched in
// attribution-link.ts) — never raw clipboard text — and the renderer shows it and
// asks before using it. Read-only: the clipboard is not modified. Like every
// handler here it passes the global IPC sender guard.
ipcMain.handle('attribution:peek-clipboard', () => {
  try {
    return parseAttributionClipboard(clipboard.readText());
  } catch {
    return null;
  }
});

// Register as the default handler for the cipherline:// URI scheme.
// On macOS this must happen before app.whenReady.
//
// `process.defaultApp` is true only when launched unpackaged (`electron .`,
// i.e. `npm run dev:windows`) — in that mode the 1-arg form registers the
// bare `electron.exe` with NO app-path argument, so Windows has nothing to
// actually launch when the scheme is invoked (observed: the browser shows
// no protocol-handler prompt at all, not even a failed one, because nothing
// usable was ever registered). The 3-arg form makes the registry command
// `electron.exe <app-path> "%1"` instead, matching what a packaged build's
// single-exe registration does implicitly.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('cipherline', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('cipherline');
}

// macOS: the OS delivers the URL via open-url when the app is already running.
app.on('open-url', (event, url) => {
  event.preventDefault();
  const inviteCode = parseInviteUrl(url);
  if (inviteCode) { sendDeepLinkInvite(inviteCode); return; }
  const refCode = parseReferralUrl(url);
  if (refCode) sendDeepLinkRef(refCode);
});

// Single-instance lock — required because we bind the prod HTTP server to
// a fixed port. A second launch would collide on EADDRINUSE. Instead we
// quietly quit the second copy and focus the existing window.
// In CI smoke-test mode skip the lock entirely — there is only ever one
// instance and Electron's mutex can fail on fresh Windows runners, which
// makes requestSingleInstanceLock() return false and triggers app.quit()
// before app.ready fires, causing electron.launch() to time out.
const gotInstanceLock = IS_SMOKE_TEST
  ? true
  : app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  process.stderr.write('[Main] single-instance lock not acquired — quitting\n');
  // app.quit() alone isn't enough here: it schedules the normal async quit
  // sequence, but app.whenReady().then(...) is registered later in this
  // same file (unconditionally) and can still fire before that sequence
  // completes — this losing instance would then race through startup and
  // hit the prod HTTP server's real EADDRINUSE port conflict. That path is no
  // longer user-visible (it now hands off and exits quietly — see
  // handOffToRunningInstance), but racing to it is still pure waste: the
  // primary's second-instance handler below has already raised the window.
  // app.exit() is a hard, synchronous stop — nothing after this line runs,
  // including that whenReady() callback.
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows/Linux: the URL is appended to argv by the OS.
    const url = extractDeepLinkFromArgv(argv);

    // Shared raise sequence — the plain restore/show/focus this used to do
    // leaves the window behind the foreground app on Windows, so a second
    // launch looked like it did nothing at all.
    showAndFocusWindow(mainWindow);

    if (url) {
      const inviteCode = parseInviteUrl(url);
      if (inviteCode) { sendDeepLinkInvite(inviteCode); return; }
      const refCode = parseReferralUrl(url);
      if (refCode) sendDeepLinkRef(refCode);
    }
  });
}

// ── Installer splash (first install / post-update only) ──────────────────
// A frameless window that plays the "Key Spinner" → "You're in." animation
// while the main window is built up hidden behind it. Shown only when the
// stored version marker differs from the running version (fresh install or
// update), never on a normal launch, and never under the CI smoke test.
// Driven entirely from the main process via executeJavaScript — no preload,
// so it keeps the secure sandbox defaults.
let installerSplash: BrowserWindow | null = null;
let splashReady = false;       // splash webContents finished loading
let splashLatestPct = 0;       // highest target % seen (queued until ready)
let installerFinalized = false;
let pendingMainMaximize = false; // restore maximised state once the window is shown

function versionMarkerPath(): string {
  return path.join(app.getPath('userData'), '.cl-installed-version');
}

function markVersionInstalled(): void {
  try {
    fs.writeFileSync(versionMarkerPath(), app.getVersion(), 'utf8');
  } catch (e) {
    console.warn('[Installer] could not write version marker:', e);
  }
}

function createInstallerSplash(isUpdate: boolean): BrowserWindow {
  const splash = new BrowserWindow({
    width: 560,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    // Transparent so the card's border-radius + box-shadow render against the
    // desktop instead of a hard-edged opaque rectangle.
    transparent: true,
    backgroundColor: '#00000000',
    center: true,
    title: 'Cipherline',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  splash.removeMenu();
  const html = installerSplashHtml(app.getVersion(), isUpdate);
  // Write to a temp file so the page loads with a file:// origin — loading as a
  // data: URL gives it a null opaque origin, which Chromium blocks @import
  // requests from (Google Fonts never load, breaking the design).
  const tmpPath = path.join(os.tmpdir(), `cipherline-installer-${process.pid}.html`);
  fs.writeFileSync(tmpPath, html, 'utf8');
  splash.loadFile(tmpPath);
  splash.webContents.on('did-finish-load', () => {
    splashReady = true;
    splashSendProgress(splashLatestPct);
    fs.unlink(tmpPath, () => {});
  });
  return splash;
}

function splashSendProgress(pct: number): void {
  splashLatestPct = Math.max(splashLatestPct, pct);
  if (!splashReady || !installerSplash || installerSplash.isDestroyed()) return;
  installerSplash.webContents
    .executeJavaScript(`window.clProgress && window.clProgress(${splashLatestPct})`)
    .catch(() => { /* window may be closing */ });
}

interface Bounds { x: number; y: number; width: number; height: number; }

// Tween a window's bounds from → to over durationMs (easeOutCubic), ~60fps via
// setBounds. Electron has no native cross-platform resize animation, so we step
// it manually. Calls onDone when finished (or immediately if the window dies).
function animateWindowBounds(
  win: BrowserWindow, from: Bounds, to: Bounds, durationMs: number, onDone: () => void,
): void {
  const start = Date.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = () => {
    if (!win || win.isDestroyed()) { onDone(); return; }
    const t = Math.min(1, (Date.now() - start) / durationMs);
    const e = ease(t);
    try {
      win.setBounds({
        x: Math.round(from.x + (to.x - from.x) * e),
        y: Math.round(from.y + (to.y - from.y) * e),
        width: Math.round(from.width + (to.width - from.width) * e),
        height: Math.round(from.height + (to.height - from.height) * e),
      });
    } catch { /* window may be closing */ }
    if (t < 1) setTimeout(step, 16);
    else onDone();
  };
  step();
}

// Fires the completion animation, holds on "You're in." for a beat, then grows
// the splash window into the main window's target footprint and reveals the app.
function finalizeInstaller(): void {
  if (installerFinalized) return;
  installerFinalized = true;
  splashSendProgress(99);
  if (installerSplash && !installerSplash.isDestroyed() && splashReady) {
    installerSplash.webContents
      .executeJavaScript('window.clComplete && window.clComplete()')
      .catch(() => { /* ignore */ });
  }

  const revealMain = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // When launched from the stub installer, briefly pin the window to the
      // topmost Z-order (HWND_TOPMOST) so it appears above any existing
      // foreground app without needing SetForegroundWindow permission.
      // AllowSetForegroundWindow alone is insufficient because its grant is
      // revoked the moment the stub process exits and cedes the foreground.
      const fromStub = process.argv.includes('--fresh-install');
      if (fromStub) mainWindow.setAlwaysOnTop(true);
      mainWindow.show();
      // Re-assert the restored maximised state now that the window is visible
      // (maximise() applied while hidden can be dropped on show()).
      if (pendingMainMaximize) { mainWindow.maximize(); pendingMainMaximize = false; }
      mainWindow.focus();
      if (fromStub) setTimeout(() => mainWindow?.setAlwaysOnTop(false), 300);
    }
    if (installerSplash && !installerSplash.isDestroyed()) installerSplash.close();
    installerSplash = null;
  };

  setTimeout(() => {
    markVersionInstalled();
    const splash = installerSplash;
    const main = mainWindow;
    // No splash, dead window, or a maximised target → just reveal (no grow:
    // animating toward a maximised/fullscreen footprint reads oddly).
    if (!splash || splash.isDestroyed() || !main || main.isDestroyed() || pendingMainMaximize) {
      revealMain();
      return;
    }
    // Grow the splash from screen-centre to the target SIZE (kept centred on
    // its display), dissolving the card as it expands; then, only if the final
    // geometry is off-centre (e.g. a restored update position), glide it into
    // place before revealing the app. Both windows share the abyss background,
    // so the hand-off is seamless.
    try { splash.setResizable(true); } catch { /* ignore */ }
    splash.webContents.executeJavaScript('window.clDissolve && window.clDissolve()').catch(() => {});
    const startB = splash.getBounds();
    const targetB = main.getBounds();
    const wa = screen.getDisplayMatching(startB).workArea;
    const centredGrown: Bounds = {
      width: targetB.width,
      height: targetB.height,
      x: Math.round(wa.x + (wa.width - targetB.width) / 2),
      y: Math.round(wa.y + (wa.height - targetB.height) / 2),
    };
    const needsSettle = Math.abs(centredGrown.x - targetB.x) > 2 || Math.abs(centredGrown.y - targetB.y) > 2;
    animateWindowBounds(splash, startB, centredGrown, 420, () => {
      if (needsSettle && !splash.isDestroyed()) {
        animateWindowBounds(splash, centredGrown, targetB, 260, revealMain);
      } else {
        revealMain();
      }
    });
  }, 1000);
}

// Gates finalization on the two real startup milestones (secure store ready +
// main-window renderer painted), with a minimum on-screen time so the
// completion animation always reads, and a safety timeout so a stuck milestone
// can never leave the user staring at the splash forever.
function makeInstallerGate(startTs: number) {
  const MIN_VISIBLE_MS = 1900;
  const SAFETY_MS = 20_000;
  const done = { store: false, renderer: false };
  const safety = setTimeout(() => {
    console.warn('[Installer] safety timeout reached — finalizing splash');
    finalizeInstaller();
  }, SAFETY_MS);
  const maybeFinish = () => {
    if (!done.store || !done.renderer) return;
    clearTimeout(safety);
    const wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startTs));
    setTimeout(finalizeInstaller, wait);
  };
  return {
    storeDone: () => { done.store = true; maybeFinish(); },
    rendererDone: () => { done.renderer = true; maybeFinish(); },
  };
}

// Use stderr here because stdout may be buffered and Playwright captures
// stderr synchronously — this confirms module loading completed.
process.stderr.write('[Main] module loaded — waiting for app.ready\n');

app.whenReady().then(async () => {
  process.stderr.write('[Main] app.ready fired\n');
  console.log('[Main] app ready — starting initialization');
  freezeMonitor.event('startup:app-ready', Math.round(process.uptime() * 1000), 'ms since process start');
  // A GPU / network / audio service process dying is invisible to the user
  // except as a freeze or a black window — record it (type + reason only).
  app.on('child-process-gone', (_e, details) => {
    freezeMonitor.event('process:gone', 0, describeChildProcessGone(details));
    sampleMetrics('process-gone', 0);
    // Crash reporter: GPU / Utility / … deaths with a crash reason only.
    recordCrash(() => crashFromChildGone(details, Date.now(), app.getVersion()));
  });
  // macOS / Linux OS shutdown: a clean end of the session, not a crash.
  powerMonitor.on('shutdown', () => endSessionMarker());
  // Resource snapshot every 15 s while the window is on screen (nothing while
  // minimized / in the tray — the log is about what the user sees).
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
      sampleMetrics('periodic', 10_000);
    }
  }, 15_000).unref();
  // Remember the GPU layout for NEXT launch's Automatic screen capturer
  // (decideAutoScreenCapturer). Vendors + Chromium's hybrid flag only; the
  // file is rewritten only when the layout changed. Fire-and-forget: it can
  // never delay or fail startup.
  if (process.platform === 'win32' && !IS_SMOKE_TEST) {
    void app.getGPUInfo('basic').then(info => {
      const hint = gpuTopologyFromInfo(info);
      if (!hint) return;
      const text = serializeGpuTopologyHint(hint);
      if (GPU_TOPOLOGY_AT_START && serializeGpuTopologyHint(GPU_TOPOLOGY_AT_START) === text) return;
      return fs.promises.writeFile(GPU_TOPOLOGY_PATH, text, { mode: 0o600 });
    }).catch(() => { /* next launch just keeps Chromium's default */ });
  }
  try {
  // ── Decide whether to play the installer splash ─────────────────────────
  // Show it on a fresh install or after an update (running version differs
  // from the marker written on the last successful boot), never on a normal
  // launch, and never under the CI smoke test (which grabs firstWindow() and
  // would screenshot/close the splash instead of the auth screen).
  const isSmokeTest = IS_SMOKE_TEST;
  let prevInstalledVersion = '';
  try { prevInstalledVersion = fs.readFileSync(versionMarkerPath(), 'utf8').trim(); } catch { /* no marker yet */ }
  let showInstaller = !isSmokeTest && prevInstalledVersion !== app.getVersion();
  let installerGate: ReturnType<typeof makeInstallerGate> | null = null;
  if (showInstaller) {
    try {
      // A populated marker means a prior version was installed → this is an
      // update; an empty marker means a fresh first install.
      installerSplash = createInstallerSplash(prevInstalledVersion !== '');
      installerGate = makeInstallerGate(Date.now());
      splashSendProgress(8);
    } catch (e) {
      // If the splash can't be created, fall back to showing the app normally
      // rather than leaving the user with a permanently hidden window.
      console.warn('[Installer] splash creation failed — booting normally:', e);
      installerSplash = null;
      installerGate = null;
      showInstaller = false;
    }
  }

  // Load the native audio capture addon AFTER app.whenReady() so Electron's COM
  // apartment and Chromium audio subsystems are fully initialized first.
  // Loading it at module scope caused STATUS_BREAKPOINT crashes in dev mode because
  // mmdevapi.dll's DllMain ran before Chromium had set up its COM context.
  try {
    audioCaptureAddon = require(path.join(__dirname, '../build/Release/audio_capture.node'));
    console.log('[Main] Native audio capture addon loaded successfully.');
    // The same addon carries the annotation overlay's display/window geometry
    // (src-native/window_geometry.cc on Windows, window_geometry_mac.mm on
    // macOS); an older build simply lacks it.
    setAnnotationOverlayNative(audioCaptureAddon);
  } catch (e: any) {
    const addonPath = path.join(__dirname, '../build/Release/audio_capture.node');
    console.warn(`[Main] Native audio capture addon NOT loaded — screenshare will fall back to Chromium loopback.`);
    console.warn(`[Main]   Path attempted: ${addonPath}`);
    console.warn(`[Main]   Reason: ${e.message}`);
    console.warn(`[Main]   Fix: run "npm run rebuild-native" (Windows, MSVC) or "npm run rebuild-native:mac" (macOS, Xcode) inside apps/desktop/`);
  }

  // Kick off SecureStore initialization. It genuinely runs in the background
  // now: _doInitialize() awaits real yield points, so the main-process message
  // loop keeps pumping (splash animation, input, window work) between its
  // blocking phases instead of being held for the whole of it.
  //
  // It did NOT used to. The function was `async` with no `await` anywhere in
  // its body, so it ran to completion synchronously on this stack and only
  // handed back an already-settled promise — this comment previously claimed
  // "window creation is not gated on safeStorage.encryptString()", which was
  // the intention rather than the behaviour. The thread it blocked owns the
  // window HWND; that is what Windows renders as "(Not Responding)", and on a
  // first launch after install the splash is already up, so the freeze is what
  // the user watches. CI cannot catch this — _doInitialize() short-circuits on
  // CIPHERLINE_SMOKE_TEST, so the 30s smoke gate never runs the real path.
  //
  // What is still ordered: everything from the updater block down (it reads
  // `updateChannel`) waits on `storeReady` explicitly, so createWindow() is
  // reached in the same order as before — the difference is that the ~2200
  // lines of IPC registration between here and there now overlap with init
  // instead of following it, and the thread stays responsive throughout.
  //
  // SecureStore.initialize() is promise-idempotent, so signal-identity.ts
  // calling it again in migrateSpkPubIfMissing() gets the same in-flight promise.
  if (showInstaller) splashSendProgress(24);
  const storeReady = freezeMonitor.track('startup:securestore', () => secureStore.initialize());
  storeReady
    .then(() => {
      console.log('[Main] secureStore initialized');
      // Pending crash records go to the encrypted store from here on (and the
      // ones captured during startup are merged in). Not under the smoke test
      // (its store is pathless — CLAUDE.md), and not while locked.
      if (!IS_SMOKE_TEST && secureStore.status() === 'ok') {
        pendingCrashes.attach({
          read: () => secureStore.get('diag_pending_crashes'),
          write: (v) => secureStore.set('diag_pending_crashes', v),
          clear: () => secureStore.delete('diag_pending_crashes'),
        });
      }
      if (showInstaller) { splashSendProgress(58); installerGate?.storeDone(); }
    })
    .catch(err => {
      console.error('[Main] secureStore initialization failed:', err);
      // Don't strand the splash on a store failure — let renderer-ready drive it.
      if (showInstaller) installerGate?.storeDone();
    });

  // ── Content-Security-Policy ───────────────────────────────────────────
  // Strict CSP attached to every response the renderer receives. The
  // `connect-src` allowlist mirrors the three production subdomains plus
  // (in dev) the Vite dev server so HMR works. Any attempt by a supply-
  // chain attacker to exfiltrate to a third-party host is blocked at the
  // browser level.
  const devServer = DEV_SERVER_URL || '';
  const devWs = devServer.replace(/^http/, 'ws');
  const isDev = !!devServer;
  const scriptExtra = isDev ? " 'unsafe-eval' 'unsafe-inline'" : '';
  // constants.ts documents VITE_API_HOST as a supported override for pointing
  // the renderer's API_BASE somewhere other than the two hardcoded prod/
  // staging hosts below — e.g. `localhost:3005` to reach a docker-compose
  // stack running directly on this box instead of through Windows+Caddy.
  // Without this, that override is silently broken: the renderer resolves
  // the URL fine, but connect-src blocks the actual request. Restricted to
  // loopback targets only (never an arbitrary env-controlled host) and gated
  // on isDev like every other relaxation here, so this never reaches a
  // packaged build.
  const apiHostOverride = process.env.VITE_API_HOST || '';
  const apiExtra = isDev && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiHostOverride)
    ? ` http://${apiHostOverride} ws://${apiHostOverride}`
    : '';
  const connectExtra = isDev ? ` ${devServer} ${devWs}${apiExtra}` : '';
  // KLIPY GIF search (opt-in, off by default — src/utils/klipy.ts). EXACT
  // hosts only, never a wildcard: the API host for fetch (connect-src) and
  // KLIPY's three documented media hosts for <img> (img-src). No media-src —
  // only GIF/WebP renditions are used, and those render in <img>. Must match
  // KLIPY_API_HOST / KLIPY_MEDIA_HOSTS in packages/shared/klipy.ts; the test
  // src/utils/klipyHosts.test.ts pins both this list and that equality.
  const KLIPY_CSP_CONNECT = 'https://api.klipy.com';
  const KLIPY_CSP_IMG = 'https://static.klipy.com https://static1.klipy.com https://static2.klipy.com';
  const csp = [
    "default-src 'self'",
    // blob: needed for AudioWorklet modules — voiceProcessor.ts builds the
    // RNNoise + gate worklet sources into Blob URLs and loads them via
    // audioContext.audioWorklet.addModule(blobUrl), which Chromium classifies
    // as a script load. Without blob: here the worklets fail with
    // "AudioWorkletNode cannot be created: The node name 'rnnoise-worklet' is
    // not defined" because the module never loaded.
    //
    // 'wasm-unsafe-eval' is needed because rnnoise.worker.ts compiles a
    // WebAssembly module at runtime (WebAssembly.instantiate()) and Chromium
    // gates that behind script-src. Unlike 'unsafe-eval' this token only
    // enables WASM — it does NOT re-enable eval(), new Function(), or other
    // dynamic code-string execution. Safe and the documented minimum for WASM.
    // No Google origin here: the Drive backup folder browser is our own UI
    // (src/components/DriveFolderPicker.tsx) calling the Drive REST API over
    // fetch, so nothing loads Google-hosted script. If the Google Picker widget
    // is ever brought back it needs https://apis.google.com here AND
    // docs/drive.google.com in frame-src below.
    // https://js.stripe.com — Stripe.js for the in-app Payment Element (card data
    // stays inside Stripe's iframe; we never see a PAN).
    // https://challenges.cloudflare.com — Turnstile widget script.
    `script-src 'self' blob: 'wasm-unsafe-eval' https://js.stripe.com https://challenges.cloudflare.com${scriptExtra}`,
    // Tailwind + emoji-mart inject inline styles at runtime.
    // Google Fonts CSS (loaded via @import in index.css) counts as a stylesheet load — must be in style-src.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    // Prod endpoints: api (HTTPS + WSS), media (HTTPS), rtc (WSS + HTTPS).
    // rtc needs BOTH schemes: the WSS is the actual room connection, but
    // livekit-client's retry/reconnect path does an HTTP GET to
    // /rtc/v1/validate on the same host as a connectivity preflight before
    // re-opening the WebSocket. That call only fires on a RECONNECT, never on
    // a clean first connect — so a room that connects cleanly the first time
    // never exercises it, and this was invisible until a real reconnect
    // attempt hit it. Without https: here, that preflight was silently
    // blocked by this very policy, turning what should be an automatic
    // recovery from one dropped connection into a permanent "can't connect"
    // for the rest of the call.
    // blob: needed so FileViewer.tsx can fetch(objectUrl) to parse xlsx/mammoth
    // — Chromium classifies fetch() on a blob: URL as a connect-src check.
    // *.googleapis.com — Google Drive REST: backup upload/download plus the
    // in-app folder browser's files.list / files.create calls.
    // accounts.google.com — Google auth handshake.
    // api.stripe.com / m.stripe.network — Stripe.js client API + metrics for the
    // in-app Payment Element.
    `connect-src 'self' blob: https://api.cipherline.chat wss://api.cipherline.chat https://api-staging.cipherline.chat wss://api-staging.cipherline.chat https://media.cipherline.chat https://rtc.cipherline.chat wss://rtc.cipherline.chat https://tenor.googleapis.com https://www.googleapis.com https://*.googleapis.com https://accounts.google.com https://api.stripe.com https://m.stripe.network https://challenges.cloudflare.com ${KLIPY_CSP_CONNECT}${connectExtra}`,
    // Images: own attachments via media subdomain + Google Picker
    // thumbnails/icons + Stripe brand glyphs.
    // https://*.stripe.com — card-brand / Link glyphs in the Payment Element.
    //
    // CORRECTION (this file, image-inline-display work): earlier revisions of
    // this policy carried `https://*.giphy.com https://*.tenor.com
    // https://media.tenor.com` on the theory that this img-src was what the
    // chat's "Load image" click-to-load card needed. That was wrong — verified
    // by reading the actual path: ChatPane.tsx's `ImageLinkEmbed` never puts a
    // remote URL in an `<img src>`. It calls `window.electronAPI.fetchBinary`
    // → IPC `net:fetch-binary` → `fetchImagePinned` below, which fetches with
    // Node `https.request` in THIS (main) process — a renderer-CSP-exempt
    // path — then hands the renderer a `data:`/base64 payload it turns into a
    // `blob:` object URL. The `<img>`/`<GifPlayer>` element only ever renders
    // that `blob:` URL, already covered by `blob:` above. So this img-src
    // directive was never in the loop for that flow, and the giphy/tenor
    // entries did nothing; removed rather than left as dead, misleading
    // allowlist entries. The real gate on which remote hosts get fetched
    // automatically (vs. requiring a click) is host-based and lives in
    // src/utils/imageHosts.ts + usePrivacySettings' `imageAutoLoad` — a CSP
    // change is neither necessary nor sufficient for it.
    `img-src 'self' data: blob: https://media.cipherline.chat https://*.googleusercontent.com https://*.gstatic.com https://ssl.gstatic.com https://*.stripe.com ${KLIPY_CSP_IMG}`,
    "media-src 'self' blob:",
    "font-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com data:",
    // Inline PDF preview uses <embed type="application/pdf" src="blob:…"> in
    // FileViewer.tsx. object-src governs <embed>/<object>; without blob: here
    // Chromium blocks the PDF plugin with a generic "blocked by CSP" error.
    "object-src 'self' blob:",
    // Some dynamic-import chunks (xlsx, mammoth, PDF.js if we switch) spawn
    // Web Workers from blob: URLs. Without worker-src this falls back to
    // script-src which doesn't include blob:, and the worker silently fails.
    "worker-src 'self' blob:",
    // youtube-nocookie.com for privacy-preserving YouTube embeds in chat messages.
    // blob: because Chromium's built-in PDF viewer renders <embed type="application/pdf">
    // as a frame (even though <embed> is an object tag) — without blob: here, PDF
    // previews fail with "Refused to frame 'blob:…'" despite object-src allowing blob:.
    // docs/drive.google.com are NOT listed: nothing frames Google any more now
    // that the backup folder browser is our own UI rather than the Google
    // Picker widget. accounts.google.com stays for the OAuth handshake.
    // js.stripe.com — Payment Element iframe; hooks.stripe.com — 3DS challenge frame.
    // https://cipherline.chat — the website-hosted Turnstile page (turnstile-embed.html)
    // the sign-up form embeds; Cloudflare rejects 127.0.0.1 as a widget hostname, so the
    // widget runs there (components/TurnstileFrame.tsx). challenges.cloudflare.com — the
    // widget's own iframe.
    "frame-src https://www.youtube-nocookie.com blob: https://accounts.google.com https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com https://cipherline.chat",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  // Only inject the CSP onto our own app responses (Vite HTTP in dev,
  // local HTTP server in prod). We use <all_urls> as the filter and gate
  // on the URL inside the callback — Electron's webRequest does not support
  // port wildcards (http://127.0.0.1:*/*), so we can't express "any loopback
  // port" as a filter string. The explicit check is cheap and correct.
  const devOrigin = devServer.replace(/\/$/, '');
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      const isOwnUrl = isDev
        ? details.url.startsWith(devOrigin)
        : details.url.startsWith('http://127.0.0.1:');
      if (!isOwnUrl) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [csp],
          'X-Content-Type-Options': ['nosniff'],
          'Referrer-Policy': ['no-referrer'],
        },
      });
    },
  );

  // Pose as stock Chrome for YouTube requests. YouTube's embed player returns
  // error 153 ("video player configuration error") when it detects Electron or
  // non-standard Client Hints. Stripping just "Electron/X.X.X" wasn't enough —
  // YouTube also sniffs Sec-Ch-Ua and the full UA shape. We replace the UA
  // wholesale with a stock Chrome string matching Electron's underlying
  // Chromium major, and rewrite the Sec-Ch-Ua client hints to match.
  const chromeMajor = (process.versions.chrome || '').split('.')[0] || '134';
  // Match the masquerade UA to the actual host platform — YouTube cross-checks
  // UA, Sec-Ch-Ua-Platform, and TLS/JA3 fingerprints. A Windows UA on a macOS
  // host is more suspicious than a darwin UA on a darwin host.
  const uaPlatformTuple =
    process.platform === 'darwin'
      ? { ua: '(Macintosh; Intel Mac OS X 10_15_7)', hint: '"macOS"' }
      : process.platform === 'linux'
        ? { ua: '(X11; Linux x86_64)', hint: '"Linux"' }
        : { ua: '(Windows NT 10.0; Win64; x64)', hint: '"Windows"' };
  const stockChromeUA =
    `Mozilla/5.0 ${uaPlatformTuple.ua} AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  const stockSecChUa =
    `"Chromium";v="${chromeMajor}", "Not=A?Brand";v="24", "Google Chrome";v="${chromeMajor}"`;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.youtube-nocookie.com/*', '*://*.youtube.com/*', '*://*.googlevideo.com/*', '*://*.ytimg.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      headers['User-Agent'] = stockChromeUA;
      if ('Sec-Ch-Ua' in headers) headers['Sec-Ch-Ua'] = stockSecChUa;
      if ('sec-ch-ua' in headers) headers['sec-ch-ua'] = stockSecChUa;
      if ('Sec-Ch-Ua-Mobile' in headers) headers['Sec-Ch-Ua-Mobile'] = '?0';
      if ('Sec-Ch-Ua-Platform' in headers) headers['Sec-Ch-Ua-Platform'] = uaPlatformTuple.hint;
      callback({ requestHeaders: headers });
    },
  );

  // Populate signed_prekey_pub if missing (upgrade from pre-E2EE builds).
  // Fire-and-forget: this awaits storeReady internally, so it runs only after
  // the store is initialized. The renderer needs SPK data only after login —
  // long after startup — so delaying this migration is harmless.
  migrateSpkPubIfMissing()
    .then(() => { if (showInstaller) splashSendProgress(72); })
    .catch(e => console.warn('[Main] SPK migration skipped:', e));

  // Window control IPC (used by custom React titlebar on Windows/Linux)
  ipcMain.on('win:minimize', () => mainWindow?.minimize());
  ipcMain.on('win:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('win:close', () => mainWindow?.close());
  ipcMain.handle('win:is-maximized', () => mainWindow?.isMaximized() ?? false);
  // Screen-capture protection (privacy setting). Renderer pushes the
  // persisted preference on startup and whenever the toggle flips.
  ipcMain.on('win:set-content-protection', (_e, enabled: boolean) => {
    try { mainWindow?.setContentProtection(!!enabled); } catch { /* older Electron */ }
  });
  // NOTE: maximize/unmaximize event listeners are registered inside createWindow()
  // after mainWindow is assigned (P2-ELEC-8: optional-chain here would no-op on null).

  // ── System behavior settings ──────────────────────────────────────────────
  // "Start with Windows" uses the OS login-item API; "start minimized" and
  // "minimize to tray" are persisted in secureStore (simple string flags).

  ipcMain.handle('app:get-start-with-windows', () => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return false;
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('app:set-start-with-windows', (_e, enabled: boolean) => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return;
    // `--autostart` marks login-item launches so startup can tell them apart
    // from the user double-clicking the app: only login launches honor the
    // start-minimized preference. (macOS ignores `args`; detection there uses
    // getLoginItemSettings().wasOpenedAtLogin instead.)
    app.setLoginItemSettings(enabled ? { openAtLogin: true, args: ['--autostart'] } : { openAtLogin: false });
  });

  ipcMain.handle('app:get-start-minimized', () => {
    // Default ON: the preference now means "minimized when auto-started at
    // login" (manual launches always show the window), and a quiet login
    // launch is the behavior people expect from that. Only an explicit
    // 'false' (user flipped the toggle off) disables it.
    return secureStore.get('startMinimized') !== 'false';
  });
  ipcMain.handle('app:set-start-minimized', (_e, enabled: boolean) => {
    secureStore.set('startMinimized', enabled ? 'true' : 'false');
  });

  ipcMain.handle('app:get-minimize-to-tray', () => {
    return secureStore.get('minimizeToTray') === 'true';
  });
  ipcMain.handle('app:set-minimize-to-tray', (_e, enabled: boolean) => {
    secureStore.set('minimizeToTray', enabled ? 'true' : 'false');
    updateTray(!!enabled);
  });

  // navigator.clipboard.readText() in the renderer requires a browser-trust
  // user-gesture that Electron doesn't reliably grant on window-focus events.
  // Reading via the main-process clipboard module has no such restriction.
  ipcMain.handle('clipboard:read', () => { return clipboard.readText(); });
  ipcMain.handle('clipboard:write', (_event, text: string) => { clipboard.writeText(text); });

  // ── Official-client attestation signer ──────────────────────────────────
  // The HMAC secret is injected into the official release build (CI →
  // electron-builder extraMetadata.clientAttestSecret), so it lives in the
  // packaged package.json, NOT the renderer bundle. Dev/forks have no secret →
  // returns null and the server (with CLIENT_ATTEST_SECRETS empty) doesn't care.
  // This is deterrence, not a guarantee — the secret is extractable from the
  // binary; the server still enforces all entitlements regardless of client.
  const ATTEST_SECRET: string = (() => {
    if (process.env.CLIENT_ATTEST_SECRET) return process.env.CLIENT_ATTEST_SECRET; // dev override
    try {
      const pkg = require(path.join(app.getAppPath(), 'package.json'));
      if (pkg && typeof pkg.clientAttestSecret === 'string') return pkg.clientAttestSecret;
    } catch { /* not packaged / no injected secret */ }
    return '';
  })();

  ipcMain.handle('attest:sign', () => {
    if (!ATTEST_SECRET) return null;
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = nodeCrypto.createHmac('sha256', ATTEST_SECRET).update(ts).digest('hex');
    return Buffer.from(`${ts}:${sig}`, 'utf8').toString('base64');
  });

  // ── Device-registration proof-of-possession ─────────────────────────────
  // Ensures the Signal identity exists, then signs the canonical register
  // message with the identity key. Returns the identity public key + signature
  // so the renderer can prove it owns this device (server dedupes/approves by
  // verified identity key, not the guessable hostname). null if signing fails.
  ipcMain.handle('crypto:device-register-proof', async (event, userId: string, proofTs: number) => {
    try {
      await ensureSignalIdentity(); // idempotent — generates on first run
      const identityPub = getLocalIdentityPub();
      if (!identityPub) return null;
      const msg = `cipherline-device-register:v1:${userId}:${identityPub}:${proofTs}`;
      const sig = signIdentityMessage(msg);
      if (!sig) return null;
      return { identityPub, sig };
    } catch (e) {
      console.error('[device-register-proof] failed', e);
      return null;
    }
  });

  // ── C-2b: history-sync capability advertisement ─────────────────────────
  // Signs the canonical advertisement with this device's Signal identity key,
  // so the approver can tell a genuine "I can receive a WRAPPED transfer key"
  // from a boolean the relaying server flipped. See the long rationale in
  // apps/desktop/src/utils/historyRequestProof.ts.
  //
  // Same key, same primitive and the same `:`-joined layout as the
  // registration proof above — only the domain-separation prefix differs, so
  // neither proof can be replayed as the other. The capability token
  // (`wrapped`) is INSIDE the signed message; that is what makes the flag
  // untamperable rather than merely advisory.
  //
  // The template literal below is duplicated from
  // `historyRequestProofMessage` in that util rather than imported: an import
  // across the electron/ ⇄ src/ boundary re-roots the emitted dist-electron
  // tree and breaks packaging ("main.js not found in archive"), and only a
  // STAGING desktop build catches it. `historyRequestProof.test.ts` scans THIS
  // source text and fails if the two spellings drift.
  //
  // Returns null rather than an unsigned advertisement when the identity is
  // unavailable — the renderer must then refuse to send the request rather
  // than fall back, because an unsigned request is exactly what the approver
  // now declines.
  ipcMain.handle('crypto:history-request-proof', async (event, userId: string, requestingDeviceId: string, ts: number) => {
    try {
      await ensureSignalIdentity(); // idempotent — generates on first run
      const identityPub = getLocalIdentityPub();
      if (!identityPub) return null;
      const msg = `cipherline-history-request:v1:${userId}:${requestingDeviceId}:${identityPub}:wrapped:${ts}`;
      const sig = signIdentityMessage(msg);
      if (!sig) return null;
      return { identityPub, sig };
    } catch (e) {
      console.error('[history-request-proof] failed', e);
      return null;
    }
  });

  // ── Registration proof-of-work solver ───────────────────────────────────
  // Find a nonce whose sha256(challenge + ":" + nonce) has `difficulty` leading
  // zero bits. Runs in the main process (not the renderer) and yields between
  // batches so the UI and other IPC stay responsive. Returns the nonce string,
  // or null if disabled / no solution within the safety cap.
  //
  // What `challenge` is: AuthScreen passes the WHOLE challenge TOKEN it got
  // from the server, which is three dot-separated parts — `<ts>.<rand>.<hmac>`
  // (apps/api/src/auth/pow.util.ts `issueChallengeToken`). The server does NOT
  // hash over that. `verifyChallengeToken` strips the signature and returns the
  // inner `<ts>.<rand>`, and `meetsDifficulty` hashes over THAT two-part
  // prefix. This solver hashed the full three-part token, so every nonce it
  // produced failed verification — registration would have been impossible for
  // every desktop client, 100% of the time.
  //
  // It has never been seen because prod runs REGISTER_POW_DIFFICULTY=0 (the
  // solver is skipped entirely at 0). deploy/k8s/secrets.example.yaml shipped
  // "18", so the first operator to follow the example would have taken signup
  // down completely with nothing in the logs but silent PoW rejections.
  //
  // Normalising here rather than in AuthScreen keeps the fix in one place for
  // any future caller, and is a no-op for a token that is already the inner
  // challenge.
  ipcMain.handle('pow:solve', async (_e, token: string, difficulty: number) => {
    if (!token || typeof difficulty !== 'number' || difficulty <= 0) return null;
    const challenge = powChallengeToHash(token);
    const leadingZeroBits = (buf: Buffer): number => {
      let bits = 0;
      for (const byte of buf) {
        if (byte === 0) { bits += 8; continue; }
        bits += Math.clz32(byte) - 24; // leading zeros within this byte
        break;
      }
      return bits;
    };
    const BATCH = 20_000;
    const MAX_ITER = 80_000_000; // safety cap (~minutes at worst) to avoid hangs
    let nonce = 0;
    while (nonce < MAX_ITER) {
      for (let i = 0; i < BATCH; i++, nonce++) {
        const h = nodeCrypto.createHash('sha256').update(`${challenge}:${nonce}`).digest();
        if (leadingZeroBits(h) >= difficulty) return String(nonce);
      }
      await new Promise<void>(r => setImmediate(r)); // keep main responsive
    }
    return null;
  });

  // ── QR sign-in (link) — the NEW device's half ───────────────────────────
  // Full design + threat model: docs/QR-LINKING.md §2. The ephemeral X25519
  // private key never leaves this process (see link-grant.ts's module doc for
  // why) — the renderer only ever sees the PUBLIC key, a fingerprint to render
  // for comparison, and eventually the opened grant. There is deliberately no
  // handler that returns key material.
  //
  // `link:begin` mints the ephemeral keypair and, in the ordinary flow, is
  // called with the real `link_id` the server just issued — but the renderer
  // needs `ek_pub_b64` inside the POST body that CREATES that `link_id`, which
  // is a chicken-and-egg the server's session shape does not resolve for us.
  // Rather than reordering the wire protocol (which is out of scope here and
  // owned by link-grant.ts's contract), the renderer calls `link:begin('')` to
  // mint the key first, POSTs it, and then calls `link:bind` to attach the
  // real id to the session that is already in flight. `bindLinkSession` (added
  // in link-grant.ts) accepts the id exactly once — see that function's doc
  // for why a second bind throws rather than re-keying silently.
  ipcMain.handle('link:begin', (_e, linkId: string) => {
    return beginLinkSession(typeof linkId === 'string' ? linkId : '');
  });

  ipcMain.handle('link:bind', (_e, linkId: string) => {
    bindLinkSession(linkId);
  });

  // Opens the sealed grant for the CURRENT session and discards the ephemeral
  // key whether or not it succeeds (openActiveLinkSession's own contract).
  // Every failure here — bad envelope, wrong key, tampered ciphertext, wrong
  // link id — must reach the renderer as a plain rejection: there is no
  // partial or unsealed grant to fall back to (docs/QR-LINKING.md §2.10).
  ipcMain.handle('link:open', (_e, envelopeB64: string, linkId: string) => {
    return openActiveLinkSession(envelopeB64, linkId);
  });

  ipcMain.handle('link:end', () => {
    endLinkSession();
  });

  // The MIRROR role — this desktop is the signed-in device approving a phone
  // that scanned its invite QR (Settings → Devices → "Sign in on your phone").
  // Seals the v2 grant (a claim secret, never a token) to the PHONE's
  // ephemeral public key. Only a token-free v2 payload is accepted here: the
  // renderer never holds a token pair for another device, and a v1-shaped
  // payload reaching this handler would mean something upstream is wrong.
  // Independent of the `link:begin` session above — approving a phone must
  // not disturb a sign-in QR this desktop might itself be showing.
  ipcMain.handle('link:seal', (_e, payload: LinkGrantPayload, ekPubB64: string, linkId: string) => {
    if (!payload || payload.type !== 'link_grant' || payload.v !== 2 || typeof payload.claim_secret !== 'string') {
      throw new Error('[LinkGrant] only a v2 (claim-secret) grant may be sealed from this desktop');
    }
    if (typeof ekPubB64 !== 'string' || typeof linkId !== 'string' || payload.link_id !== linkId) {
      throw new Error('[LinkGrant] refusing to seal a grant for a different link session');
    }
    return sealLinkGrant(payload, ekPubB64, linkId);
  });

  // window:focus / window:blur / window:minimize / window:hide pushes are
  // registered inside createWindow(), after mainWindow is assigned. They used
  // to live here, where — like maximize before P2-ELEC-8 — `mainWindow?.on`
  // ran before the window existed and silently registered nothing: none of
  // the four ever reached the renderer.

  // ── Notifications ──────────────────────────────────────────────────────────
  // Reply delivery handshake: the renderer announces when its reply listener is
  // bound so queued toast replies can be drained into it (see notifications.ts).
  registerNotificationReplyBridge(() => mainWindow);
  // A reloading renderer tears down its ipcRenderer listeners; treat the channel
  // as closed until it re-announces, or replies sent in the gap vanish.
  mainWindow?.webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) markRendererReplyListenerLost();
  });

  ipcMain.handle('notif:show', (_e, payload) => {
    if (mainWindow) showNotification(mainWindow, payload);
  });
  ipcMain.handle('notif:set-badge', (_e, count: number) => {
    if (mainWindow) setBadgeCount(mainWindow, count, getTray());
  });
  ipcMain.handle('notif:flash-taskbar', () => {
    if (mainWindow) flashTaskbar(mainWindow);
  });
  ipcMain.handle('notif:close-all', () => {
    closeAllNotifications();
  });

  // ── Tray state push from renderer ──────────────────────────────────────────
  ipcMain.handle('tray:update-state', (_e, state: TrayMenuState) => {
    trayState = { ...trayState, ...state };
    if (mainWindow) updateTrayMenu(trayState, mainWindow, isQuittingRef);
    if (mainWindow) setBadgeCount(mainWindow, trayState.unreadCount, getTray());
  });

  // Call + voice state — renderer pushes on every speaking/mute/deafen change.
  // Priority: deafened > muted > speaking > silent > unread > clean.
  ipcMain.handle('tray:call-speaking', (_e, inCall: boolean, isSpeaking: boolean, isMuted: boolean, isDeafened: boolean) => {
    setTrayCallState(inCall, isSpeaking, isMuted, isDeafened);
    // Update the Windows taskbar overlay to show muted/deafened icons.
    // setTrayCallState runs first so getCallState() reflects the new values.
    if (mainWindow) applyWindowsCallOverlay(mainWindow);
  });

  ipcMain.handle('crypto:get-local-identity', () => {
    return getLocalIdentityPub();
  });

  // Generate (or load) the Signal identity and return the key bundle so the
  // renderer can POST it to /v1/keys/upload_bundle after device registration.
  // `opts.unclaimedPrekeyIds` (from GET /v1/keys/status) gates which held
  // one-time prekeys are re-offered — validated in ensureSignalIdentity, a
  // malformed value degrades to "no gate", never to anything wider. `is_new`
  // tells the renderer whether this call minted the identity.
  ipcMain.handle('crypto:ensure-identity-bundle', async (_event, deviceId: string, opts?: { unclaimedPrekeyIds?: unknown }) => {
    const unclaimedPrekeyIds = opts && typeof opts === 'object' ? opts.unclaimedPrekeyIds : undefined;
    const { isNew, bundle } = await ensureSignalIdentity({ unclaimedPrekeyIds });
    return { device_id: deviceId, is_new: isNew, ...bundle };
  });

  // The lowest one-time-prekey id this device still holds a private for — the
  // paging cursor the renderer passes to GET /v1/keys/status as `held_from`.
  // Read-only, and it exposes an integer, never key material.
  ipcMain.handle('keys:lowest-held-otp-id', async () => {
    await secureStore.initialize();
    return lowestHeldOtpId();
  });

  // Generate a rotation bundle (new SPK + 100 fresh OTPs) for background key
  // hygiene. The renderer uploads it via POST /v1/keys/upload_bundle.
  //
  // `opts` MUST be forwarded. This handler used to take no parameters and call
  // `generateRotationBundle()` bare, silently discarding everything the preload
  // sent — so `rotateSpk: false` never arrived and every OTP top-up also
  // rotated the signed prekey, which is precisely the superseded-key pile-up
  // the rotateSpk split exists to prevent (each retired SPK private is kept 35
  // days and tried on every decrypt). The prekey id lists added for the
  // one-time-prekey reuse fix travel the same channel, so the drop would have
  // silently disabled this fix too.
  //
  // `otpPoolLow` (a boolean) switches on the status-aware mode, which may
  // answer null — "nothing needs publishing" — see generateRotationBundle.
  ipcMain.handle('keys:get-rotation-bundle', async (_event, opts?: {
    rotateSpk?: boolean;
    unclaimedPrekeyIds?: number[];
    retiredPrekeyIds?: number[];
    otpPoolLow?: boolean;
  }) => {
    const options = (opts && typeof opts === 'object' ? opts : {}) as StatusAwareRotationOptions;
    return generateRotationBundle(options);
  });

  // --- E2EE Message Encryption ---
  // Encrypt a JSON content string for the given recipient devices.
  // Each device's signed prekey public key is used for ECIES key wrapping.
  //
  // Kept string-returning for backward compat with every existing caller —
  // encryptForDevices itself now returns { envelope_b64, wrapped_device_ids }
  // (RC-2/RC-5 fix), unwrapped here to .envelope_b64 only. New call sites
  // that need to know which devices actually got wrapped (so they store
  // recipient_device_ids for exactly those, not the full input list) use
  // crypto:encrypt-message-v2 below instead.
  ipcMain.handle('crypto:encrypt-message', async (event, contentJson: string, senderUserId: string, devices: DevicePub[], senderDeviceId?: string) => {
    if (!Array.isArray(devices)) {
      throw new TypeError(`crypto:encrypt-message: devices must be an array, got ${typeof devices} — value: ${JSON.stringify(devices)?.slice(0, 200)}`);
    }
    const result = await encryptForDevices(contentJson, senderUserId, devices, senderDeviceId);
    return result.envelope_b64;
  });

  // v2: same encryption, but returns which devices actually got wrapped so
  // the renderer can address recipient_device_ids to exactly that set
  // instead of the full input list (RC-2 — the previous full-list behavior
  // is what let envelopes get stored for devices that were never actually
  // encrypted to, permanently undecryptable by construction).
  ipcMain.handle('crypto:encrypt-message-v2', async (event, contentJson: string, senderUserId: string, devices: DevicePub[], senderDeviceId?: string) => {
    if (!Array.isArray(devices)) {
      throw new TypeError(`crypto:encrypt-message-v2: devices must be an array, got ${typeof devices} — value: ${JSON.stringify(devices)?.slice(0, 200)}`);
    }
    return encryptForDevices(contentJson, senderUserId, devices, senderDeviceId);
  });

  // Decrypt a message envelope received from the server.
  // senderIdentityPubB64 is optional — when provided, the v:2 envelope
  // signature is verified against the sender's identity key (HIGH-6).
  //
  // RC-6: tries every retained signed prekey, not just the active one —
  // generateRotationBundle keeps old SPK privs specifically so in-flight
  // messages wrapped against a since-rotated SPK stay decryptable; this is
  // what actually uses them. Active id first (the common case), then the
  // rest by id descending (most-recently-rotated-away first).
  //
  // Main-thread cost is bounded by the keys actually TRIED, not by how many
  // are retained: ids come from the store's prefix index (not a scan of the
  // whole vault), each private is decrypted from the store only when its turn
  // comes, and the key that opened the previous envelope is tried right after
  // the active one (see spk-candidates.ts). The candidate SET is unchanged.
  const spkOrder = new SpkCandidateOrder();
  ipcMain.handle('crypto:decrypt-message', (event, ciphertextB64: string, myDeviceId: string) => {
    return decryptWithRetainedSpks(ciphertextB64, myDeviceId, spkOrder);
  });

  // --- Sender Keys — Channel Message Crypto ---
  // All channel key operations run in the main process where Node.js crypto
  // and SecureStore are available. The renderer calls these via the preload.

  // `sender` (G4) is bound into the ciphertext so receivers can reject a row
  // the server re-labelled. Only string ids are passed through; anything else
  // from the renderer degrades to "not bound", never to a throw.
  const optId = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined;

  ipcMain.handle('channel:encrypt-message', (event, contentJson: string, channelId: string, sender?: { user_id?: unknown; device_id?: unknown }) => {
    return encryptChannelMessage(contentJson, channelId, {
      user_id: optId(sender?.user_id),
      device_id: optId(sender?.device_id),
    });
  });

  ipcMain.handle('channel:decrypt-message', (event, params: {
    channel_id: string;
    epoch: number;
    nonce_b64: string;
    ciphertext_b64: string;
    signature_b64: string;
    sender_identity_pub_b64: string;
    message_id?: unknown;
    sender_user_id?: unknown;
    sender_device_id?: unknown;
  }) => {
    return decryptChannelMessage({
      channel_id: params.channel_id,
      epoch: params.epoch,
      nonce_b64: params.nonce_b64,
      ciphertext_b64: params.ciphertext_b64,
      signature_b64: params.signature_b64,
      sender_identity_pub_b64: params.sender_identity_pub_b64,
      message_id: optId(params.message_id),
      sender_user_id: optId(params.sender_user_id),
      sender_device_id: optId(params.sender_device_id),
    });
  });

  // Vault writes are asynchronous: handlers that store key material reply
  // only once it is on disk, as they did when set() wrote synchronously.
  ipcMain.handle('channel:set-key', async (event, channelId: string, epoch: number, keyB64: string, rotatesAt: string, replaceIfFingerprintB64?: string) => {
    const result = setChannelKey(channelId, epoch, keyB64, new Date(rotatesAt), replaceIfFingerprintB64 ? { replaceIfFingerprintB64 } : undefined);
    await secureStore.whenDurable();
    return result;
  });

  ipcMain.handle('channel:get-latest-epoch', (event, channelId: string) => {
    return getLatestEpoch(channelId);
  });

  ipcMain.handle('channel:list-epochs', (event, channelId: string) => {
    return listChannelEpochs(channelId);
  });

  // RC-10 / Phase 6: epochs a pin in this channel references, refreshed by
  // the renderer from GET /pinned-epochs (server open + hourly) so
  // pruneOldKeys never deletes the only local copy of a key a pin needs.
  ipcMain.handle('channel:set-protected-epochs', async (event, channelId: string, epochs: number[]) => {
    if (!Array.isArray(epochs)) {
      throw new TypeError(`channel:set-protected-epochs: epochs must be an array, got ${typeof epochs}`);
    }
    setProtectedEpochs(channelId, epochs);
    await secureStore.whenDurable();
  });

  // The returned key is about to be wrapped and handed to other members: it is
  // on this device's disk first.
  ipcMain.handle('channel:rotate-key', async (event, channelId: string, atEpoch?: number) => {
    const result = rotateChannelKey(channelId, atEpoch);
    await secureStore.whenDurable();
    return { epoch: result.epoch, keyB64: result.keyB64, rotatesAt: result.rotatesAt.toISOString() };
  });

  ipcMain.handle('channel:get-fingerprint', (event, channelId: string, epoch: number) => {
    return getChannelKeyFingerprint(channelId, epoch);
  });

  ipcMain.handle('channel:list-fingerprints', (event, channelId: string) => {
    return listChannelEpochFingerprints(channelId);
  });

  ipcMain.handle('channel:discard-key', async (event, channelId: string, epoch: number) => {
    discardChannelKey(channelId, epoch);
    await secureStore.whenDurable();
  });

  /**
   * Retrieve a stored channel key as a base64 string so the renderer can
   * encrypt it for distribution to a newly joined member.
   * Returns null if the epoch key is not in local storage.
   */
  ipcMain.handle('channel:get-key', (event, channelId: string, epoch: number) => {
    const buf = getChannelKey(channelId, epoch);
    if (!buf) return null;
    return buf.toString('base64');
  });

  // Prune stale channel keys on startup (keys older than 30 days).
  //
  // Deferred behind storeReady, same fire-and-forget shape as
  // migrateSpkPubIfMissing() above. It enumerates secureStore.keys(), so
  // running it before init is not merely early — it reads an EMPTY keystore
  // and prunes nothing, silently, on every launch. That was invisible while
  // _doInitialize() was synchronous (the store was always ready by the time
  // this line ran); now that init really yields, this has to say so.
  // Housekeeping with no startup dependency, so nothing waits on it.
  storeReady
    .then(() => pruneOldKeys())
    .catch(err => console.warn('[Main] pruneOldKeys failed:', err));

  // --- Secure Storage IPC ---
  ipcMain.handle('secure:get-avatar-key', async (event, attachmentId) => {
    const data = secureStore.get(`avatar_key:${attachmentId}`);
    return data ? JSON.parse(data) : null;
  });

  ipcMain.handle('secure:set-avatar-key', async (event, attachmentId, keyB64, nonceB64) => {
    secureStore.set(`avatar_key:${attachmentId}`, JSON.stringify({ keyB64, nonceB64 }));
    await secureStore.whenDurable();
    return true;
  });

  // Enumerate every stored avatar key. Used by the encrypted-backup exporter
  // so a restore on a new install can re-hydrate avatar decryption keys.
  ipcMain.handle('secure:list-avatar-keys', async () => {
    const out: Record<string, { keyB64: string; nonceB64: string }> = {};
    for (const key of secureStore.keys()) {
      if (!key.startsWith('avatar_key:')) continue;
      const attId = key.slice('avatar_key:'.length);
      const raw = secureStore.get(key);
      if (!raw) continue;
      try { out[attId] = JSON.parse(raw); } catch { /* skip corrupt */ }
    }
    return out;
  });

  // ── Bulk SecureStore access from the renderer ─────────────────────────────
  //
  // These three channels are a NAMED, closed set (electron/secure-store-policy.ts),
  // not a generic key/value API. They used to take arbitrary key names, which
  // meant a renderer running attacker code could read the Signal identity
  // private key, every prekey and every channel key in a single `get-many`
  // call — and overwrite or delete them just as easily.
  //
  // `installIpcSenderGuard()` does not help with this, and the two controls
  // must not be confused: the guard decides WHO may call a channel and now
  // covers every one of them by construction. This list decides WHAT may
  // come back. The renderer passes the guard by definition — it IS our
  // renderer — and is precisely the compromised party in this threat model.
  //
  // Unknown names are dropped silently rather than throwing: a caller asking
  // for a key it isn't allowed to see already handles "absent" (that's what a
  // fresh install looks like), and failing the whole batch would turn a
  // single bad name into a broken backup export.
  //
  // `secure:get-backup-keys` / `set-backup-keys` / `clear-backup-keys` (which
  // returned the cached BEK/KEK derived key material to the renderer) and
  // `secure:list-by-prefix` (which returned EVERY key under a caller-supplied
  // prefix — `''` dumped the entire keystore) were removed with these: all
  // four had zero call sites, no preload bridge and no type declaration, and
  // the renderer consumer the backup-keys comment named
  // (src/utils/backupKeys.ts) has never existed. Dead privileged surface is
  // worth deleting, not allowlisting.

  // Batch SecureStore replacement — used by the restore importer. Writes
  // all entries in one save() to minimize crash window between half-applied
  // states.
  ipcMain.handle('secure:replace-many', async (event, entries: Record<string, string>) => {
    if (!entries || typeof entries !== 'object') return false;
    const filtered: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === 'string' && isRendererSecureKey(k)) filtered[k] = v;
    }
    secureStore.setMany(filtered); // one vault write, never half-applied (P2-ELEC-10)
    await secureStore.whenDurable();
    return true;
  });

  ipcMain.handle('secure:get-many', async (event, keys: string[]) => {
    if (!Array.isArray(keys)) return {};
    const out: Record<string, string | null> = {};
    for (const k of filterRendererSecureKeys(keys)) {
      out[k] = secureStore.get(k);
    }
    return out;
  });

  // P2-ELEC-24: Explicit key deletion (vs. storing '') so callers don't leave
  // stale empty-string entries in the encrypted keystore.
  ipcMain.handle('secure:delete-many', async (event, keys: string[]) => {
    if (!Array.isArray(keys)) return false;
    // One vault write for the whole list, not one per key.
    secureStore.batch(() => {
      for (const k of filterRendererSecureKeys(keys)) {
        secureStore.delete(k);
      }
    });
    await secureStore.whenDurable();
    return true;
  });

  // On-disk GIF library helpers — enumerate, read, and write the per-file
  // encrypted blobs under `userData/cipherline-gifs/`. Backup includes them
  // as base64; restore writes them back so the GIF picker works offline.
  const gifDir = () => path.join(app.getPath('userData'), 'cipherline-gifs');
  // Sanitise a renderer-supplied gif id to a confined path. path.join alone does
  // NOT stop traversal (`../../x`); basename + char-strip + resolved-prefix assert do.
  const safeGifPath = (id: string): string => {
    const safe = path.basename(String(id)).replace(/[^a-zA-Z0-9._-]/g, '_');
    const resolved = path.resolve(gifDir(), `${safe}.enc`);
    if (!resolved.startsWith(path.resolve(gifDir()) + path.sep)) throw new Error('Invalid gif id');
    return resolved;
  };
  ipcMain.handle('fs:list-gif-files', async () => {
    try {
      const files = await fs.promises.readdir(gifDir());
      return files.filter(f => f.endsWith('.enc')).map(f => f.replace(/\.enc$/, ''));
    } catch { return []; }
  });
  ipcMain.handle('fs:read-gif-file', async (event, id: string) => {
    return await fs.promises.readFile(safeGifPath(id));
  });
  ipcMain.handle('fs:write-gif-file', async (event, id: string, data: Uint8Array) => {
    await fs.promises.mkdir(gifDir(), { recursive: true });
    await fs.promises.writeFile(safeGifPath(id), Buffer.from(data));
  });

  // ── Custom notification sounds ──────────────────────────────────────────────
  // User-uploaded .wav/.mp3/.ogg sounds live under userData/custom-sounds/.
  // The renderer references them by absolute file:// path in notification prefs.
  const customSoundsDir = () => path.join(app.getPath('userData'), 'custom-sounds');
  ipcMain.handle('fs:upload-custom-sound', async (event, filename: string, data: Uint8Array) => {
    await fs.promises.mkdir(customSoundsDir(), { recursive: true });
    // Sanitise the filename: strip path separators, enforce an audio extension.
    let safe = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!/\.(wav|mp3|ogg)$/i.test(safe)) throw new Error('Only .wav/.mp3/.ogg sounds are allowed');
    const dest = path.join(customSoundsDir(), safe);
    await fs.promises.writeFile(dest, Buffer.from(data));
    // Return a file:// URL the renderer can feed straight into <Audio src>.
    return { name: safe, file: `file://${dest}` };
  });
  ipcMain.handle('fs:list-custom-sounds', async () => {
    try {
      const files = await fs.promises.readdir(customSoundsDir());
      return files
        .filter(f => /\.(wav|mp3|ogg)$/i.test(f))
        .map(f => ({ name: f, file: `file://${path.join(customSoundsDir(), f)}` }));
    } catch { return []; }
  });
  // Bytes of one custom sound, for the encrypted backup. Confined to the
  // custom-sounds dir exactly like delete below.
  ipcMain.handle('fs:read-custom-sound', async (event, fileUrl: string) => {
    if (typeof fileUrl !== 'string' || !fileUrl) throw new Error('Invalid sound path');
    const p = fileUrl.startsWith('file://') ? fileUrl.slice(7) : fileUrl;
    const resolved = path.resolve(p);
    if (!resolved.startsWith(path.resolve(customSoundsDir()) + path.sep)) throw new Error('Invalid sound path');
    return await fs.promises.readFile(resolved);
  });
  ipcMain.handle('fs:delete-custom-sound', async (event, fileUrl: string) => {
    try {
      const p = fileUrl.startsWith('file://') ? fileUrl.slice(7) : fileUrl;
      // Only allow deletes within the custom-sounds dir.
      const resolved = path.resolve(p);
      if (!resolved.startsWith(path.resolve(customSoundsDir()))) return { ok: false };
      await fs.promises.unlink(resolved);
      return { ok: true };
    } catch { return { ok: false }; }
  });

  // --- Local ciphertext-at-rest master key ----------------------------------
  // Used by renderer/IndexedDB attachment cache (and future localStorage
  // wrapping) to defend against same-machine malware reading cached bytes.
  // The master key itself is wrapped with Electron's safeStorage (DPAPI on
  // Windows, Keychain on macOS, libsecret/kwallet on Linux) so a simple
  // "read the file" attack yields ciphertext only. Returns null if safeStorage
  // is unavailable — renderer gracefully falls back to unwrapped storage in
  // that case (with a warning logged).
  // Resolve the OS-wrapped local master key with a *discriminated* status so
  // callers can tell the three cases apart:
  //   'ok'     — key available (first-run generation also lands here).
  //   'absent' — no keystore on this platform (e.g. headless Linux). Callers
  //              degrade to unencrypted at-rest (TAG_RAW) and keep working.
  //   'locked' — a key file exists but cannot be unlocked (decrypt threw, or an
  //              unexpected read error). The file is PRESERVED and NO new key is
  //              generated; callers must NOT overwrite the existing ciphertext —
  //              they show a recovery path instead. This is the load-bearing
  //              guarantee that protects a user's encrypted history after a
  //              keyring reset / machine move.
  // The renderer's encrypted key/value store now shares ONE device master key
  // with SecureStore (which holds the Signal identity, avatar & backup keys), so
  // a single user-held recovery key unlocks everything at rest.
  // Returns the STATUS only. It used to return the key alongside it, for
  // `secure:get-local-master-key-ex`; that channel is gone and nothing needs
  // the bytes to answer this question, so the key is no longer materialised
  // on this path at all.
  async function resolveLocalMasterKey(): Promise<{ status: 'ok' | 'absent' | 'locked' }> {
    await secureStore.initialize();
    if (secureStore.isLocked()) return { status: 'locked' };
    if (secureStore.getMasterKeyB64()) return { status: 'ok' };
    // Should not happen (initialize yields a key unless locked), but never
    // fabricate a key — report locked so callers don't overwrite the store.
    return { status: 'locked' };
  }

  // Whether the device master key is available — WITHOUT handing it over.
  // Callers that only need to know "can this device decrypt its own data"
  // (e.g. a screen deciding whether to offer the recovery-key card)
  // must use this, not the -ex channel below: there is no reason to move
  // 32 bytes of key material across the bridge to answer a yes/no question.
  ipcMain.handle('secure:get-local-master-key-status', async () => {
    try {
      const res = await resolveLocalMasterKey();
      return { status: res.status };
    } catch (e) {
      console.error('[safeStorage] resolveLocalMasterKey threw', e);
      return { status: 'locked' };
    }
  });

  // ── Encrypted key/value store: crypto happens HERE, not in the renderer ───
  //
  // `secure:get-local-master-key-ex` used to live here and handed the renderer
  // the raw device master key. It is gone. The renderer now ships ciphertext
  // up and plaintext back down, and the master key never crosses the bridge.
  // See electron/kv-crypto.ts for the full rationale, including an explicit
  // account of what this does and does not buy.
  //
  // Why this shape rather than moving the STORE into main: the records live in
  // the renderer's IndexedDB, which main cannot read. Relocating them would be
  // a data migration of every user's entire local vault, and a migration that
  // half-completes lands boot on StorageLockedScreen — which a user with a
  // working account reads as "this app lost all my data" and may respond to by
  // reinstalling. Moving only the crypto reaches the same security outcome with
  // the on-disk format and location byte-identical, so there is nothing to
  // migrate and a revert is a code-only change.
  //
  // Both handlers are bulk: hydrate sends one batch for the boot-blocking tier
  // and one per deferred batch, and each flush sends one batch. That keeps the
  // round-trip count proportional to flushes rather than to key count.
  const kvCrypto = new KvCrypto({
    status: () => (secureStore.isLocked() ? 'locked' : 'ok'),
    keyBytes: () => {
      const b64 = secureStore.getMasterKeyB64();
      return b64 ? Buffer.from(b64, 'base64') : null;
    },
  });

  /** Decrypt stored records. Per-record soft failure; see KvCrypto.open. */
  ipcMain.handle('securekv:open', async (_event, records: unknown) => {
    await secureStore.initialize();
    if (!Array.isArray(records)) return [];
    // Validate at the boundary rather than trusting the renderer's shape —
    // a malformed entry must not take down hydrate for the whole store.
    const clean = records.flatMap((r: unknown) => {
      if (!r || typeof r !== 'object') return [];
      const { k, o, b } = r as { k?: unknown; o?: unknown; b?: unknown };
      if (typeof k !== 'string') return [];
      if (o !== null && typeof o !== 'string') return [];
      if (!(b instanceof Uint8Array)) return [];
      return [{ k, o: o as string | null, b }];
    });
    try {
      return kvCrypto.open(clean);
    } catch (e) {
      console.error('[securekv] open threw', e);
      return clean.map(r => ({ k: r.k, v: null }));
    }
  });

  /** Encrypt values for storage. Returns b: null per record on failure so the
   *  renderer re-queues that key instead of dropping the write. */
  ipcMain.handle('securekv:seal', async (_event, records: unknown) => {
    await secureStore.initialize();
    if (!Array.isArray(records)) return [];
    const clean = records.flatMap((r: unknown) => {
      if (!r || typeof r !== 'object') return [];
      const { k, o, v } = r as { k?: unknown; o?: unknown; v?: unknown };
      if (typeof k !== 'string' || typeof v !== 'string') return [];
      if (o !== null && typeof o !== 'string') return [];
      return [{ k, o: o as string | null, v }];
    });
    try {
      return kvCrypto.seal(clean);
    } catch (e) {
      console.error('[securekv] seal threw', e);
      return clean.map(r => ({ k: r.k, b: null }));
    }
  });

  // The ONE key still handed to the renderer, and deliberately not the master
  // key: HKDF(master, "cl-blob-cache"), scoped to the attachment/avatar blob
  // cache. attachmentCache wraps whole blobs up to the 2 GiB paid cap, so
  // routing them through IPC would copy every byte across the bridge twice.
  // HKDF is one-way, so this opens the blob cache and nothing else — not the
  // key/value store, not the Signal identity, not a single backup container.
  ipcMain.handle('secure:get-blob-cache-key', async () => {
    await secureStore.initialize();
    const key = kvCrypto.deriveBlobCacheKey();
    if (!key) return { status: secureStore.isLocked() ? 'locked' : 'absent' };
    return { status: 'ok', keyB64: key.toString('base64') };
  });

  // Phase 7 / device sprawl: whether THIS session's secure-store.json was
  // corrupt and had to be moved aside (distinct from 'locked' — the master
  // key unwrapped fine, only the DATA envelope was unreadable). The renderer
  // boot gate uses this to show a blocking screen instead of silently
  // proceeding into an app that's about to mint a brand-new device identity.
  ipcMain.handle('secure:get-corruption-status', async () => {
    await secureStore.initialize();
    return secureStore.corruptionInfo();
  });

  // G8: is the master key protected by a real OS keystore? On Linux without a
  // recognised keyring, safeStorage falls back to `basic_text` — a key
  // hard-coded in Chromium — which the store used to treat as real wrapping.
  // Returns the classification plus whether the one-time notice is still due.
  // Read-only: registering / calling this writes nothing, so it is safe at
  // startup (and under CIPHERLINE_SMOKE_TEST the level is 'unknown' → no notice).
  const KEYPROT_ACK_KEY = 'keyprot_notice_ack';
  ipcMain.handle('secure:get-key-protection', async () => {
    await secureStore.initialize();
    const p = secureStore.keyProtection();
    // A locked store cannot read the ack; say nothing rather than nag.
    const acked = secureStore.status() === 'ok' ? secureStore.get(KEYPROT_ACK_KEY) : null;
    const showNotice = secureStore.status() === 'ok' && shouldShowKeyProtectionNotice(p, acked);
    return { level: p.level, reason: p.reason, backend: p.backend, platform: p.platform, showNotice };
  });
  // Only ever called from the notice's dismiss button (a user action, never at
  // boot). Records the CURRENT state's token, so a different weak state later
  // shows the notice again.
  ipcMain.handle('secure:ack-key-protection-notice', async () => {
    await secureStore.initialize();
    if (secureStore.status() !== 'ok') return false;
    secureStore.set(KEYPROT_ACK_KEY, keyProtectionNoticeToken(secureStore.keyProtection()));
    return true;
  });

  // ── Recovery-key flows ────────────────────────────────────────────────────
  // Reveal the device master key so the user can store it in a password
  // manager. Gated on a main-process confirmation: see recovery-key-gate.ts
  // for what that buys, why nothing the renderer can assert would do, and why
  // onboarding gets no carve-out. The decision logic lives there so it is
  // covered by tests; this wires it to the real keystore and the real dialog.
  // Single place the raw master-key bytes are read for a recovery-key
  // reveal (the gated Settings path below; the ungated signup path that used
  // to share it is gone) — so there is still exactly one literal call site here regardless
  // of how many reveal channels exist (recovery-key-gate.test.ts pins the
  // total count of raw reads in this file; sharing this closure is what
  // keeps adding a second reveal path from silently doubling it).
  const readMasterKeyB64 = () => secureStore.getMasterKeyB64();

  const revealRecoveryKeyGated = createRecoveryKeyGate({
    isLocked: () => secureStore.isLocked(),
    getMasterKeyB64: readMasterKeyB64,
    confirm: async () => {
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        // Cancel is index 0 AND the default, so a stray Enter or a synthetic
        // key event dismisses rather than approves.
        buttons: ['Cancel', 'Show key'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'Show recovery key',
        message: 'Show your recovery key?',
        detail:
          "Your recovery key decrypts everything Cipherline keeps on this device — your message history, settings and this device's identity — and every backup it has written. It never changes, so anyone who gets a copy keeps that access.\n\n" +
          'Only continue if you just asked to see it. Cipherline will never ask you to share it with anyone.',
      };
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, opts)
        : await dialog.showMessageBox(opts);
      return response === 1;
    },
  });

  ipcMain.handle('secure:reveal-recovery-key', async () => {
    await secureStore.initialize();
    return revealRecoveryKeyGated();
  });

  // There is deliberately NO ungated reveal any more. The signup wizard's
  // separate no-dialog "signup" reveal channel (2026-09-20) went with the
  // wizard's recovery-key step when onboarding round 6 removed that step
  // (2026-10-05): the key is shown only from Settings, through the gate
  // above. See the UPDATE notice at the top of electron/recovery-key-gate.ts.

  // Adopt a user-supplied recovery key on a locked device. Validates against an
  // existing encrypted entry and re-wraps it with this device's keystore.
  ipcMain.handle('secure:recover-with-key', async (event, keyB64: string) => {
    await secureStore.initialize();
    if (typeof keyB64 !== 'string') return false;
    const ok = secureStore.recoverWithKey(keyB64.trim());
    // recoverWithKey may write a canary into an empty vault.
    if (ok) await secureStore.whenDurable();
    // Both recovery paths replace the master key underneath a live KvCrypto.
    // Its cache self-heals on a key-fingerprint change, but drop it explicitly
    // too: a stale per-account subkey here fails every read AND every write for
    // that account, silently, until the next launch.
    if (ok) kvCrypto.resetSubkeyCache();
    return ok;
  });

  // Destroy all local secrets and re-key ("start fresh"). The renderer wipes
  // its encrypted IndexedDB separately.
  ipcMain.handle('secure:factory-reset', async () => {
    await secureStore.initialize();
    secureStore.factoryReset();
    kvCrypto.resetSubkeyCache();
    return true;
  });

  ipcMain.handle('system:get-idle-time', () => {
    return powerMonitor.getSystemIdleTime(); // seconds of system-wide idle
  });

  // --- File-system & dialog IPC (for backup/restore) ---
  // Dialogs open a native OS picker, so paths crossing the boundary are user-chosen.
  //
  // MED-6: what the user consented to is THIS FILE, not the folder it happens
  // to live in. `dialog:save` used to add `path.dirname()` of the chosen path
  // to the PERSISTED `userPickedDirs`, and `assertInsideUserData` prefix-matches
  // recursively — so saving one recovery-key .txt to ~/Documents permanently
  // handed the renderer fs:read-file, fs:read-dir and fs:unlink over that whole
  // tree, forever, across restarts. Saving to the home directory or a Desktop
  // was a total confinement bypass.
  //
  // `dialog:open` already draws exactly this distinction (openDirectory → a
  // directory grant; a picked file → that file only, session-scoped, in
  // `userPickedFiles`). These two now follow that precedent: a save admits the
  // one path, for writes, for this launch only. Nothing here needs to persist —
  // the consumers (e.g. a recovery-key .txt save) write
  // immediately after the dialog returns. Durable directory grants still come
  // from `dialog:open`'s openDirectory flow, which is what the backup folder
  // actually uses.
  const userPickedSaveFiles = new Set<string>();
  const admitSaveTarget = (filePath: string): void => {
    // Store the same shape assertInsideUserData will compute, so a file that
    // does not exist yet (resolveReal falls back to realpath(dir) + basename)
    // still matches on the write that follows.
    userPickedSaveFiles.add(normalizePath(resolveReal(path.resolve(filePath))));
  };

  ipcMain.handle('dialog:save', async (event, opts: Electron.SaveDialogOptions) => {
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts);
    // Admit the file the user chose — not its parent directory.
    if (!result.canceled && result.filePath) admitSaveTarget(result.filePath);
    return result;
  });
  // Combined save-dialog + write handler.  The file path stays inside the main
  // process — the renderer only sends data, never a path — so assertInsideUserData
  // is not needed for this call's own write.
  ipcMain.handle('fs:save-file-as', async (event, opts: Electron.SaveDialogOptions, data: Uint8Array) => {
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts);
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.mkdir(path.dirname(result.filePath), { recursive: true });
    await fs.promises.writeFile(result.filePath, Buffer.from(data));
    const stat = await fs.promises.stat(result.filePath);
    // Admit the same single path in case the caller later re-writes it via
    // fs:write-file (overwrite / backup follow-up) — again, the file, not the
    // directory.
    admitSaveTarget(result.filePath);
    return { canceled: false, filePath: result.filePath, size: stat.size };
  });

  // L3: persist user-picked dirs to disk so fs:register-dir cannot be abused — the
  // renderer can only re-admit paths previously approved via a system dialog, never
  // grant itself access to arbitrary filesystem paths.
  const pickedDirsFile = path.join(app.getPath('userData'), 'picked-dirs.json');
  function persistPickedDirs(dirs: Set<string>): void {
    try { fs.writeFileSync(pickedDirsFile, JSON.stringify([...dirs]), { mode: 0o600 }); }
    catch { /* non-fatal */ }
  }
  const userPickedDirs: Set<string> = (() => {
    try {
      const arr = JSON.parse(fs.readFileSync(pickedDirsFile, 'utf8'));
      if (Array.isArray(arr)) return new Set(arr.filter((s): s is string => typeof s === 'string'));
    } catch { /* first run */ }
    return new Set<string>();
  })();

  // Session-only allowlist for fs:encrypt-to-temp (attachment uploads pick
  // arbitrary files anywhere on disk, e.g. ~/Downloads/photo.jpg — outside
  // both userData and userPickedDirs, so those checks don't apply here).
  // Populated ONLY by the preload's fs:register-resolved-path message, which
  // itself only fires when webUtils.getPathForFile() resolves a real native
  // File handle from an actual OS file-input/drag-drop event (electron/
  // preload.ts _cacheFile). A compromised renderer can call the exposed
  // encryptFileToTemp(path) with any string, but it cannot forge an entry
  // into this set — it can only cause a real file to be resolved by
  // supplying a File backed by a genuine OS handle, and getPathForFile
  // returns '' for anything else (in-memory/clipboard/synthesized Files).
  // Deliberately not persisted — this is a per-launch, per-pick trust
  // window, not a durable grant like userPickedDirs.
  const resolvedFilePaths = new Set<string>();
  function normalizePath(p: string): string {
    return process.platform === 'win32' ? p.toLowerCase() : p;
  }
  ipcMain.on('fs:register-resolved-path', (event, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return;
    try {
      resolvedFilePaths.add(normalizePath(fs.realpathSync(path.resolve(filePath))));
    } catch { /* file may be gone/inaccessible by the time this arrives — ignore */ }
  });
  function assertResolvedFilePath(filePath: string): void {
    let resolved: string;
    try { resolved = fs.realpathSync(path.resolve(filePath)); }
    catch { throw new Error('File not found'); }
    if (!resolvedFilePaths.has(normalizePath(resolved))) {
      throw new Error('Refusing to encrypt a path that was not resolved from a genuine file picker/drop this session');
    }
  }

  // fs:register-dir: re-admit previously persisted dirs on startup (e.g. restore backup path).
  // Refusing paths not in the persisted set is the key security invariant.
  ipcMain.handle('fs:register-dir', (_event, dirPath: string) => {
    if (typeof dirPath !== 'string' || !dirPath) return { ok: false };
    const resolved = path.resolve(dirPath);
    if (!userPickedDirs.has(resolved)) return { ok: false };
    return { ok: true };
  });

  // Files (not directories) the user picked via dialog:open this session —
  // read-admitted for backup:stat / backup:read-range only.
  const userPickedFiles = new Set<string>();
  ipcMain.handle('dialog:open', async (_event, opts: Electron.OpenDialogOptions) => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, opts)
      : await dialog.showOpenDialog(opts);
    if (!result.canceled && opts.properties?.includes('openDirectory')) {
      result.filePaths.forEach(p => userPickedDirs.add(path.resolve(p)));
      persistPickedDirs(userPickedDirs);
    } else if (!result.canceled) {
      // A picked FILE admits exactly that file for backup:stat/read-range —
      // not its directory. "Restore from file" used to go through
      // fs:read-file, which rejected anything outside userData/userPickedDirs,
      // so restoring a backup from e.g. ~/Downloads failed with "Path outside
      // allowed root" unless that folder also happened to be the configured
      // backup folder. Session-only, like resolvedFilePaths.
      result.filePaths.forEach(p => userPickedFiles.add(normalizePath(path.resolve(p))));
    }
    return result;
  });

  // Open a URL in the system default browser.
  // L2: restricted to https and mailto only — http removed to prevent MITM downgrade.
  ipcMain.handle('shell:open-external', (_event, url: string) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'mailto:') return;
    shell.openExternal(url);
  });
  // CRIT-9: Confine all renderer-controlled fs operations to the app's userData
  // directory. Without this any path (e.g. ~/.ssh/id_ed25519) can be read or deleted.
  function resolveReal(p: string): string {
    // Resolve symlinks so a symlink into /etc (etc.) can't bypass the prefix check.
    // Falls back to the parent if the leaf doesn't exist yet (new file being written).
    try { return fs.realpathSync(p); } catch {}
    try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch {}
    return p;
  }

  function assertInsideUserData(filePath: string): void {
    const resolved = resolveReal(path.resolve(filePath));
    const userData = app.getPath('userData');
    // Windows NTFS is case-insensitive; realpathSync returns NTFS-canonical casing
    // which can differ from what dialog:open stored — normalise before comparison.
    const isWin = process.platform === 'win32';
    const norm = (p: string) => isWin ? p.toLowerCase() : p;
    const resolvedN = norm(resolved);
    if (resolvedN.startsWith(norm(userData) + path.sep) || resolvedN === norm(userData)) return;
    // Also allow any directory the user explicitly selected via the OS file picker.
    for (const dir of userPickedDirs) {
      const dirN = norm(path.resolve(dir));
      if (resolvedN.startsWith(dirN + path.sep) || resolvedN === dirN) return;
    }
    throw new Error(`Path outside allowed root: ${filePath}`);
  }

  /**
   * MED-6: writes are additionally allowed to EXACTLY the path the user named
   * in a `dialog:save` / `fs:save-file-as` picker this launch (see
   * `userPickedSaveFiles`). One file, write only, no directory, not persisted.
   *
   * Deliberately NOT wired into fs:read-file / fs:read-dir / fs:unlink: the
   * user consented to putting a file somewhere, which is not consent to read
   * it back or delete it later, and those three are what made the old
   * parent-directory grant a confinement bypass.
   */
  function assertWritable(filePath: string): void {
    const resolved = normalizePath(resolveReal(path.resolve(filePath)));
    if (userPickedSaveFiles.has(resolved)) return;
    assertInsideUserData(filePath);
  }

  ipcMain.handle('fs:write-file', async (event, filePath: string, data: Uint8Array) => {
    assertWritable(filePath);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from(data));
    const stat = await fs.promises.stat(filePath);
    return { ok: true, size: stat.size };
  });
  ipcMain.handle('fs:read-file', async (event, filePath: string) => {
    assertInsideUserData(filePath);
    const buf = await fs.promises.readFile(filePath);
    // Return an ArrayBuffer-compatible Uint8Array.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  ipcMain.handle('fs:read-dir', async (event, dirPath: string) => {
    assertInsideUserData(dirPath);
    return fs.promises.readdir(dirPath);
  });
  ipcMain.handle('fs:unlink', async (event, filePath: string) => {
    assertInsideUserData(filePath);
    await fs.promises.unlink(filePath);
    return { ok: true };
  });

  // Dedicated backup writer. Filename is validated to be a safe .enc name (no
  // path separators); the directory must already be admitted via
  // userPickedDirs (populated by dialog:open's openDirectory flow — the only
  // way the renderer can obtain a `dir` value in the first place, per
  // BackupSection.tsx's showOpenDialog call). Previously this handler was
  // exempt from that allowlist and self-admitted whatever directory it was
  // given — a compromised renderer could point it at any existing directory
  // and permanently grant itself fs:read-file/fs:read-dir access there. No
  // production backups predate the allowlist, so there's no migration case
  // left to support.
  ipcMain.handle('fs:write-backup-file', async (event, dir: string, filename: string, data: Uint8Array) => {
    if (typeof dir !== 'string' || !dir) throw new Error('Invalid backup dir');
    if (typeof filename !== 'string' || !filename) throw new Error('Invalid backup filename');
    if (/[/\\]/.test(filename) || filename.includes('..') || !filename.endsWith('.enc')) {
      throw new Error('Invalid backup filename — must end in .enc with no path separators');
    }
    assertInsideUserData(dir);
    const resolvedDir = path.resolve(dir);
    const stat = await fs.promises.stat(resolvedDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Backup directory does not exist: ${dir}`);
    const fullPath = path.join(resolvedDir, filename);
    await fs.promises.writeFile(fullPath, Buffer.from(data));
    const written = await fs.promises.stat(fullPath);
    return { ok: true, path: fullPath, size: written.size };
  });

  // ── Streamed single-file backup writer + ranged reader ─────────────────────
  // The backup is one `.enc` file per destination (see src/utils/
  // backupContainer.ts). The renderer encrypts records and streams them here
  // so a multi-hundred-MB vault never has to be held in one buffer or cross
  // IPC in one message. Writes go to `<name>.partial` and are fsync'd, then
  // renamed over the final name on commit — atomic on every platform Node
  // supports (Windows included: rename replaces an existing file), so the
  // single copy can never be observed half-written.
  // Two modes: 'fresh' writes a new `.partial` and renames it over the final
  // name on commit; 'update' opens the EXISTING file read-write so the
  // renderer can append changed records and patch the index pointer — the
  // in-place incremental path (src/utils/backupContainer.ts). Writes are
  // positional (tracked `pos`) so an 'r+' handle never clobbers the front.
  const backupWriteSessions = new Map<string, {
    handle: fs.promises.FileHandle; tmpPath: string; finalPath: string; createdAt: number;
    mode: 'fresh' | 'update'; pos: number;
  }>();
  // A renderer that dies mid-backup leaves its session (and .partial) behind;
  // sweep anything older than 30 minutes whenever a new session starts.
  const reapBackupWriteSessions = (): void => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [id, s] of backupWriteSessions) {
      if (s.createdAt >= cutoff) continue;
      backupWriteSessions.delete(id);
      s.handle.close().catch(() => {});
      if (s.mode === 'fresh') fs.promises.unlink(s.tmpPath).catch(() => {});
    }
  };
  const assertBackupFilename = (filename: string): void => {
    if (typeof filename !== 'string' || !filename) throw new Error('Invalid backup filename');
    if (/[/\\]/.test(filename) || filename.includes('..') || !filename.endsWith('.enc')) {
      throw new Error('Invalid backup filename — must end in .enc with no path separators');
    }
  };
  ipcMain.handle('backup:begin-write', async (event, dir: string, filename: string, mode: 'fresh' | 'update' = 'fresh') => {
    if (typeof dir !== 'string' || !dir) throw new Error('Invalid backup dir');
    if (mode !== 'fresh' && mode !== 'update') throw new Error('Invalid backup write mode');
    assertBackupFilename(filename);
    assertInsideUserData(dir);
    const resolvedDir = path.resolve(dir);
    const stat = await fs.promises.stat(resolvedDir).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`Backup directory does not exist: ${dir}`);
    reapBackupWriteSessions();
    const finalPath = path.join(resolvedDir, filename);
    const sessionId = nodeCrypto.randomUUID();
    if (mode === 'update') {
      const handle = await fs.promises.open(finalPath, 'r+');
      const size = (await handle.stat()).size;
      backupWriteSessions.set(sessionId, { handle, tmpPath: finalPath, finalPath, createdAt: Date.now(), mode, pos: size });
      return { sessionId, size };
    }
    const tmpPath = `${finalPath}.partial`;
    // 'w' truncates a stale .partial left by a crashed run.
    const handle = await fs.promises.open(tmpPath, 'w', 0o600);
    backupWriteSessions.set(sessionId, { handle, tmpPath, finalPath, createdAt: Date.now(), mode, pos: 0 });
    return { sessionId, size: 0 };
  });
  const takeSession = (sessionId: string) => {
    const s = typeof sessionId === 'string' ? backupWriteSessions.get(sessionId) : undefined;
    if (!s) throw new Error('Unknown backup write session');
    return s;
  };
  ipcMain.handle('backup:append', async (event, sessionId: string, data: Uint8Array) => {
    const s = takeSession(sessionId);
    const buf = Buffer.from(data);
    await s.handle.write(buf, 0, buf.length, s.pos);
    s.pos += buf.length;
  });
  ipcMain.handle('backup:write-at', async (event, sessionId: string, offset: number, data: Uint8Array) => {
    const s = takeSession(sessionId);
    const buf = Buffer.from(data);
    if (!Number.isInteger(offset) || offset < 0 || offset + buf.length > s.pos) throw new Error('write-at outside written range');
    // Everything appended so far is durable before the pointer that makes it
    // live is patched — the ordering the in-place update's crash safety needs.
    await s.handle.sync();
    await s.handle.write(buf, 0, buf.length, offset);
  });
  ipcMain.handle('backup:commit', async (event, sessionId: string) => {
    const s = takeSession(sessionId);
    backupWriteSessions.delete(sessionId);
    try {
      await s.handle.sync();
    } finally {
      await s.handle.close();
    }
    if (s.mode === 'fresh') await fs.promises.rename(s.tmpPath, s.finalPath);
    const written = await fs.promises.stat(s.finalPath);
    return { path: s.finalPath, size: written.size };
  });
  ipcMain.handle('backup:abort', async (event, sessionId: string) => {
    const s = backupWriteSessions.get(sessionId);
    if (!s) return;
    backupWriteSessions.delete(sessionId);
    await s.handle.close().catch(() => {});
    // An aborted in-place update leaves an orphaned tail after the old
    // index; the file still opens at its previous generation, and the tail
    // is reclaimed by the next compaction. Only a fresh .partial is removed.
    if (s.mode === 'fresh') await fs.promises.unlink(s.tmpPath).catch(() => {});
  });
  // Restore reads: allowed inside userData / a picked directory (the
  // configured backup folder) OR for a file the user just picked in the OS
  // dialog (userPickedFiles) — never anywhere else.
  const assertBackupReadable = (filePath: string): string => {
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid path');
    const resolved = path.resolve(filePath);
    if (userPickedFiles.has(normalizePath(resolved))) return resolved;
    assertInsideUserData(resolved);
    return resolved;
  };
  ipcMain.handle('backup:stat', async (event, filePath: string) => {
    const resolved = assertBackupReadable(filePath);
    const st = await fs.promises.stat(resolved).catch(() => null);
    if (!st?.isFile()) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  });
  ipcMain.handle('backup:read-range', async (event, filePath: string, offset: number, length: number) => {
    const resolved = assertBackupReadable(filePath);
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || length > 256 * 1024 * 1024) {
      throw new Error('Invalid read range');
    }
    const handle = await fs.promises.open(resolved, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, offset);
      const out = buf.subarray(0, bytesRead);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    } finally {
      await handle.close();
    }
  });

  // Stream-encrypt a file from disk using AES-256-GCM (Node.js crypto).
  // Output format: [ciphertext chunks] [16-byte GCM auth tag] — IV is returned
  // separately as ivB64 and stored in the message content, matching the layout
  // that decryptBlob expects when called with a non-null ivB64.
  // Used for large files to avoid loading the entire plaintext + ciphertext
  // into the V8 heap (which causes NotReadableError at ~2 GB+) and to
  // bypass Electron's renderer sandbox for files the Blob API can't read.
  // Fires 'net:encrypt-progress' events so the renderer can show live feedback.
  ipcMain.handle('fs:encrypt-to-temp', async (event, filePath: string): Promise<{
    tempPath: string;
    keyB64: string;
    ivB64: string;
    encryptedSize: number;
  }> => {
    // HIGH: this used to read ANY renderer-supplied path with no confinement
    // at all — a compromised renderer could stream ~/.ssh/id_ed25519 (or the
    // wrapped master-key blob, cookie DBs, etc.) through here, and the
    // resulting cl-enc-* temp file would then pass net:stream-upload's
    // assertUploadableTempFile check (which only verifies the cl-enc- prefix
    // under the temp dir), exfiltrating it plus the encryption key. Confine
    // the source to paths the preload actually resolved from a real OS file
    // handle this session (see resolvedFilePaths above).
    assertResolvedFilePath(filePath);
    const key = nodeCrypto.randomBytes(32);
    const iv  = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);

    // Write to a temp file in the system temp directory.
    const tempName = `cl-enc-${nodeCrypto.randomBytes(8).toString('hex')}`;
    const tempPath = path.join(app.getPath('temp'), tempName);
    const writeStream = fs.createWriteStream(tempPath);

    // Get file size once upfront so we can report fractional progress.
    const { size: fileSize } = await fs.promises.stat(filePath);
    let bytesRead = 0;

    // Stream through the cipher in 64 MB chunks with backpressure (P2-ELEC-11):
    // pause the read stream when the write buffer is full and resume on drain so
    // multi-GB files don't accumulate the entire ciphertext in heap.
    const readStream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const cleanup = (err?: Error) => {
        readStream.destroy();
        writeStream.destroy();
        try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
        reject(err ?? new Error('encrypt-to-temp aborted'));
      };
      readStream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const ok = writeStream.write(cipher.update(buf));
        bytesRead += buf.length;
        if (!ok) readStream.pause();
        try { event.sender.send('net:encrypt-progress', { encrypted: bytesRead, total: fileSize }); }
        catch { /* renderer may have closed */ }
      });
      writeStream.on('drain', () => readStream.resume());
      readStream.on('end', () => {
        const finalChunk = cipher.final();
        if (finalChunk.length > 0) writeStream.write(finalChunk);
        writeStream.write(cipher.getAuthTag()); // 16-byte auth tag
        writeStream.end();
      });
      readStream.on('error', cleanup);
      writeStream.on('error', cleanup);
      writeStream.on('finish', resolve);
    });

    const stat = fs.statSync(tempPath);
    return {
      tempPath,
      keyB64: key.toString('base64'),
      ivB64:  iv.toString('base64'),
      encryptedSize: stat.size,
    };
  });

  // R1: only files THIS app produced under the OS temp dir (cl-enc-* from the
  // streaming-encrypt handlers) may be uploaded. Without this an XSS'd renderer could
  // stream ANY readable path (~/.ssh/id_ed25519, the wrapped master key, cookie DBs)
  // to a public PUT URL. realpath defeats symlink escape out of the temp dir.
  function assertUploadableTempFile(filePath: string): void {
    let resolved: string;
    try { resolved = fs.realpathSync(path.resolve(filePath)); }
    catch { throw new Error('Upload source not found'); }
    const tempReal = fs.realpathSync(path.resolve(app.getPath('temp')));
    const base = path.basename(resolved);
    if (resolved.startsWith(tempReal + path.sep) && base.startsWith('cl-enc-')) return;
    throw new Error('Refusing to upload a file outside the encryption temp area');
  }

  // Stream a local file to a presigned PUT URL via Node.js https/http.
  // Sends 'net:upload-progress' events to the renderer for progress display.
  // The temp file is NOT deleted here — caller is responsible for cleanup.
  ipcMain.handle('net:stream-upload', async (event, params: {
    url: string;
    filePath: string;
    contentType: string;
    size: number;
  }): Promise<void> => {
    const { url, filePath, contentType, size } = params;
    // R1: confine the upload source to our own encryption temp files.
    assertUploadableTempFile(filePath);

    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Only http/https upload URLs are allowed');
    }
    const useHttps = parsed.protocol === 'https:';

    // In dev, presigned URLs resolve to the local Caddy dev server (private LAN IP
    // via the Windows hosts file). Two problems arise that don't exist in prod:
    //   1. assertPublicHttpUrl blocks the private IP (192.168.x.x is RFC1918).
    //   2. Node's https.request uses OpenSSL, which does NOT read the Windows cert
    //      store, so even if the Caddy root CA is imported in Windows Trusted Root,
    //      Node will reject the self-signed cert with "unable to get local issuer
    //      certificate". Only the Chromium renderer (net.fetch) uses the Windows store.
    // In production the presigned URL resolves to a real public IP (SSRF passes) and
    // Caddy uses a Let's Encrypt cert that OpenSSL trusts — no special handling needed.
    const isDev = !!DEV_SERVER_URL;
    let uploadOpts: Parameters<typeof https.request>[1] & Parameters<typeof http.request>[1] = {
      method: 'PUT',
      headers: { 'Content-Type': contentType, 'Content-Length': size },
    };
    if (isDev) {
      if (useHttps) {
        uploadOpts.agent = new https.Agent({ rejectUnauthorized: false });
      }
    } else {
      // SSRF guard: reject non-public targets; pin the IP to prevent DNS-rebind (R4).
      const target = await assertPublicHttpUrl(url);
      uploadOpts.lookup = pinnedLookup(target);
    }

    await new Promise<void>((resolve, reject) => {
      const onResponse = (res: http.IncomingMessage) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Upload failed: HTTP ${res.statusCode}`));
        } else {
          resolve();
        }
        res.resume(); // drain
      };

      const req = useHttps ? https.request(url, uploadOpts, onResponse) : http.request(url, uploadOpts, onResponse);
      req.on('error', reject);

      let uploaded = 0;
      const readStream = fs.createReadStream(filePath);
      readStream.on('data', (chunk: string | Buffer) => {
        const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        uploaded += len;
        event.sender.send('net:upload-progress', { uploaded, total: size });
      });
      readStream.on('error', reject);
      readStream.pipe(req);
    });
  });

  // ── Chunk-based streaming encryption ───────────────────────────────────────
  // The renderer reads the source File in 16 MB slices (File.slice().arrayBuffer()),
  // which never stresses the V8 heap regardless of total file size. Each slice is
  // transferred here via IPC, encrypted with a persistent AES-256-GCM streaming
  // cipher, and written to a temp file.
  // Output format: [ciphertext] [16-byte GCM auth tag] — IV returned separately
  // as ivB64 and stored in the message content, matching decryptBlob's ivB64 path.
  // This replaces the old getPathForFile / encryptFileToTemp approach, which was
  // unreliable because File.path was removed in Electron 32.
  interface ChunkEncryptSession {
    key: Buffer;
    iv: Buffer;
    cipher: nodeCrypto.CipherGCM;
    writeStream: fs.WriteStream;
    tempPath: string;
    createdAt: number; // P2-ELEC-18: for stale-session sweep
  }
  const chunkEncryptSessions = new Map<string, ChunkEncryptSession>();

  // P2-ELEC-18: Reap stale sessions left open by a renderer crash (or abandon).
  // Called on render-process-gone and by a 30-minute periodic sweep.
  function reapChunkEncryptSessions(maxAgeMs = 30 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, s] of chunkEncryptSessions) {
      if (s.createdAt < cutoff) {
        chunkEncryptSessions.delete(id);
        try { s.writeStream.destroy(); } catch { /* ignore */ }
        fs.promises.unlink(s.tempPath).catch(() => { /* best-effort */ });
        console.warn(`[Main] Reaped stale chunk-encrypt session ${id}`);
      }
    }
  }

  // Reap ALL sessions when the renderer dies mid-upload. mainWindow is
  // `BrowserWindow | null` and TS re-widens it after the awaits earlier in
  // this function, so it can't prove non-null here even though it always is
  // in practice at this point in createWindow's startup sequence.
  if (mainWindow) {
    mainWindow.webContents.on('render-process-gone', () => {
      for (const [id, s] of chunkEncryptSessions) {
        chunkEncryptSessions.delete(id);
        try { s.writeStream.destroy(); } catch { /* ignore */ }
        fs.promises.unlink(s.tempPath).catch(() => { /* best-effort */ });
      }
    });
  }

  // Periodic sweep for sessions abandoned without a crash (e.g. navigation).
  setInterval(() => reapChunkEncryptSessions(), 30 * 60 * 1000).unref();

  ipcMain.handle('crypto:chunk-encrypt-begin', async (): Promise<{ sessionId: string }> => {
    const key = nodeCrypto.randomBytes(32);
    const iv  = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);

    const tempName = `cl-enc-${nodeCrypto.randomBytes(8).toString('hex')}`;
    const tempPath = path.join(app.getPath('temp'), tempName);
    const writeStream = fs.createWriteStream(tempPath);

    const sessionId = nodeCrypto.randomBytes(16).toString('hex');
    chunkEncryptSessions.set(sessionId, { key, iv, cipher, writeStream, tempPath, createdAt: Date.now() });
    return { sessionId };
  });

  ipcMain.handle('crypto:chunk-encrypt-write', async (_event, sessionId: string, chunk: Uint8Array): Promise<void> => {
    const session = chunkEncryptSessions.get(sessionId);
    if (!session) throw new Error(`No chunk-encrypt session: ${sessionId}`);
    const encrypted = session.cipher.update(Buffer.from(chunk));
    await new Promise<void>((resolve, reject) => {
      session.writeStream.write(encrypted, (err) => err ? reject(err) : resolve());
    });
  });

  ipcMain.handle('crypto:chunk-encrypt-end', async (_event, sessionId: string): Promise<{
    tempPath: string;
    keyB64: string;
    ivB64: string;
    encryptedSize: number;
  }> => {
    const session = chunkEncryptSessions.get(sessionId);
    if (!session) throw new Error(`No chunk-encrypt session: ${sessionId}`);
    chunkEncryptSessions.delete(sessionId);

    // Finalise cipher, append auth tag, flush and close the write stream.
    await new Promise<void>((resolve, reject) => {
      const finalBuf = session.cipher.final();
      const authTag  = session.cipher.getAuthTag();
      if (finalBuf.length > 0) session.writeStream.write(finalBuf);
      session.writeStream.write(authTag);
      session.writeStream.end();
      session.writeStream.once('finish', resolve);
      session.writeStream.once('error', reject);
    });

    const stat = await fs.promises.stat(session.tempPath);
    return {
      tempPath: session.tempPath,
      keyB64: session.key.toString('base64'),
      ivB64:  session.iv.toString('base64'),
      encryptedSize: stat.size,
    };
  });

  ipcMain.handle('crypto:chunk-encrypt-abort', async (_event, sessionId: string): Promise<void> => {
    const session = chunkEncryptSessions.get(sessionId);
    if (!session) return;
    chunkEncryptSessions.delete(sessionId);
    session.writeStream.destroy();
    await fs.promises.unlink(session.tempPath).catch(() => { /* best-effort cleanup */ });
  });

  // Return the Electron userData path so the renderer can construct paths for
  // local encrypted GIF storage (see gifStorage.ts).
  ipcMain.handle('app:get-user-data-path', () => app.getPath('userData'));

  // Machine hostname for device labels. Lives here (not the preload) because
  // the sandboxed preload can't load Node's `os` module.
  ipcMain.handle('app:get-device-name', () => {
    try { return os.hostname() || 'Desktop'; } catch { return 'Desktop'; }
  });

  // Fetch a remote URL from the main process so the renderer can retrieve
  // cross-origin images (e.g. hotlink-protected GIFs) without CORS errors.
  // Returns { b64: string, mimeType: string } — the caller converts to a Blob.
  const FETCH_IMAGE_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
    'image/avif', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
  ]);
  const FETCH_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB cap

  // R4: SSRF-hardened image fetch. Validates + PINS the resolved IP on every hop
  // (including redirects) so a renderer-supplied URL can't be DNS-rebound to a
  // private/loopback target between the check and the connect. Uses Node http/https
  // (not net.fetch) so the resolver can be pinned via `lookup`. Enforces the image
  // content-type allowlist + 25 MiB cap and refuses non-image bodies.
  async function fetchImagePinned(rawUrl: string, redirectsLeft = 3): Promise<{ b64: string; mimeType: string }> {
    const target = await assertPublicHttpUrl(rawUrl);
    const useHttps = new URL(rawUrl).protocol === 'https:';
    return await new Promise((resolve, reject) => {
      const req = (useHttps ? https : http).request(rawUrl, {
        method: 'GET',
        lookup: pinnedLookup(target),
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'image/*,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'Referer': '',
        },
      }, (res) => {
        const status = res.statusCode || 0;
        // Follow a bounded number of redirects, re-validating + re-pinning each hop.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume(); // drain
          if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return; }
          let next: string;
          try { next = new URL(res.headers.location, rawUrl).toString(); }
          catch { reject(new Error('Bad redirect location')); return; }
          fetchImagePinned(next, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) { res.resume(); reject(new Error(`HTTP ${status}`)); return; }
        const mimeType = (res.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
        if (!FETCH_IMAGE_TYPES.has(mimeType)) { res.resume(); reject(new Error(`Refusing non-image content-type: ${mimeType}`)); return; }
        if (Number(res.headers['content-length'] || 0) > FETCH_MAX_BYTES) { res.resume(); reject(new Error('Remote image exceeds size cap')); return; }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (c: Buffer) => {
          total += c.length;
          if (total > FETCH_MAX_BYTES) { reject(new Error('Remote image exceeds size cap')); req.destroy(); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ b64: Buffer.concat(chunks).toString('base64'), mimeType }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Request timed out')));
      req.end();
    });
  }

  ipcMain.handle('net:fetch-binary', async (event, url: string) => {
    return await fetchImagePinned(url);
  });

  // --- Global Shortcuts (call controls — work even when Cipherline is not focused) ---
  // The renderer sends a map of { accelerator: actionId }.  We unregister all
  // previous shortcuts and register the new ones.  When a shortcut fires we send
  // a 'global-shortcut-fired' event to the renderer which dispatches the action.
  let registeredGlobalShortcuts: string[] = [];

  ipcMain.handle('keybinds:sync-global-shortcuts', async (_event, map: Record<string, string>) => {
    // Unregister all previously registered shortcuts
    for (const accel of registeredGlobalShortcuts) {
      try { globalShortcut.unregister(accel); } catch {}
    }
    registeredGlobalShortcuts = [];

    // Register new ones. Registration commonly fails on Linux Wayland
    // compositors (no stable global-shortcut portal support in Electron yet)
    // — report failed action ids back so the renderer can fall back to a
    // focused-window-only local listener for those instead of going silent.
    const failedActionIds: string[] = [];
    for (const [accelerator, actionId] of Object.entries(map)) {
      try {
        const ok = globalShortcut.register(accelerator, () => {
          mainWindow?.webContents.send('global-shortcut-fired', actionId);
        });
        if (ok) {
          registeredGlobalShortcuts.push(accelerator);
        } else {
          console.warn(`[GlobalShortcut] Failed to register: ${accelerator} → ${actionId}`);
          failedActionIds.push(actionId);
        }
      } catch (err: any) {
        console.warn(`[GlobalShortcut] Error registering ${accelerator}:`, err.message);
        failedActionIds.push(actionId);
      }
    }
    console.log(`[GlobalShortcut] Registered ${registeredGlobalShortcuts.length} global shortcuts`);

    // Additionally register with KDE's own KGlobalAccel on Linux — Electron's
    // globalShortcut above can report success without the shortcut ever
    // actually firing on some Wayland compositors, so this is genuinely
    // additive, not just a fallback for reported failures. See
    // kde-global-shortcuts.ts for the (unverified-live) caveats. Never lets
    // a KDE-side failure affect what's reported as `failed` above — the
    // renderer's focused-window listener is the real safety net either way.
    try {
      await syncKdeGlobalShortcuts(map, (actionId) => {
        mainWindow?.webContents.send('global-shortcut-fired', actionId);
      });
    } catch (err: any) {
      console.warn('[KGlobalAccel] sync failed:', err?.message ?? err);
    }

    return { failed: failedActionIds };
  });

  // Clean up global shortcuts when the app quits
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    teardownKdeGlobalShortcuts().catch(() => {});
  });

  // --- Screen Lock: notify the renderer when the OS locks/sleeps ---
  // 'lock-screen' fires on Windows + macOS only; 'suspend' fires everywhere
  // but only on actual sleep/hibernate — it does NOT fire when a Linux
  // session is locked while the machine stays awake (Meta+L, idle lock,
  // etc.), which is the common case. watchLinuxScreenLock covers that via
  // the freedesktop ScreenSaver D-Bus signal instead (see its own doc
  // comment). Push-only — no renderer input involved, so no isTrustedSender
  // check needed (nothing privileged is being granted).
  const notifyOsLock = () => mainWindow?.webContents.send('os-lock-screen');
  powerMonitor.on('lock-screen', notifyOsLock);
  powerMonitor.on('suspend', notifyOsLock);
  const stopWatchingLinuxScreenLock = watchLinuxScreenLock(notifyOsLock);
  app.on('will-quit', () => stopWatchingLinuxScreenLock());

  // --- Wake: tell the renderer to force a fresh WebSocket connection ---
  // 'resume' is the suspend/hibernate counterpart above; 'unlock-screen' also
  // fires on Windows/macOS when the screen unlocks WITHOUT a suspend (the
  // common case for a laptop that was only screen-locked, not asleep) — both
  // are real "we may have missed traffic" moments. This is the fix for the
  // long-standing "app is stale after sleep" bug: a WebSocket left OPEN
  // across a sleep is a zombie (the OS drops the TCP connection silently, but
  // the JS-visible readyState never changes), so nothing else in the app
  // would otherwise notice until the next scheduled heartbeat proves it dead.
  // Firing forceReconnect eagerly here just makes recovery instant instead of
  // waiting out that watchdog. Push-only, same no-isTrustedSender reasoning
  // as notifyOsLock above.
  const notifyOsResume = () => mainWindow?.webContents.send('os-resume');
  powerMonitor.on('resume', notifyOsResume);
  powerMonitor.on('unlock-screen', notifyOsResume);

  // Second, higher-level wake signal on the SAME events, for a different
  // consumer: Dashboard.tsx's rehydrateAll() (repairs conversations/friends/
  // servers state, and — Phase M, reliability audit — backstops a call that
  // ended while the device was asleep with no socket to hear about it).
  // notifyOsResume above already forces useRealtime's WS reconnect; this is
  // deliberately a second, differently-named dispatch rather than folding
  // into that one, since the two consumers were built independently and
  // react to genuinely different concerns (socket liveness vs. app-data
  // staleness) — see Dashboard.tsx's onAppResumed effect.
  const notifyAppResumed = () => mainWindow?.webContents.send('app:resumed');
  powerMonitor.on('resume', notifyAppResumed);
  powerMonitor.on('unlock-screen', notifyAppResumed);

  // Coalesced power picture (power-events.ts): pauses the freeze monitor and
  // the game scan across sleep, flushes written-behind vault changes before
  // it, staggers the main process's own post-wake work, and sends the
  // renderer ONE `power:resumed` per wake. Every signal is also a row in the
  // Performance log.
  const POWER_SIGNALS: PowerSignal[] = ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-ac', 'on-battery'];
  for (const sig of POWER_SIGNALS) {
    powerMonitor.on(sig as Parameters<typeof powerMonitor.on>[0], () => {
      freezeMonitor.event(`power:${sig}`);
      power.handle(sig);
    });
  }
  try { power.handle(powerMonitor.isOnBatteryPower() ? 'on-battery' : 'on-ac'); } catch { /* unsupported */ }
  app.on('will-quit', () => power.dispose());

  // --- Screenshare IPC Handlers ---
  // EVERY desktopCapturer.getSources() in this process goes through this one
  // gate: one call at a time, identical waiting/running calls shared, and
  // each call's queue wait + run time in the Performance log (so a slow or
  // stuck enumeration is visible in a diagnostics report). See
  // ./desktop-sources.ts for why stacked calls were dangerous on Windows.
  //
  // WHERE it runs is PICKER_ENUMERATION: with DXGI enabled in this process
  // (Automatic on a 24H2+ desktop, the "DXGI" setting, pre-24H2 Windows) the
  // list comes from the helper process (./sources-helper.ts, DXGI disabled
  // there) and this process never calls desktopCapturer at all — there is no
  // in-process fallback, because that fallback IS the freeze. Either way the
  // result is the same ListedSource shape, previews already JPEG-encoded.
  const sourcesHelper = PICKER_ENUMERATION === 'helper'
    ? createSourcesHelperClient({
      launch: () => launchSourcesHelper({
        command: process.execPath,
        // Packaged: the exe IS the app. Unpackaged (`electron .`): name the app dir.
        args: IS_PACKAGED ? [SOURCES_HELPER_FLAG] : [app.getAppPath(), SOURCES_HELPER_FLAG],
        connectTimeoutMs: 15_000,
      }),
      onEvent: (e) => {
        switch (e.type) {
          case 'ready':
            freezeMonitor.event('capture:sources-helper', e.ms, `ready pid=${e.pid} disable=${e.disabledFeatures || '-'}`);
            // It works on this machine: Automatic may use DXGI again next launch.
            try { fs.rmSync(SOURCES_HELPER_FAILURE_PATH, { force: true }); } catch { /* best effort */ }
            break;
          case 'start-failed':
            freezeMonitor.event('capture:sources-helper', 0, `start failed (${e.failures}): ${e.reason}`);
            break;
          case 'unavailable':
            // Next launch: Automatic falls back to WGC (no DXGI anywhere).
            try {
              fs.writeFileSync(SOURCES_HELPER_FAILURE_PATH,
                serializeSourcesHelperFailure({ version: app.getVersion(), reason: e.reason, at: Date.now() }));
            } catch { /* best effort */ }
            freezeMonitor.event('capture:sources-helper', 0, `unavailable: ${e.reason}`);
            break;
          case 'exit':
            freezeMonitor.event('capture:sources-helper', 0, `exit ${e.code ?? e.signal}`);
            break;
          case 'request-timeout':
            freezeMonitor.event('capture:sources-helper', 0, `request ${e.id} timed out; restarting`);
            break;
          case 'dropped':
            freezeMonitor.event('capture:sources-helper', 0, `request ${e.id}: ${e.count} malformed source(s) dropped`);
            break;
          default:
            break;
        }
      },
    })
    : null;
  if (sourcesHelper) app.on('will-quit', () => sourcesHelper.dispose());
  const listSourcesInProcess = async (req: { types: Array<'window' | 'screen'>; thumbnailSize: { width: number; height: number } }): Promise<ListedSource[]> => {
    const wantThumbs = req.thumbnailSize.width > 0 && req.thumbnailSize.height > 0;
    const raw = await desktopCapturer.getSources(req);
    return raw.map(s => ({
      id: s.id,
      name: s.name,
      display_id: s.display_id ?? '',
      // JPEG on main — see the measurements in 'desktop-capturer-get-sources'.
      thumbnailDataUrl: wantThumbs ? thumbnailJpegDataUrl(s.thumbnail) : '',
    }));
  };
  const desktopSources = createDesktopSourcesBroker<ListedSource>({
    getSources: (req) => (sourcesHelper ? sourcesHelper.getSources(req) : listSourcesInProcess(req)),
    onTiming: (t) => {
      freezeMonitor.event('capture:get-sources', t.runMs,
        `${t.key} n=${t.count} queued=${t.queuedMs}ms shared=${t.sharers} via=${PICKER_ENUMERATION}${t.ok ? '' : ' FAILED'}`);
    },
  });
  let cachedDesktopSources: ListedSource[] = [];
  // PIDs the native audio addon may capture: populated only when
  // audio:get-pid-from-source-id resolves a sourceId that was actually in
  // cachedDesktopSources (i.e. offered by the screen-share picker this
  // session). Without this, audio:start-window-capture took a bare `pid`
  // from the renderer with no link back to anything the user picked — any
  // JS running in the renderer could request another process's audio by PID.
  const capturedApprovedPids = new Set<number>();

  ipcMain.handle('desktop-capturer-get-sources', async (
    event,
    types?: Array<'window' | 'screen'>,
    opts?: { thumbnails?: boolean },
  ) => {
    // types lets the picker ask for JUST 'window' up front. On Wayland,
    // requesting 'screen' at all is what makes Chromium's PipeWire capturer
    // invoke the xdg-desktop-portal ScreenCast chooser — that's the native
    // "Chrome-looking" dialog users see, and it fires the INSTANT this call
    // includes 'screen', before the user has even picked a tab in our own
    // modal. Deferring it until the Screen tab is actually opened means
    // window sharing (the common case) never triggers it at all, and screen
    // sharing gets it as a single expected consent step instead of stacked
    // on top of our own picker. See ScreenSharePickerModal.tsx.
    // Renderer input: keep only the two real types (never coerce anything
    // else into a request).
    const validTypes = Array.isArray(types)
      ? types.filter((t): t is 'window' | 'screen' => t === 'window' || t === 'screen')
      : [];
    const requestedTypes: Array<'window' | 'screen'> = validTypes.length > 0 ? validTypes : ['window', 'screen'];
    console.log(`[IPC] Fetching desktop sources (types=${requestedTypes.join(',')})...`);
    try {
      // macOS: Screen Recording is a per-app TCC permission, and this call is
      // BOTH the prompt and the gate. Since electron/electron#43080 (present
      // on the 43-x-y branch we build against) getSources() runs Chromium's
      // ui::TryPromptUserForScreenCapture() — CGRequestScreenCaptureAccess() —
      // first and REJECTS with "Failed to get sources." when that returns
      // false, instead of hanging (the pre-#43080 ScreenCaptureKit bug) or
      // returning a degraded list. So on macOS an ungranted permission
      // surfaces here as a rejected promise, which the renderer pairs with
      // 'screen-capture:get-access-status' below to explain rather than render
      // as a bare "No windows found".
      //
      // Nothing is (or can be) *requested* separately: Electron's
      // askForMediaAccess covers only 'microphone' and 'camera'. This code
      // previously called `systemPreferences.askForScreenCaptureAccess()`
      // behind a `typeof … === 'function'` guard — that API has never existed,
      // so the guard was never true and the whole block was a permanent no-op.
      // It is deleted rather than replaced, because the getSources() call
      // below already IS the only prompt trigger available.
      //
      // Note the one-shot-per-process rule: once CGRequestScreenCaptureAccess
      // has returned false it keeps returning false for this process's whole
      // lifetime, even after the user grants the permission — hence the
      // renderer's "quit and reopen" guidance.
      // Thumbnails are opt-OUT: the picker renders them, but callers that only
      // need id+name (the quick-screenshare keybind, which name-matches a game
      // window and never shows a grid) can pass { thumbnails: false } and skip
      // both the per-source capture and the toDataURL() PNG encode.
      //
      // Measured on Electron 43.2.0 / Linux x64 under Xvfb, ONE screen source:
      // getSources({types:['screen']}) costs ~16ms with a 0x0 thumbnailSize and
      // ~125-220ms with a 400x400 one, plus a further ~13-17ms per source in
      // toDataURL(). So the thumbnail is roughly an order of magnitude more
      // expensive than the enumeration it rides along with, and it scales with
      // the number of sources. Those absolute figures are Linux ones and the
      // shipping client is Windows — treat the ratio as the transferable part,
      // not the milliseconds.
      const wantThumbs = opts?.thumbnails !== false;
      // A bounding box (aspect is kept): 320x200. The picker draws these in a
      // 112 px tall box (object-contain) at ~190-280 px wide, so a 16:9 screen
      // comes back 320x180 — sharp at 1.25x DPR — and a portrait monitor
      // 113x200. Smaller than the old 360x360 box (360x203 for 16:9; 203x360
      // portrait) for less scale, JPEG encode (main thread) and IPC per
      // source. The picker asks for names first ({thumbnails:false}) and these
      // second, so the grid appears before any of this is paid.
      const thumbnailSize = wantThumbs
        ? { width: 320, height: 200 }
        : { width: 0, height: 0 };
      const sources = await desktopSources.request({ types: requestedTypes, thumbnailSize });
      console.log(`[IPC] Found ${sources.length} sources (thumbnails=${wantThumbs}).`);
      // Deliberately REPLACE rather than merge. This list is not just a latency
      // cache: it is the admission list that gates per-process audio capture
      // (audio:get-pid-from-source-id) and the annotation overlay, so it must
      // stay narrowed to what the user was most recently actually offered.
      cachedDesktopSources = sources; // cache for resolve step
      return sources.map(source => ({
        id: source.id,
        name: source.name,
        // Encoded where the list was made (listSourcesInProcess, or the
        // helper process). '' when thumbnails were not asked for: callers
        // that opted out already ignore this field.
        //
        // JPEG, not toDataURL()'s PNG: in-process this encode runs on the
        // MAIN process, once per source, while the picker waits. Measured on Electron 43 /
        // Linux (400x225 screen thumbnail, same box as the figures above):
        // PNG 5.5–25 ms per image vs JPEG q85 0.8–3.2 ms (~7x), and the data
        // URL shrinks 81 KB -> 33 KB, which is also less IPC and less decode in
        // the renderer. A Windows desktop offers dozens of window sources, so
        // that is the difference between the picker blocking main for a few
        // hundred ms and a few tens. q85 is visually lossless at thumbnail size.
        thumbnailDataUrl: wantThumbs ? source.thumbnailDataUrl : ''
      }));
    } catch (err) {
      console.error('[IPC] Failed to fetch sources:', err);
      throw err;
    }
  });

  // ── macOS Screen Recording (TCC) status ───────────────────────────────────
  // Read-only probe the picker uses to tell "you have nothing open to share"
  // apart from "macOS is hiding everything because Screen Recording is off".
  // Returns exactly Electron's documented getMediaAccessStatus strings
  // ('not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'), or
  // 'not-applicable' off macOS where no such permission exists — Windows and
  // Linux keep their existing empty-state behaviour untouched.
  // Mirrored in src/utils/screenCapturePermission.ts (ScreenCaptureAccess).
  ipcMain.handle('screen-capture:get-access-status', () => {
    if (process.platform !== 'darwin') return 'not-applicable';
    try {
      return systemPreferences.getMediaAccessStatus('screen');
    } catch (err) {
      console.warn('[IPC] Screen capture status probe failed:', err);
      return 'unknown';
    }
  });

  // Deep-link System Settings → Privacy & Security → Screen Recording. The URL
  // is a hardcoded constant and the handler takes NO argument: the generic
  // 'shell:open-external' handler only permits https:/mailto:, and this must
  // not become a renderer-controlled way to launch arbitrary URL schemes.
  ipcMain.handle('screen-capture:open-privacy-settings', () => {
    if (process.platform !== 'darwin') return false;
    try {
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return true;
    } catch (err) {
      console.warn('[IPC] Failed to open Screen Recording settings:', err);
      return false;
    }
  });

  // ── Media permission handler ──────────────────────────────────────────────
  // Electron's default behaviour (no handler set) is to DENY all permission
  // requests that originate from the renderer — including getUserMedia() for
  // mic and camera. Screen sharing isn't affected because it routes through
  // setDisplayMediaRequestHandler below rather than the normal permission
  // pipeline, which is why screen share works while mic/camera don't.
  //
  // On macOS the OS-level TCC dialog (the "Cipherline wants to access your
  // Microphone" sheet) is triggered by the OS when the app first calls
  // getUserMedia AFTER Electron has already approved the permission here.
  // NSMicrophoneUsageDescription + NSCameraUsageDescription in extendInfo
  // (package.json) are the Info.plist keys that allow those prompts to appear.
  // If we call askForMediaAccess proactively in the handler the TCC prompt
  // fires at exactly the right moment — when the user actually tries to join
  // a call — rather than at an unexpected time or not at all.
  session.defaultSession.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
    if (permission === 'media') {
      if (process.platform === 'darwin') {
        // Proactively ask macOS for TCC access. askForMediaAccess is a no-op
        // (returns true immediately) if the user already granted it, and it
        // opens the system sheet the first time. After a user denial it returns
        // false but we still call callback(true) — Electron having granted the
        // permission lets the renderer surface a proper "Permission denied" error
        // via getUserMedia rather than a silent failure with no feedback.
        // Note: 'media' is the only Electron permission type that covers
        // getUserMedia — there are no separate 'microphone'/'camera' values in
        // the Electron permission union, so we discriminate on details.mediaTypes.
        //
        // Only ask for what was actually requested: this handler previously
        // awaited BOTH sheets unconditionally, so joining an audio-only call
        // made the user dismiss a camera prompt before the mic stream was even
        // attempted (and denying that one looked like the mic had failed).
        const wanted = (details as { mediaTypes?: Array<'video' | 'audio'> } | undefined)?.mediaTypes;
        const needsMic = !wanted || wanted.includes('audio');
        const needsCam = !wanted || wanted.includes('video');
        try {
          // askForMediaAccess never settles while the TCC sheet is up, and this
          // handler gates the renderer's getUserMedia. Without a ceiling, a
          // sheet the user tabs away from leaves getUserMedia pending forever —
          // a silent hang the UI can't distinguish from a slow device. On
          // timeout we fall through to callback(true) and let Chromium's own
          // TCC check produce a real, catchable error.
          const withTimeout = (p: Promise<boolean>) => Promise.race([
            p,
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), 60_000)),
          ]);
          if (needsMic && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
            await withTimeout(systemPreferences.askForMediaAccess('microphone'));
          }
          if (needsCam && systemPreferences.getMediaAccessStatus('camera') !== 'granted') {
            await withTimeout(systemPreferences.askForMediaAccess('camera'));
          }
        } catch (permErr) {
          console.warn('[Permissions] askForMediaAccess failed:', permErr);
        }
      }
      callback(true);
      return;
    }
    // Output-device selection. navigator.mediaDevices.selectAudioOutput() and
    // some setSinkId() paths request this; denying it is why picking a speaker
    // could fail with a permission error while the mic worked fine.
    if (permission === 'speaker-selection') {
      callback(true);
      return;
    }
    // HTML5 fullscreen. element.requestFullscreen() routes through THIS handler
    // in Electron, so the catch-all callback(false) below was silently rejecting
    // it — which is why the fullscreen button on a video attachment's native
    // <video controls> did nothing at all, with no error the user could see.
    //
    // Nothing else in the app noticed, because the call UI's "fullscreen" is an
    // in-app overlay (CallContext.isFullscreen), not the browser API. The only
    // consumers of the real API are Chromium's own media controls.
    //
    // Granting it is safe here: the renderer only ever loads our own origin
    // (navigation and redirects are pinned in this file), there is no untrusted
    // embedded content, and Escape exits. The main window is `fullscreenable`
    // by default — the one window that sets `fullscreenable: false` is the
    // installer splash, which has no video and no preload bridge.
    if (permission === 'fullscreen') {
      callback(true);
      return;
    }
    // Deny all other permission types we don't explicitly need.
    callback(false);
  });

  // Callback stored when Electron intercepts getDisplayMedia from the renderer
  let currentScreenshareCallback: ((response: any) => void) | null = null;

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    currentScreenshareCallback = callback;
    if (mainWindow) {
      mainWindow.webContents.send('show-screenshare-picker');
    }
  });

  ipcMain.handle('desktop-capturer-resolve', async (event, sourceId: string | null, withAudio?: boolean) => {
    if (!currentScreenshareCallback) return;
    try {
      if (!sourceId) {
        // User cancelled
        currentScreenshareCallback(null);
        return;
      }
      // Use cached sources first to avoid race with windows opening/closing
      let match = cachedDesktopSources.find(s => s.id === sourceId);
      if (!match) {
        // id + name only: the default 150x150 thumbnail would capture EVERY
        // window and screen just to look one id up.
        const fresh = await desktopSources.request({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
        match = fresh.find(s => s.id === sourceId);
      }
      if (match) {
        // This branch only runs for the Chromium getDisplayMedia fallback path —
        // on Windows with the native WASAPI addon loaded, the renderer calls
        // setScreenShareEnabled with audio:false and handles audio out-of-band.
        //
        // Electron's setDisplayMediaRequestHandler only accepts:
        //   'loopback'          — all system audio (including Cipherline itself → echo risk)
        //   'loopbackWithMute'  — all system audio, Cipherline muted locally
        //   undefined           — no audio
        // It cannot route a PulseAudio/PipeWire monitor source or per-window audio.
        //
        // So for non-Windows (and Windows-without-addon):
        //   • full-screen + audio → 'loopbackWithMute' (participants don't hear themselves echoed back;
        //                           the local user's Cipherline output is muted for the share duration).
        //   • per-window + audio  → undefined (no way to isolate one window's audio here); the renderer
        //                           surfaces a notice explaining the platform limit.
        const isWindow = sourceId.startsWith('window:');
        // HARD GUARANTEE: when the native WASAPI addon is loaded, never pass
        // 'loopbackWithMute' to Chromium. The renderer uses startWindowAudioCapture
        // for audio and passes audio:false to setScreenShareEnabled, so withAudio
        // should already be false. But if a timing edge case lets withAudio=true
        // reach here anyway, this guard prevents Cipherline from muting locally.
        const effectiveWithAudio = withAudio && !nativeAudioCaptureAvailable();
        // macOS has no Chromium loopback (Electron documents it as Windows-only),
        // so there is nothing to ask for there — never request one.
        const audioMode: 'loopbackWithMute' | undefined = effectiveWithAudio && process.platform !== 'darwin'
          ? (isWindow ? undefined : 'loopbackWithMute')
          : undefined;
        console.log(`[IPC] desktop-capturer-resolve: sourceId=${sourceId} withAudio=${withAudio} effectiveWithAudio=${effectiveWithAudio} audioMode=${audioMode} addonLoaded=${!!audioCaptureAddon} nativeAvailable=${nativeAudioCaptureAvailable()}`);
        // Electron reads only `id` and `name` here (electron_browser_context.cc
        // DisplayMediaDeviceChosen); a helper-listed source works the same.
        currentScreenshareCallback({ video: { id: match.id, name: match.name }, audio: audioMode });
      } else {
        console.error('[IPC] Source not found:', sourceId);
        currentScreenshareCallback(null);
      }
    } catch (err) {
      console.error('[IPC] Failed to resolve source:', err);
      currentScreenshareCallback(null);
    } finally {
      currentScreenshareCallback = null;
    }
  });

  // ── Desktop annotation overlay (docs/video-annotation-design.md, Phase 5) ──
  // While the local user shares a screen (or, on Windows, a window), mirror
  // the in-call annotations onto a transparent, click-through,
  // capture-excluded window over that display / window. Only sources the
  // picker actually offered are accepted (same admission rule as
  // desktop-capturer-resolve). Anything that cannot be overlaid (window
  // shares off Windows or without the addon's window_geometry, an unknown
  // display, Wayland, an X11 desktop without a compositor) resolves to a
  // refusal WITH a reason enum, which the renderer records as an
  // `annot_overlay` call event — a refused overlay used to be a bare `false`
  // plus a main-process console line nobody sees in a packaged build. On
  // Linux the overlay is captured into the share (no exclusion exists) and
  // the result says `captured: true`. Deltas are fire-and-forget: a dropped
  // frame is just a slightly later line.
  ipcMain.handle('annot-overlay:show', async (event, sourceId: unknown): Promise<OverlayShowResult> => {
    if (typeof sourceId !== 'string' || sourceId.length > 64) return { ok: false, reason: 'bad_source' };
    const kind: 'screen' | 'window' | null =
      sourceId.startsWith('screen:') ? 'screen' : sourceId.startsWith('window:') ? 'window' : null;
    if (!kind) return { ok: false, reason: 'bad_source' };
    // Platform refusals BEFORE admission: a cache miss below asks for a fresh
    // source list, and on Wayland asking for screens opens the portal chooser.
    const pre = annotationOverlayPrecheck(kind);
    if (pre) return pre;
    let src = cachedDesktopSources.find(s => s.id === sourceId);
    if (!src) {
      try {
        // No thumbnail: the overlay needs id + display_id only, and the
        // default 150x150 thumbnail capture is ~10x the enumeration cost on
        // the main process (see 'get-desktop-sources'). The overlay is now
        // created lazily on the first stroke, often long after the picker's
        // cache was replaced, so this path is no longer rare.
        const fresh = await desktopSources.request({ types: [kind], thumbnailSize: { width: 0, height: 0 } });
        src = fresh.find(s => s.id === sourceId);
      } catch { src = undefined; }
    }
    if (!src) return { ok: false, reason: 'not_offered' };
    return showAnnotationOverlay(src);
  });
  ipcMain.handle('annot-overlay:hide', () => {
    hideAnnotationOverlay();
  });
  ipcMain.on('annot-overlay:delta', (event, delta: OverlayDelta) => {
    if (!delta || typeof delta !== 'object') return;
    pushAnnotationOverlayDelta(delta);
  });

  // --- Native per-process audio capture (Windows WASAPI ApplicationLoopback) ---

  ipcMain.handle('audio:get-pid-from-source-id', (event, sourceId: string) => {
    if (!audioCaptureAddon || !nativeAudioCaptureAvailable()) return null;
    // Only resolve (and admit for capture) sourceIds the picker actually
    // offered — mirrors desktop-capturer-resolve's same check for video.
    if (!cachedDesktopSources.some(s => s.id === sourceId)) return null;
    const pid = audioCaptureAddon.getPidFromSourceId(sourceId);
    if (typeof pid === 'number') capturedApprovedPids.add(pid);
    return pid;
  });

  ipcMain.handle('audio:get-own-pid', () => process.pid);

  // Renderer capability probe — lets the screenshare audio path decide at runtime
  // whether to go through the native WASAPI addon (Windows) or fall back to
  // Electron/Chromium's getDisplayMedia audio (other platforms / missing addon).
  ipcMain.handle('audio:is-capture-supported', () => nativeAudioCaptureAvailable());

  // Display refresh rates. Screen capture is fundamentally sampling the
  // compositor's output, so it can never produce more distinct frames per
  // second than the display generates — asking for 90 fps on a 60 Hz monitor
  // yields 60 (with duplicates), and no amount of encoder or bitrate tuning
  // changes that. The picker uses this to tell the user the real ceiling
  // rather than silently under-delivering.
  //
  // Returned per display so a multi-monitor setup with a 144 Hz primary and a
  // 60 Hz secondary reports each honestly. `displayFrequency` can be 0 on some
  // Linux/virtual setups — callers treat 0 as "unknown", not as a limit.
  ipcMain.handle('display:get-refresh-rates', () => {
    return screen.getAllDisplays().map(d => ({
      id: String(d.id),
      displayFrequency: d.displayFrequency ?? 0,
      isPrimary: d.id === screen.getPrimaryDisplay().id,
    }));
  });

  // ── Screen-share diagnostics for the stream-stats overlay ────────────────
  // Everything the renderer cannot see for itself about the share it is
  // publishing: the refresh rate of the display actually being captured
  // (not just the fastest one), which OS capturer Chromium will use for it
  // (see ./capture-flags.ts), the GPUs by vendor/name, and whether Chromium's
  // GPU blocklist left hardware video encode on. Read-only; same source
  // admission rule as desktop-capturer-resolve — an unknown sourceId gets no
  // display lookup.
  ipcMain.handle('screenshare:get-diagnostics', async (_event, sourceId: unknown) => {
    const id = typeof sourceId === 'string' ? sourceId : '';
    const sourceKind: 'screen' | 'window' | 'unknown' =
      id.startsWith('screen:') ? 'screen' : id.startsWith('window:') ? 'window' : 'unknown';
    let offered = cachedDesktopSources.find(s => s.id === id);
    // The picker REPLACES this cache on every getSources call, so after a
    // window-list refresh the screen being shared is no longer in it — the
    // source of the "? Hz" report. Look screens up afresh (id+display_id
    // only, no thumbnails: ~16 ms) rather than give up. Read-only: this only
    // yields a refresh rate, it admits nothing.
    if (!offered && sourceKind === 'screen') {
      try {
        const fresh = await desktopSources.request({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        offered = fresh.find(s => s.id === id);
      } catch { /* fall back below */ }
    }
    let displayHz: number | null = null;
    let displayHzSource: string | null = null;
    try {
      const r = resolveCapturedDisplayHz({
        sourceKind,
        displayId: offered?.display_id ?? null,
        displays: screen.getAllDisplays(),
        primaryId: screen.getPrimaryDisplay().id,
      });
      displayHz = r.hz;
      displayHzSource = r.how;
    } catch { /* leave null */ }

    const windowsBuild = process.platform === 'win32' ? windowsBuildFromRelease(os.release()) : null;
    const capturer = expectedScreenCapturer({
      platform: process.platform,
      windowsBuild,
      pref: SCREEN_CAPTURER_PREF,
      sourceKind,
      waylandSession: process.env.XDG_SESSION_TYPE === 'wayland',
      prefSource: STARTUP_FLAGS.source.screenCapturer === 'file' ? 'settings' : 'env',
      auto: AUTO_CAPTURER,
    });

    let gpus: ReturnType<typeof summarizeGpuDevices> = [];
    try { gpus = summarizeGpuDevices(await app.getGPUInfo('basic')); } catch { /* none */ }
    let videoEncode: string | null = null;
    try { videoEncode = (app.getGPUFeatureStatus() as unknown as Record<string, string>).video_encode ?? null; } catch { /* none */ }

    return {
      platform: process.platform,
      windowsBuild,
      sourceKind,
      displayHz,
      displayHzSource,
      capturer,
      capturerPref: SCREEN_CAPTURER_PREF,
      gpus,
      videoEncode,
      h264CbpHwEnabled: process.platform === 'win32' || process.platform === 'linux',
      captureLog: CAPTURE_LOG_ENABLED,
    };
  });

  // Startup flags (Settings → Advanced → screen capture). `saved` is what
  // startup-flags.json holds now — what the NEXT launch will use; `active` is
  // what THIS launch applied; `envOverride` marks a value an environment
  // variable is forcing, so the UI can say why a saved choice is not in
  // effect. The file is re-read on every get so the UI can never show a
  // value main would not apply.
  const startupFlagsState = () => {
    const saved = IS_SMOKE_TEST ? { ...DEFAULT_STARTUP_FLAGS } : readStartupFlagsFile(STARTUP_FLAGS_PATH);
    return {
      platform: process.platform,
      saved,
      active: {
        screenCapturer: STARTUP_FLAGS.screenCapturer,
        captureLog: STARTUP_FLAGS.captureLog,
        // The launch-time switches only; the runtime half follows `saved`.
        gamingVideo: GAMING_VIDEO_AT_LAUNCH,
      },
      envOverride: {
        screenCapturer: STARTUP_FLAGS.source.screenCapturer === 'env',
        captureLog: STARTUP_FLAGS.source.captureLog === 'env',
      },
      captureLogPath: CAPTURE_LOG_FILE,
      captureLogMaxBytes: CAPTURE_LOG_MAX_BYTES,
    };
  };
  ipcMain.handle('app:get-startup-flags', () => startupFlagsState());
  // Merge a validated patch into the file. validateStartupFlagsPatch throws
  // on anything but known keys with exact values (the rejection reaches the
  // renderer as a failed invoke). Takes effect on the next launch only.
  ipcMain.handle('app:set-startup-flags', (_event, patch: unknown) => {
    const change = validateStartupFlagsPatch(patch);
    if (!IS_SMOKE_TEST) {
      writeStartupFlagsFile(STARTUP_FLAGS_PATH, { ...readStartupFlagsFile(STARTUP_FLAGS_PATH), ...change });
    }
    // The gaming-video mode's runtime half (process priority during a call)
    // follows the saved value at once; only its Chromium switches wait for
    // the next launch.
    if (change.gamingVideo !== undefined) syncCallPriority({ enabled: change.gamingVideo });
    return startupFlagsState();
  });
  // The renderer says a call started / ended (CallPane mount / unmount).
  // Strict boolean — validateCallMediaActive throws on anything else.
  ipcMain.handle('call:set-media-active', (_event, active: unknown) => {
    syncCallPriority({ inCall: validateCallMediaActive(active) });
  });
  // "Restart Cipherline to apply". A normal quit (before-quit handlers run:
  // replay-cache flush, presence goodbye), not app.exit — then Electron's
  // relauncher starts the app again once this process has exited, so the new
  // instance does not collide with this one's single-instance lock.
  ipcMain.handle('app:relaunch', () => {
    if (IS_SMOKE_TEST) return;
    setIsQuitting(true);
    app.relaunch();
    // Let this reply reach the renderer before windows start closing (same
    // reason as updater:quit-and-install).
    setImmediate(() => app.quit());
  });

  // Per-frame capture timing, parsed from Chromium's own log (Settings →
  // Advanced → Capture timing log). null when the log is off or has too
  // little data yet. Reads only the newest 512 KB — a few thousand frames.
  // In-call performance helper (renderer CallPerformanceGuard): the CPU of
  // the calling renderer and of the GPU process (hardware decode runs there),
  // in percent of ONE core since the previous call (Electron's
  // app.getAppMetrics semantics). Read-only, numbers only, no arguments.
  ipcMain.handle('perf:get-process-cpu', (event) => {
    try {
      const pid = event.sender.getOSProcessId();
      const metrics = app.getAppMetrics();
      const pct = (m: Electron.ProcessMetric | undefined) =>
        (m && Number.isFinite(m.cpu.percentCPUUsage) ? m.cpu.percentCPUUsage : null);
      return {
        renderer: pct(metrics.find(m => m.pid === pid)),
        gpu: pct(metrics.find(m => m.type === 'GPU')),
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('screenshare:get-capture-timing', async () => {
    if (!CAPTURE_LOG_ENABLED || !CAPTURE_LOG_FILE) return null;
    try {
      const fh = await fs.promises.open(CAPTURE_LOG_FILE, 'r');
      try {
        const { size } = await fh.stat();
        const len = Math.min(size, 512 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        return parseCaptureTimingLog(buf.toString('utf8'));
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
  });

  ipcMain.handle('audio:start-window-capture', (event, pid: number, mode: 'include' | 'exclude' = 'include') => {
    if (!audioCaptureAddon || !nativeAudioCaptureAvailable()) {
      console.warn('[Main/Audio] start-window-capture called but the native addon is not loaded/supported');
      return false;
    }
    // Confine capture to the app's own process (the 'screen'/exclude-self
    // path always targets process.pid) or a PID resolved from a picker-
    // offered source (the 'window'/include path, via get-pid-from-source-id
    // above) — never an arbitrary renderer-supplied PID.
    if (pid !== process.pid && !capturedApprovedPids.has(pid)) {
      console.warn(`[Main/Audio] Refusing capture of unapproved pid=${pid}`);
      return false;
    }
    let chunkCount = 0;
    audioCaptureAddon.startCapture(pid, mode, (chunk) => {
      // The `in` check alone is the complete discriminant — `processExited` is
      // typed as the literal `true`, so the redundant `&& chunk.processExited`
      // that used to be here only broke narrowing: negating `A && B` leaves TS
      // unable to eliminate the exited variant, so every `chunk.data` /
      // `chunk.sampleRate` below failed to compile.
      if ('failed' in chunk) {
        // macOS: ScreenCaptureKit could not start or was stopped (Screen Recording
        // not granted, the user hit the system "Stop sharing" control, target not
        // found). Terminal — release the addon and tell the renderer why so it can
        // say something better than "no audio".
        console.warn(`[Main/Audio] capture failed (${chunk.reason}): ${chunk.message}`);
        audioCaptureAddon?.stopCapture();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:capture-failed', { reason: chunk.reason });
        }
        return;
      }
      if ('processExited' in chunk) {
        // Phase K: the captured process exited mid-share. This is a terminal
        // signal from the native thread — it has already stopped itself, but
        // call stopCapture() anyway to release the addon's IAudioClient/tsfn
        // deterministically from here rather than relying on the native
        // thread's own cleanup ordering.
        console.log(`[Main/Audio] capture target pid=${pid} exited — ending capture (chunks delivered=${chunkCount})`);
        audioCaptureAddon?.stopCapture();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('audio:capture-process-exited');
        }
        return;
      }
      chunkCount++;
      if (chunkCount === 1 || chunkCount % 200 === 0) {
        console.log(`[Main/Audio] chunks=${chunkCount} sr=${chunk.sampleRate} ch=${chunk.channels} bytes=${chunk.data.byteLength}`);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Convert Buffer to a standalone ArrayBuffer before sending.
        // Node.js Buffers are allocated from a pool and may have byteOffset > 0.
        // When contextBridge clones the data into the renderer world it preserves
        // the underlying ArrayBuffer (the whole pool), not just the Buffer's slice —
        // so the renderer would see wrong byteLength/byteOffset. Slicing here
        // creates a new, correctly-sized ArrayBuffer with byteOffset = 0.
        const buf = chunk.data;
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        mainWindow.webContents.send('audio:chunk', {
          sampleRate: chunk.sampleRate,
          channels:   chunk.channels,
          data:       ab,
        });
      }
    });
    console.log(`[Main/Audio] startCapture requested pid=${pid} mode=${mode}`);
    return true;
  });

  ipcMain.handle('audio:stop-window-capture', () => {
    if (!audioCaptureAddon) return;
    audioCaptureAddon.stopCapture();
  });

  // ── Auto-updates (production only) ────────────────────────────────────
  // Feed URL is baked into the build by electron-builder via the `publish`
  // block in package.json (https://updates.cipherline.chat). The updater
  // fetches <channel>.yml, verifies SHA512, downloads the new installer in
  // the background, and installs on next quit.
  //
  // Auto-install does NOT work on every platform this app ships on — see
  // electron/updater-state.ts's module doc for the full reasoning (macOS
  // needs a code signature electron-updater's Squirrel.Mac delegate refuses
  // to work without, and Linux needs to genuinely be running as the AppImage
  // Electron launched from). Rather than hard-code that per-platform, the
  // full lifecycle (available → downloading → ready, OR available/downloading
  // → error → manual-download-link) is pushed to the renderer over
  // `update:state` and updater-state.ts's pure transition functions decide
  // what each event means. See docs/desktop-code-signing.md to close the
  // macOS gap for real.
  //
  // Channel selection: autoUpdater.channel picks which manifest to fetch.
  //   'latest'  → latest.yml / latest-mac.yml (the default; what real users see).
  //   'staging' → staging.yml / staging-mac.yml (only opt-in clients).
  // The choice is persisted via secureStore under 'updateChannel' so it
  // survives restarts. Renderer flips it via the `updater:set-channel` IPC
  // (from the Settings → Advanced tab).
  //
  // The MIN_CLIENT_VERSION gate on the server is the *enforcement* layer —
  // this path is just the convenient happy-path delivery mechanism.
  type UpdateChannel = 'latest' | 'staging';
  const readChannel = (): UpdateChannel => {
    try {
      const v = secureStore.get('updateChannel');
      if (v === 'staging' || v === 'latest') return v;
      // No explicit preference stored — infer from the running version.
      // Prerelease builds (e.g. 1.0.5-staging.51) default to the staging
      // channel so they don't immediately "downgrade" to the latest stable.
      return app.getVersion().includes('-') ? 'staging' : 'latest';
    } catch {
      return app.getVersion().includes('-') ? 'staging' : 'latest';
    }
  };

  // Cached so a renderer that mounts after the event already fired (a
  // reload, or a fresh window on reconnect) can ask for the current state
  // instead of missing it — same cold-start problem pendingDeepLinkCode
  // solves for deep links, below.
  let updateState: UpdateStateT = { phase: 'idle' };
  const pushUpdateState = (next: UpdateStateT) => {
    updateState = next;
    console.log('[Main/Updater] state ->', JSON.stringify(next));
    mainWindow?.webContents.send('update:state', next);
  };
  // Captured from the public `update-available` event so the error handler
  // below can build a manual-download link WITHOUT reaching into
  // electron-updater's internals (its `updateInfoAndProvider` field exists
  // but is `protected`, not part of the public API, and not something to
  // depend on surviving a version bump). Cleared once we know we don't need
  // it, so a later unrelated error can't accidentally reuse a stale list.
  let lastKnownUpdateFiles: UpdateFileInfoT[] | null = null;

  // ── Barrier: everything below this point reads SecureStore synchronously ──
  //
  // readChannel() (right below), the login-item default, the start-minimized
  // and minimize-to-tray preferences and the game ignore/custom lists all call
  // secureStore.get() on this stack with no await of their own. They were safe
  // only because _doInitialize() ran synchronously; with real yield points that
  // safety is gone, and the failure mode is silent-and-wrong, not loud:
  // an un-awaited get() returns null for every key, so a user who opted into
  // the staging update channel is quietly moved back to latest, a user who
  // turned "start with Windows" OFF has it turned back on, and the game
  // ignore-list comes back empty (the "I ignored it and it came right back"
  // bug). One barrier here fixes all of them and preserves the ORIGINAL
  // ordering exactly — createWindow() already ran strictly after init before.
  //
  // Rejection is folded into a boolean rather than thrown: an init failure is
  // already logged by the .catch() on storeReady, and it must not cost the
  // user their window. Consumers below check `storeOk` before touching the
  // store, because SecureStore.get()/keys() now throw rather than lie when the
  // store never initialized.
  const storeOk = await storeReady.then(() => true, () => false);
  if (!storeOk) console.warn('[Main] SecureStore unavailable — startup preferences fall back to defaults');
  // Staging lock: settle the remembered unlock now that the store can be read
  // (no-op when not enforced, which includes the smoke test).
  loadRememberedStagingUnlock();

  // Configured once, a few seconds after the window exists (see below) or on
  // the first updater IPC, whichever comes first — not before the window.
  let updaterConfigured = false;
  const configureUpdater = () => {
    if (!UPDATER_ENABLED || updaterConfigured) return;
    updaterConfigured = true;
    const initialChannel = readChannel();
    autoUpdater.channel = initialChannel;
    autoUpdater.allowPrerelease = initialChannel === 'staging';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // ── HIGH-1 partial mitigation: shrink what a compromised update ORIGIN
    // can do, until Authenticode/notarized signing makes the origin
    // non-load-bearing.
    //
    // The unmitigated part: `provider: "generic"` fetches `latest.yml` and the
    // installer from the same host, so the sha512 in the manifest proves the
    // bytes arrived intact and nothing about who built them. electron-updater's
    // Windows integrity check IS Authenticode publisher verification and needs
    // BOTH a signed binary and `build.win.publisherName` (now configured in
    // package.json — the signing half is procurement, see
    // docs/launch-checklist.md → Code signing).
    //
    // None of the three lines below substitutes for that. They remove the
    // easiest things a hostile `latest.yml` can ask this client to do.
    //
    // No downgrades. electron-updater defaults this to false already, but the
    // default flips to true implicitly if `allowPrerelease` is ever set via
    // channel config, and the consequence here is specific: a compromised
    // origin could otherwise serve an OLDER, known-vulnerable Cipherline and
    // have every client install it as an "update". Pin it explicitly.
    autoUpdater.allowDowngrade = false;
    // No differential/blockmap download path. It is a second, more complex
    // parser fed by the same untrusted origin (a `.blockmap` whose contents
    // steer ranged reads and reassembly), bought for bandwidth we do not need.
    autoUpdater.disableDifferentialDownload = true;
    // No NSIS web-installer path. A hostile `latest.yml` should not be able to
    // select an install flow that fetches further payloads of its choosing.
    autoUpdater.disableWebInstaller = true;

    autoUpdater.on('update-available', (info) => {
      lastKnownUpdateFiles = info.files ?? null;
      pushUpdateState(onUpdateAvailable(info));
    });
    autoUpdater.on('download-progress', (progress) => {
      pushUpdateState(onDownloadProgress(updateState, progress));
    });
    autoUpdater.on('update-downloaded', (info) => {
      lastKnownUpdateFiles = null; // fully installed — nothing left to fall back to
      pushUpdateState(onUpdateDownloaded(info));
    });
    autoUpdater.on('error', (e) => {
      // Log the CODE, not just the message. `manual` is a deliberately quiet,
      // usable outcome — the user gets a working download button — so the
      // underlying failure leaves no other trace, and "it sent me to my
      // browser" is all anyone can report. That cost a full investigation on
      // 2026-09-15; the code is what makes the next one a grep.
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      console.error(`[Main/Updater] error${code ? ` [${code}]` : ''}:`, e?.message || e);
      if (code === 'ERR_UPDATER_INVALID_SIGNATURE') {
        // Almost never a hostile origin — it is nearly always us shipping an
        // unsigned installer while app-update.yml still names a publisher.
        // See apps/desktop/src/utils/electronBuilderConfig.test.ts for the
        // full mechanism and the rule about reintroducing publisherName.
        console.error(
          '[Main/Updater] Authenticode verification REJECTED the downloaded installer. ' +
          'Auto-install is impossible on this machine and every update will fall back to a manual ' +
          'browser download until it is resolved. Most likely cause: build.win.signtoolOptions.publisherName ' +
          'is configured while the build is unsigned (no CSC_LINK) — the two must be introduced together.',
        );
      }
      pushUpdateState(onUpdateError(updateState, () => {
        if (!lastKnownUpdateFiles) return null;
        return pickDownloadUrl(lastKnownUpdateFiles, process.platform, process.arch);
      }));
    });

    // Not in the startup critical path, and never in the first minute after a
    // wake: a check that finds an update starts a ~100 MB download, and
    // after a long sleep the 4-hour interval below has always elapsed, so it
    // used to fire in the same instant as the reconnect, the catch-up and
    // the OS's own resume work.
    const UPDATE_CHECK_DELAY_MS = 30_000;
    const UPDATE_RESUME_QUIET_MS = 90_000;
    let lastWakeAt = 0;
    power.onPhase((phase) => { if (phase === 'resume') lastWakeAt = Date.now(); });
    const checkForUpdatesQuietly = () => {
      const sinceWake = Date.now() - lastWakeAt;
      if (sinceWake < UPDATE_RESUME_QUIET_MS) {
        setTimeout(checkForUpdatesQuietly, UPDATE_RESUME_QUIET_MS - sinceWake).unref();
        return;
      }
      autoUpdater.checkForUpdates().catch(() => { /* logged by the 'error' listener */ });
    };
    console.log(`[Main/Updater] channel=${initialChannel} — first check in ${UPDATE_CHECK_DELAY_MS / 1000}s`);
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((e) => {
        console.warn('[Main/Updater] initial check failed:', e?.message || e);
      });
    }, UPDATE_CHECK_DELAY_MS).unref();
    setInterval(checkForUpdatesQuietly, 4 * 60 * 60 * 1000);
  };

  // (dev-only) drive the whole state machine without a real release, so the
  // UI can be exercised on `npm run dev:windows` — see updater-state.ts for
  // what each phase means. Registered only in an unpackaged build WITH a dev
  // server, which is strictly narrower than `UPDATER_ENABLED`'s complement:
  // in a packaged build the channel does not exist at all, so there is nothing
  // to invoke even before the sender check runs.
  if (DEV_SERVER_URL) {
    ipcMain.handle('updater:__simulate', (_e, phase: 'available' | 'downloading' | 'ready' | 'manual') => {
      const v = '9.9.9-simulated';
      if (phase === 'available') pushUpdateState({ phase: 'available', version: v });
      else if (phase === 'downloading') pushUpdateState({ phase: 'downloading', version: v, percent: 42 });
      else if (phase === 'ready') pushUpdateState({ phase: 'ready', version: v });
      else pushUpdateState({ phase: 'manual', version: v, downloadUrl: `${UPDATE_BASE_URL}/Cipherline-${v}.dmg` });
    });
  }

  ipcMain.handle('updater:get-state', () => updateState);

  /**
   * Force an update check right now, on demand from Settings → Advanced.
   *
   * The schedule above (one check at startup, then every 4h) is the normal
   * path; this exists because there was previously no way to answer "has the
   * fix I'm waiting for shipped yet?" — the only lever that forced a check was
   * toggling the update channel back and forth, which works purely by side
   * effect and actually changes which release stream the client follows.
   *
   * Resolves true when a real check was dispatched, false when this build has
   * no updater to ask. That guard is `UPDATER_ENABLED`, the same constant used
   * by the block that registers the autoUpdater listeners above: when it didn't
   * run, autoUpdater.channel was never set and checkForUpdates() throws about a
   * missing dev-app-update.yml. Returning false rather than pretending success
   * lets the UI say "not in this build" instead of a reassuring, wrong "you're
   * up to date".
   *
   * A genuine failure rejects (Electron delivers it to the renderer's invoke)
   * so the UI can show an error. The 'error' listener above still logs it and
   * decides the shared update state; this only reports the outcome of the one
   * click that asked.
   */
  ipcMain.handle('updater:check-now', async (): Promise<boolean> => {
    if (!UPDATER_ENABLED) return false;
    configureUpdater();
    console.log('[Main/Updater] manual check requested');
    await autoUpdater.checkForUpdates();
    return true;
  });

  ipcMain.handle('updater:quit-and-install', () => {
    // Only meaningful in a real install; no-op in dev and under the smoke test.
    if (!UPDATER_ENABLED) return;
    configureUpdater();
    // Mark quitting so window-all-closed lets the app fully exit on macOS
    // (the default darwin behaviour keeps the process alive after all windows
    // close, which causes quitAndInstall to appear frozen — windows disappear
    // but the process never exits and the new version never launches).
    setIsQuitting(true);
    // Hide the main window immediately so the old app doesn't bleed through
    // behind the NSIS installer dialog while it waits for windows to close.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
    // Defer one tick so this IPC handler can return before quitAndInstall
    // starts closing windows. Calling it synchronously deadlocks: the renderer
    // is blocked waiting for the IPC reply while the main process is waiting
    // for windows to close.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });
  ipcMain.handle('updater:get-channel', () => {
    return readChannel();
  });

  /**
   * HIGH-2 — switch which release stream this install follows.
   *
   * This handler shipped with NO sender check while 77 others in this file had
   * one, and it is the worst place in the app for that omission: the choice is
   * persisted in SecureStore (it survives restarts), it immediately re-checks,
   * and `staging` auto-publishes on every push to the `staging` branch whereas
   * `latest` needs a manual workflow_dispatch. So one silent IPC call from a
   * compromised renderer converts "can push to the staging branch" into "can
   * execute code on this user's machine, permanently". `installIpcSenderGuard`
   * now covers this by construction; the explicit check stays as documentation
   * of why this one matters.
   *
   * On top of the sender check, switching TO `staging` requires the user to
   * confirm in a NATIVE dialog. Electron gives IPC no trustworthy user-gesture
   * signal — there is no `isUserGesture` on an invoke event, and window focus
   * or visibility is trivially satisfied by the same compromised renderer — so
   * a main-process modal is the only consent a hostile renderer cannot forge or
   * click for itself. It is asked only in the privilege-increasing direction:
   * moving back to `latest` narrows what this machine will install, so gating
   * it would only make the safe direction harder. The prompt is skipped when
   * there is no updater at all (dev, smoke test), which keeps
   * `npm run dev:windows` modal-free.
   */
  ipcMain.handle('updater:set-channel', async (event, channel: UpdateChannel) => {
    const ch: UpdateChannel = channel === 'staging' ? 'staging' : 'latest';

    // Staging lock: the password gate comes BEFORE the native consent dialog,
    // and it is enforced here, not in the renderer. A distinct error code so
    // the Settings UI can open its password prompt instead of a generic error.
    // Asking for stable is never gated (see decideSetChannel).
    if (decideSetChannel({ requested: ch, enforced: STAGING_LOCK.enforced, unlocked: isStagingUnlocked() }) === 'refuse-locked') {
      throw new Error(STAGING_LOCKED_ERROR);
    }

    if (ch === 'staging' && UPDATER_ENABLED && readChannel() !== 'staging') {
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        buttons: ['Cancel', 'Switch to Staging'],
        defaultId: 0,
        cancelId: 0,
        title: 'Switch to the Staging update channel?',
        message: 'Switch Cipherline to Staging builds?',
        detail:
          'Staging builds are published automatically and are not release-tested. ' +
          'Cipherline will download and install them on this computer from now on, ' +
          'until you switch back to Stable.\n\n' +
          'Only do this if you were asked to test a pre-release build.',
        noLink: true,
      };
      const { response } = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, opts)
        : await dialog.showMessageBox(opts);
      // Anything but the explicit confirm button leaves the channel alone and
      // reports the channel that is actually in effect, so the Settings toggle
      // snaps back instead of lying about what this install will now fetch.
      if (response !== 1) return readChannel();
    }

    applyUpdateChannel(ch);
    return ch;
  });

  function applyUpdateChannel(ch: UpdateChannel): void {
    secureStore.set('updateChannel', ch);
    if (UPDATER_ENABLED) {
      configureUpdater();
      autoUpdater.channel = ch;
      autoUpdater.allowPrerelease = ch === 'staging';
      // Re-check immediately so a switch from latest → staging surfaces a
      // staging build right away (or vice versa). Errors are logged by the
      // 'error' listener registered above; don't crash the IPC.
      autoUpdater.checkForUpdates().catch(() => { /* ignore */ });
    }
  }

  // ── Staging lock IPC (state + policy: see STAGING_LOCK near the top) ──
  // All three go through installIpcSenderGuard like every other channel.
  ipcMain.handle('staging-lock:status', (): StagingLockStatus => stagingLockStatus());

  /**
   * Verify the staging password. Constant-time scrypt (~100 ms, synchronous on
   * purpose: two concurrent calls cannot interleave around the limiter), with
   * the in-memory backoff in front of it. Nothing about the attempt is logged
   * — not the input, not even its length — and the password goes nowhere
   * else: it is compared here, locally, and dropped. On success the unlock is
   * remembered as a SecureStore marker bound to STAGING_VERIFIER and awaited
   * onto disk before replying, so the staging build that the channel switch
   * goes on to download (and installs on quit) finds it at launch. If that
   * write fails the device is still unlocked for this launch and will simply
   * ask again next time.
   *
   * Everything up to and including `stagingUnlocked = true` is synchronous,
   * so the limiter still cannot be raced; only the durability wait yields.
   */
  ipcMain.handle('staging-lock:unlock', async (_event, password: unknown): Promise<StagingUnlockResult> => {
    if (!isAcceptablePasswordInput(password)) throw new Error('Invalid input');
    if (!STAGING_LOCK.enforced || isStagingUnlocked()) return { ok: true, retryAfterMs: 0 };
    const wait = stagingAttempts.retryAfterMs();
    if (wait > 0) return { ok: false, retryAfterMs: wait };
    if (!verifyPassword(password, STAGING_VERIFIER)) {
      stagingAttempts.recordFailure();
      return { ok: false, retryAfterMs: stagingAttempts.retryAfterMs() };
    }
    stagingAttempts.recordSuccess();
    stagingUnlocked = true;
    if (await rememberStagingUnlock()) removeUnlockFile(STAGING_UNLOCK_PATH);
    console.log('[Main/StagingLock] staging access unlocked on this device');
    return { ok: true, retryAfterMs: 0 };
  });

  /**
   * "Lock staging access again": forget the remembered unlock and, if this
   * install follows the staging channel, move it back to stable (a locked
   * device must not stay on a channel it could not have chosen). Re-locking
   * is the privilege-REDUCING direction, so it needs no confirmation here.
   */
  ipcMain.handle('staging-lock:relock', (): StagingLockStatus => {
    if (!STAGING_LOCK.enforced) return stagingLockStatus();
    stagingUnlocked = false;
    forgetStagingUnlock();
    if (readChannel() === 'staging') {
      try { applyUpdateChannel('latest'); } catch (e) {
        console.warn('[Main/StagingLock] relock: could not switch the channel back to stable:', (e as Error)?.message);
      }
    }
    console.log('[Main/StagingLock] staging access locked again');
    return stagingLockStatus();
  });

  console.log('[Main] all IPC handlers registered — creating window');
  await createWindow(csp, showInstaller);
  if (UPDATER_ENABLED) setTimeout(configureUpdater, 5000);

  // When the installer splash is up, the main window starts hidden. Treat its
  // first paint ('ready-to-show') as the final startup milestone, then let the
  // gate reveal it (after the completion animation + 1s). 'did-finish-load' is
  // a belt-and-braces fallback in case 'ready-to-show' doesn't fire.
  if (showInstaller && mainWindow) {
    splashSendProgress(80);
    mainWindow.once('ready-to-show', () => {
      splashSendProgress(94);
      installerGate?.rendererDone();
    });
    mainWindow.webContents.once('did-finish-load', () => {
      splashSendProgress(94);
      installerGate?.rendererDone();
    });
  }

  // ── Start with Windows: default ON (packaged only) + login-item refresh ──
  // One-time default so a fresh install auto-starts at login without a trip to
  // Settings; the flag means the user's later choice (either way) is never
  // overridden again. The else-branch re-registers an already-enabled login
  // item every boot — idempotent, and it retrofits the `--autostart` marker
  // onto login items created before the marker existed (without it, their
  // login launches would be indistinguishable from manual ones below).
  // Never in dev: setLoginItemSettings would register the bare electron
  // binary as a login item. Never under the CI smoke test either, for two
  // reasons: it would register Cipherline as a login item on the shared CI
  // runner, and SecureStore.initialize() deliberately skips assigning its
  // file paths under CIPHERLINE_SMOKE_TEST ("doesn't exercise the store"),
  // so the unguarded set() below became rename('.tmp', '') → ENOENT and
  // failed every staging build at the smoke gate.
  // `storeOk` (see the barrier above) is load-bearing here, not belt-and-braces:
  // without a readable store, `loginItemDefaultApplied` reads as absent and this
  // would re-enable "start with Windows" for a user who deliberately turned it
  // off — then fail on the set() that is supposed to record the decision.
  if (storeOk && IS_PACKAGED && !IS_SMOKE_TEST
      && (process.platform === 'win32' || process.platform === 'darwin')) {
    if (secureStore.get('loginItemDefaultApplied') !== 'true') {
      app.setLoginItemSettings({ openAtLogin: true, args: ['--autostart'] });
      secureStore.set('loginItemDefaultApplied', 'true');
    } else if (app.getLoginItemSettings().openAtLogin) {
      app.setLoginItemSettings({ openAtLogin: true, args: ['--autostart'] });
    }
  }

  // Apply the start-minimized preference — but ONLY to login-item launches.
  // A manual open (double-clicking the icon) always shows the window: the
  // user just asked for the app, minimizing it at them is never right. Login
  // launches are identified by the `--autostart` arg the login item carries
  // (Windows) or wasOpenedAtLogin (macOS). Skipped during the installer flow —
  // the splash owns window visibility and reveals the main window itself.
  const launchedAtLogin = process.argv.includes('--autostart') ||
    (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
  if (!showInstaller && launchedAtLogin && storeOk && secureStore.get('startMinimized') !== 'false') {
    mainWindow?.minimize();
  }

  // Initialize tray icon if minimize-to-tray was previously enabled.
  updateTray(storeOk && secureStore.get('minimizeToTray') === 'true');

  // ── Cold-start deep link (Windows / Linux) ────────────────────────────────
  // When the user clicks a cipherline:// URL on a fresh launch, the OS passes
  // the URL in process.argv.  Park the code so App.tsx / AuthScreen can pull
  // it after React mounts — avoids the race where the push IPC fires before
  // the useEffect listener is registered in the renderer.
  const coldStartUrl = extractDeepLinkFromArgv(process.argv);
  if (coldStartUrl) {
    const inviteCode = parseInviteUrl(coldStartUrl);
    if (inviteCode) { pendingDeepLinkCode = inviteCode; }
    else {
      const refCode = parseReferralUrl(coldStartUrl);
      if (refCode) pendingDeepLinkRef = refCode;
    }
  } else {
    // `--referral=<CODE>` / `--invite=<CODE>`: the same hand-over for an
    // installer or stub that has no URL to pass. Nothing sets these today.
    const fromArgv = parseAttributionArgv(process.argv);
    if (fromArgv?.kind === 'ref') pendingDeepLinkRef = fromArgv.code;
    else if (fromArgv?.kind === 'invite') pendingDeepLinkCode = fromArgv.code;
  }

  // ── Game Detection ────────────────────────────────────────────────────────
  // Poll running processes every 10 seconds and notify the renderer when a
  // game starts or stops. Same detection approach as Discord.
  //
  // The ignore list and custom games are MIRRORED into SecureStore here, and
  // loaded BEFORE the first poll. They used to live only in the renderer,
  // synced over IPC after Dashboard mounted — so the immediate startup poll
  // (and any getCurrentGame() that raced the sync) ran with an EMPTY ignore
  // list and re-detected games the user had explicitly ignored. That was the
  // "I ignored it and it came right back" bug: ignoring worked until the next
  // launch or an effect re-run, then lost the race.
  // Gated on storeOk for the reason the comment above describes: an unreadable
  // store yields an EMPTY ignore list, which is precisely the bug this mirror
  // exists to prevent.
  if (storeOk) {
    try {
      const storedIgnored = secureStore.get('gameIgnoredProcesses');
      if (storedIgnored) setIgnoredProcesses(JSON.parse(storedIgnored));
      const storedCustom = secureStore.get('gameCustomGames');
      if (storedCustom) setCustomGames(JSON.parse(storedCustom));
    } catch { /* corrupt entry — renderer re-syncs on mount anyway */ }
  }

  let lastDetectedGame: string | null = null;

  const runGameCheck = () => freezeMonitor.track('game:detect', runGameCheckOnce);
  const runGameCheckOnce = async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const game = await detectCurrentGame();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      // detectCurrentGame now returns the full DetectedGame (name +
      // processName) rather than a bare name, so the renderer can show which
      // executable matched and offer to ignore it. Identity is compared on a
      // composite key — the same title launched from a different exe is a
      // genuinely different detection.
      const gameKey = game ? `${game.processName}:${game.name}` : null;
      if (gameKey !== lastDetectedGame) {
        lastDetectedGame = gameKey;
        if (game) {
          mainWindow.webContents.send('game:detected', game);
          console.log(`[GameDetector] Game started: ${game.name} (${game.processName})`);
        } else {
          mainWindow.webContents.send('game:stopped');
          console.log('[GameDetector] Game stopped');
        }
      }
    } catch (err) {
      console.warn('[GameDetector] Poll error:', err);
    }
  };

  // Self-scheduling poll (see nextGamePollDelayMs for the policy): every 10 s
  // while someone is using the machine on mains power, slower on battery or
  // when nobody has touched the PC for 10 minutes, and not at all while
  // asleep or when the renderer has game activity switched off. The first
  // poll waits for startup to settle — the renderer asks for the current game
  // itself when it mounts, so nothing is detected later than before.
  let gameDetectionEnabled = true;
  let gamePollTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleGamePoll = (delayMs?: number) => {
    if (gamePollTimer) { clearTimeout(gamePollTimer); gamePollTimer = null; }
    let idleSec = 0;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch { /* unsupported → treat as active */ }
    let onBattery = false;
    try { onBattery = powerMonitor.isOnBatteryPower(); } catch { /* unsupported */ }
    const next = delayMs ?? nextGamePollDelayMs({ enabled: gameDetectionEnabled, suspended: power.suspended, systemIdleSec: idleSec, onBattery });
    if (next == null || !gameDetectionEnabled || power.suspended) return;
    gamePollTimer = setTimeout(() => {
      gamePollTimer = null;
      void runGameCheck().finally(() => scheduleGamePoll());
    }, next);
  };
  scheduleGamePoll(GAME_POLL_SETTLE_MS);
  power.onPhase((phase) => {
    if (phase === 'suspend') { if (gamePollTimer) clearTimeout(gamePollTimer); gamePollTimer = null; }
    else scheduleGamePoll(GAME_POLL_SETTLE_MS);
  });

  app.on('before-quit', () => {
    if (gamePollTimer) clearTimeout(gamePollTimer);
    gamePollTimer = null;
  });

  // On-demand query from renderer (mount, screen-share picker). The poller has
  // almost always answered within the last poll interval; reuse that instead
  // of starting a second full scan.
  ipcMain.handle('game:get-current', () => getCurrentGameCached(GAME_POLL_MS));
  // Settings → Game activity off: stop scanning in the background entirely.
  ipcMain.on('game:set-enabled', (_e, enabled: unknown) => {
    const on = enabled !== false;
    if (on === gameDetectionEnabled) return;
    gameDetectionEnabled = on;
    if (on) scheduleGamePoll(0);
    else if (gamePollTimer) { clearTimeout(gamePollTimer); gamePollTimer = null; lastDetectedGame = null; }
  });

  // Game settings — custom games and ignored processes from renderer
  ipcMain.handle('game:get-processes', () => getRunningProcessList());
  ipcMain.on('game:set-custom-games', (_e, games: { processName: string; displayName: string }[]) => {
    setCustomGames(games);
    // Mirror to SecureStore so the startup poll has the list before the
    // renderer mounts — see the load above.
    try { secureStore.set('gameCustomGames', JSON.stringify(games)); } catch { /* best-effort */ }
  });
  ipcMain.on('game:set-ignored', (_e, ignored: string[]) => {
    setIgnoredProcesses(ignored);
    try { secureStore.set('gameIgnoredProcesses', JSON.stringify(ignored)); } catch { /* best-effort */ }
  });

  // ── Google Drive OAuth ──────────────────────────────────────────────────────
  // The renderer can initiate the loopback OAuth flow, check link status, and
  // disconnect. Token storage and refresh are handled entirely in the main
  // process (SecureStore) so the renderer never sees raw tokens.

  // Hardening follow-up (backups audit): these three were missing the
  // isTrustedSender check gdrive:get-token already had — inconsistent with
  // this file's IPC trust-boundary convention (every fs:*/other privileged
  // handler checks it). auth-start triggers a real OAuth flow (opens a
  // browser window); auth-status leaks the linked email; disconnect can
  // force-revoke the user's Drive link — none of them return raw tokens
  // (that's get-token's job, already gated), but all three are still
  // privileged side effects an untrusted sender should never reach directly
  // via ipcRenderer.invoke, bypassing the contextBridge wrapper.
  ipcMain.handle('gdrive:auth-start', async () => {
    return startOAuth();
  });

  ipcMain.handle('gdrive:auth-status', async () => {
    return getLinkedAccount();
  });

  ipcMain.handle('gdrive:disconnect', async () => {
    await revokeTokens();
  });

  // Returns a fresh (auto-refreshed) access token for Drive API calls that
  // are initiated from the renderer side (e.g. backup orchestrator).
  ipcMain.handle('gdrive:get-token', async () => {
    try {
      return await getAccessToken();
    } catch {
      return null;
    }
  });

  // ── Drive file transfers (single-file backup) ──────────────────────────────
  // Upload/download run here so the backup is streamed from/to disk with
  // Drive's resumable protocol and verified by checksum — see driveTransfer.ts.
  // Source/destination paths are confined to the backup staging dir (under
  // userData) or a user-picked backup folder; the filename must be a plain
  // `.enc` name.
  const backupStagingDir = () => path.join(app.getPath('userData'), 'backup-staging');
  ipcMain.handle('backup:staging-dir', async () => {
    await fs.promises.mkdir(backupStagingDir(), { recursive: true, mode: 0o700 });
    return backupStagingDir();
  });
  ipcMain.handle('gdrive:upload-file', async (event, folderId: string, fileName: string, filePath: string) => {
    if (typeof folderId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(folderId)) throw new Error('Invalid Drive folder id');
    if (typeof fileName !== 'string' || /[/\\]/.test(fileName) || fileName.includes('..') || !fileName.endsWith('.enc')) {
      throw new Error('Invalid backup filename');
    }
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid path');
    assertInsideUserData(filePath);
    return uploadFileResumable({
      getToken: getAccessToken, folderId, fileName, filePath,
      onProgress: (p) => event.sender.send('gdrive:transfer-progress', { kind: 'upload', ...p }),
    });
  });
  ipcMain.handle('gdrive:download-file', async (event, fileId: string, fileName: string) => {
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(fileId)) throw new Error('Invalid Drive file id');
    if (typeof fileName !== 'string' || /[/\\]/.test(fileName) || fileName.includes('..') || !fileName.endsWith('.enc')) {
      throw new Error('Invalid backup filename');
    }
    await fs.promises.mkdir(backupStagingDir(), { recursive: true, mode: 0o700 });
    const destPath = path.join(backupStagingDir(), fileName);
    const { size } = await downloadFileToPath({
      getToken: getAccessToken, fileId, destPath,
      onProgress: (p) => event.sender.send('gdrive:transfer-progress', { kind: 'download', ...p }),
    });
    return { path: destPath, size };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(csp);
    }
  });
  } catch (err) {
    console.error('[Main] FATAL error during initialization:', err);
    app.exit(1);
  }
});

// Continuity (cross-device attention routing): tell the renderer the app is
// going down so it can send one last off-cycle `presence:heartbeat
// {active:false}` before the socket dies — without this, a quit looks
// identical to a network drop to the server, which only clears attention
// after the 45s zombie watchdog (or the 15s heartbeat simply stops
// arriving), leaving the phone silenced for up to that long after the user
// has genuinely closed the app. Best-effort: 'before-quit' handlers run
// synchronously and the renderer's WS send happens on its own later event
// loop turn, so this can lose the race on a hard/forced quit — the fallback
// there is the SAME pre-existing behaviour (stale presence expires via TTL),
// never worse than today. Registered FIRST among the before-quit handlers
// so the renderer gets the earliest possible signal.
app.on('before-quit', () => {
  // Gaming-video priority boost: restore before the processes start exiting.
  syncCallPriority({ inCall: false });
  mainWindow?.webContents.send('app:before-quit');
});

// Mark quitting intent so the minimize-to-tray close interceptor lets quit through.
app.on('before-quit', () => {
  setIsQuitting(true);
  hideAnnotationOverlay();
});

// Flush the E2EE replay-detection cache synchronously before exit — the
// normal path debounces this write by 500ms, so a message decrypted right
// before shutdown would otherwise never make it to disk and could be
// replayed by a malicious relay after restart.
app.on('before-quit', () => {
  flushReplayCache();
  // Anything still written-behind (consumed one-time prekeys, the replay
  // sets — see SecureStore.setDeferred) goes to disk now, synchronously.
  try { secureStore.flush(); } catch (e) { console.error('[Main] SecureStore flush on quit failed:', e); }
});
// Belt and braces: a set() from a later before-quit handler or a closing
// window lands after the flush above.
app.on('will-quit', () => {
  try { secureStore.flush(); } catch { /* logged by the store */ }
  // A clean quit: the next launch must not report an unclean exit.
  endSessionMarker();
});

app.on('window-all-closed', () => {
  // On macOS the convention is to keep the process alive after all windows
  // close, UNLESS we're intentionally quitting (e.g. tray "Quit" or an
  // auto-update install triggered via `quitAndInstall`). Without this check
  // `quitAndInstall` closes all windows but the process never exits, so the
  // new version never launches — the app appears frozen.
  if (process.platform !== 'darwin' || isQuitting) {
    app.quit();
  }
});
