import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
// Side-effect: wires the X-Cipherline-Version header + global 426 handler
// onto axios BEFORE any component mounts and fires a request.
import './utils/httpBootstrap';
// Freeze diagnostic (Settings → Advanced → Performance log): observe long
// tasks from the very first one, so a slow boot is on the record too.
import { startFreezeLog, trackActivity, beginActivity } from './utils/freezeLog';
// Side-effect: bakes the real k=250/c=13 physics spring into --cl-spring /
// --cl-spring-dur before any component mounts (falls back to cubic-bezier).
import './utils/clPhysics';
// Publishes <html data-cl-motion="idle|active"> so the decorative infinite
// animations can stop while the window is blurred/hidden — see idleMotion.ts
// for the measurements that motivate it. Installed before render so the very
// first paint already carries the right state.
import { installIdleMotionGate } from './utils/idleMotion';
// Keeps every Opus m-section of a call's BUNDLE on one fmtp set (see file).
import { installOpusBundleConsistency } from './utils/sdpOpusBundleConsistency';
// Brand fonts, requested without blocking paint or this script (webFonts.ts).
import { loadWebFonts } from './utils/webFonts';
import { scheduleBootPrefetch } from './utils/bootPrefetch';
import './index.css';
// Verbatim brand-guide component CSS, scoped under .cl-kit (see cl-kit.css).
import './styles/cl-kit.css';
// Generated global fallbacks for the kit primitives (scripts/gen-kit-fallback.cjs)
// — carry the styling when Chromium drops @scope matches on display:contents roots.
import './styles/cl-kit-fallback.css';
// App extensions to the kit — imported AFTER so they win at equal specificity.
import './styles/cl-kit-ext.css';
// The kit's Light values (generated: scripts/gen-theme-light-kit.cjs; the kit files are shared with apps/website).
import './styles/theme-light-kit.css';
// “The Descent” full-screen settings layer (sd- prefixed, composes the kit).
import './styles/settings-descent.css';
// “Drift” floating-deck workspace composition — the only layout; see layout-drift.css.
import './styles/layout-drift.css';
// “Night dive” — midnight-to-5am deeper BACKGROUND layers + the deep-sea layer
// (utils/nightDive.ts, components/NightDiveSea.tsx). Imported LAST so its
// background declarations win over the stylesheets they mirror.
import './styles/night-dive.css';
// Light theme: the structural differences (glows -> shadows, the kit, scrollbars).
// Every rule is under :root[data-scheme="light"] (Light and High contrast light); imported last so it wins.
import './styles/theme-light.css';
// Midnight (true black): its few structural differences, under :root[data-theme="midnight"].
import './styles/theme-midnight.css';
// Gradient role names + role icons (utils/roleStyle.ts).
import './styles/role-style.css';
// High contrast themes (:root[data-contrast="high"]) and Windows High Contrast (forced-colors).
import './styles/theme-contrast.css';
import App from './App.tsx';
import { AuthProvider } from './contexts/AuthContext.tsx';
import { SubscriptionProvider } from './contexts/SubscriptionContext.tsx';
import { NotificationProvider } from './contexts/NotificationContext.tsx';
import { createHashRouter, RouterProvider } from 'react-router-dom';
import { secureLocalStore } from './utils/secureLocalStore';
import { applyNightDiveNow } from './hooks/useNightDive';
import StorageLockedScreen from './components/StorageLockedScreen';
import StorageCorruptedScreen from './components/StorageCorruptedScreen';
import StorageReadFailedScreen from './components/StorageReadFailedScreen';
import { storeFailureCode } from './utils/storeHealthReport';
import StorageOpeningScreen from './components/StorageOpeningScreen';
import RootErrorBoundary from './components/RootErrorBoundary';
import StagingLockScreen from './components/StagingLockScreen';
import { readStagingLockStatus, shouldShowStagingLockScreen } from './utils/stagingLock';
import { APP_VERSION } from './constants';
import { installRecentErrorCapture } from './utils/diagnostics/recentErrors';
import { bootTheme } from './theme/engine';
import { bootMotion } from './utils/a11y/motionPrefs';

// Theme: applied synchronously right here (data-theme + the engine's variables
// are on <html> before anything renders), then the device's stored theme id is
// read from the main process in parallel with the store hydration below and
// applied before the first React render (src/theme/engine.ts).
const themeBoot = bootTheme();

const endBootActivity = startFreezeLog();
// Issue reporter: remember the last few renderer errors (scrubbed at capture).
installRecentErrorCapture();
loadWebFonts();

const router = createHashRouter([
  {
    path: "*",
    element: <App />,
  },
]);

// Run `cb` once the main thread goes idle (setTimeout fallback where unsupported).
const idle = (cb: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 30_000 }) : setTimeout(cb, 1000));

// One React root for the whole boot: the "Opening your data…" screen (below)
// may be on it before renderApp() runs, and renderApp() replaces it.
let bootRoot: Root | null = null;
const getRoot = (): Root => (bootRoot ??= createRoot(document.getElementById('root')!));

// The store is retrying a load that failed for a reason that usually clears in
// seconds (utils/storeLoadRetry.ts). Say so instead of a blank window, and never
// flash the read-failed screen for a refusal that a retry fixes. A normal launch
// never fires this. Unsubscribed once hydrate settles.
const offLoadRetry = secureLocalStore.onLoadRetry(() => {
  getRoot().render(<StrictMode><RootErrorBoundary><StorageOpeningScreen /></RootErrorBoundary></StrictMode>);
});

async function renderApp() {
  // Before the first paint, so no frame is ever rendered with decorative
  // loops running in an already-background window.
  installIdleMotionGate();
  // Settings → Accessibility → Reduce motion: every matchMedia('(prefers-reduced-motion…)')
  // caller and the <html data-reduced-motion> CSS hook follow the in-app choice.
  bootMotion();
  installOpusBundleConsistency();

  // Night dive: the store is hydrated by now, so a client launched after
  // midnight paints its very first frame already deep instead of fading in.
  applyNightDiveNow();

  const root = getRoot();
  // Covers the first render + commit, which React runs in later tasks; ends
  // the first time the thread goes idle.
  const endRender = beginActivity('startup:render');
  idle(() => { endRender(); endBootActivity(); });

  // STAGING LOCK: on a staging build (packaged, version `-staging`) that this
  // device has not unlocked yet, show ONLY the password screen. It is checked
  // first and renders INSTEAD of the providers below, so AuthProvider (token
  // refresh), the WebSocket, and every other server-talking side effect does
  // not exist until main reports the device unlocked. Main owns the check and
  // the remembered unlock (electron/staging-lock.ts); dev builds, stable
  // builds and the CI smoke test always get `isStagingBuild: false` here.
  const lock = await readStagingLockStatus();
  if (shouldShowStagingLockScreen(lock, APP_VERSION)) {
    root.render(
      <StrictMode>
        <RootErrorBoundary>
          <StagingLockScreen
            initialRetryAfterMs={typeof lock === 'object' ? lock.retryAfterMs : 0}
            onUnlocked={() => { void renderUnlockedApp(root); }}
          />
        </RootErrorBoundary>
      </StrictMode>,
    );
    return;
  }
  await renderUnlockedApp(root);
}

async function renderUnlockedApp(root: Root, continuedPastReadFailure = false) {
  // If the device's encrypted storage couldn't be unlocked, do NOT mount the
  // normal app (which would read an empty store and silently look "logged out").
  // Show the recovery screen instead — it performs zero writes to the store.
  if (secureLocalStore.isLocked()) {
    root.render(<StrictMode><RootErrorBoundary><StorageLockedScreen /></RootErrorBoundary></StrictMode>);
    return;
  }

  // The key is fine but the store could not be read this launch, session
  // pointers included. Without this the app would show the sign-in screen, as if
  // the device were signed out, and a sign-in would register a new device.
  if (secureLocalStore.isStoreUnread() && !continuedPastReadFailure) {
    root.render(
      <StrictMode>
        <RootErrorBoundary>
          <StorageReadFailedScreen
            code={storeFailureCode(secureLocalStore.loadHealth())}
            onContinue={() => { void renderUnlockedApp(root, true); }}
          />
        </RootErrorBoundary>
      </StrictMode>,
    );
    return;
  }

  // Phase 7 / device sprawl: the master key unwrapped fine (not 'locked'
  // above), but the main process's Signal-identity store may have found its
  // own data file corrupt this session — a separate failure mode with no
  // gate before this existed, which silently minted a brand-new device
  // identity with the user never told anything had gone wrong.
  try {
    const corruption = await window.electronAPI?.getSecureStoreCorruption?.();
    if (corruption) {
      root.render(
        <StrictMode><RootErrorBoundary><StorageCorruptedScreen backupFileName={corruption.backupFileName} /></RootErrorBoundary></StrictMode>,
      );
      return;
    }
  } catch (e) {
    // Never let this check itself block boot — worst case, corruption goes
    // unsurfaced this one launch, same as the pre-Phase-7 behavior.
    console.error('[main] getSecureStoreCorruption check failed — booting anyway', e);
  }

  root.render(
    <StrictMode>
      <RootErrorBoundary>
        <AuthProvider>
          <NotificationProvider>
            <SubscriptionProvider>
              <RouterProvider router={router} />
            </SubscriptionProvider>
          </NotificationProvider>
        </AuthProvider>
      </RootErrorBoundary>
    </StrictMode>,
  );
  // Code split out of the startup bundle (emoji picker, RNNoise) is warmed
  // once the first render has settled — see bootPrefetch.ts.
  idle(scheduleBootPrefetch);
}

// BOOT GATE: decrypt the at-rest key/value store into memory BEFORE React
// renders. This is the complete gate — every renderer read of persisted data
// happens inside a component/hook/effect that runs on or after first render, so
// once hydrate() resolves the synchronous facade is fully populated. hydrate()
// swallows its own errors (degrades to an empty in-memory store) and never
// rejects on data problems, but we guard anyway so a programming error can't
// leave the user staring at a blank window.
trackActivity('startup:hydrate', () => secureLocalStore.hydrate())
  .catch((e) => console.error('[main] secureLocalStore.hydrate failed — booting anyway', e))
  .finally(offLoadRetry)
  // bootTheme never rejects and gives up on the host after 400 ms; by now it
  // has normally long resolved (it ran in parallel with the hydration).
  .finally(() => { void themeBoot.finally(renderApp); });
