/**
 * True background global shortcuts on KDE Plasma, via KDE's own KGlobalAccel
 * D-Bus service — a workaround for Electron's `globalShortcut` API having no
 * reliable Wayland support (registration can silently "succeed" while the
 * shortcut never actually fires; this affects every Electron app, not just
 * Cipherline, and there's no fix on Electron's side yet for most compositors,
 * KWin included).
 *
 * This runs ADDITIONALLY alongside the existing Electron globalShortcut path
 * in main.ts, not instead of it — harmless if both somehow fire for the same
 * press, since the renderer already dedupes (useGlobalKeybindListener.ts).
 * KDE-only and best-effort: any failure here (wrong D-Bus signature, service
 * unavailable, non-KDE desktop) is caught and logged, never thrown — the
 * existing focused-window fallback is the safety net regardless.
 *
 * ⚠️ Implemented from documented/historical KGlobalAccel D-Bus behavior
 * without a live KDE session to verify against (this dev box is headless).
 * First live test: doRegister/setShortcut succeed (KGlobalAccel echoes back
 * the correct key code) but the press never arrived at the listener — so
 * v2 now ALSO subscribes on the per-component object
 * (org.kde.kglobalaccel.Component at /component/<name>), which KGlobalAccel
 * is documented to expose alongside the top-level /kglobalaccel object and
 * which several working community scripts subscribe to instead of the
 * top-level one. Both are wired up, clearly logged, so whichever one (if
 * either) actually fires is obvious from the next test.
 */

const COMPONENT_UNIQUE = 'cipherline';
const COMPONENT_FRIENDLY = 'Cipherline';

// Qt::Key_* base codes for the specific keys our combos actually use.
// Letters A-Z equal their uppercase ASCII codes in Qt's enum, which is why
// this table only needs the non-letter entries. Keys match Electron's
// accelerator token spelling (comboToAccelerator() in useKeybinds.ts),
// lower-cased for lookup here.
const QT_KEY_BASE: Record<string, number> = {
  escape: 0x01000000,
  space: 0x20,
  ',': 0x2c,
  '.': 0x2e,
  up: 0x01000013,
  down: 0x01000015,
  left: 0x01000012,
  right: 0x01000014,
};

const QT_MOD = {
  shift: 0x02000000,
  ctrl: 0x04000000, // Electron's "CmdOrCtrl" token — Linux only cares about Ctrl
  alt: 0x08000000,
};

/** Convert an Electron accelerator string ("CmdOrCtrl+Shift+L" or "F17") into
 *  the Qt key-code integer KGlobalAccel's setShortcut expects (modifier bits
 *  OR'd with the base key code). Returns null for anything not in our small
 *  keybind vocabulary rather than guessing. */
function acceleratorToQtKeyCode(accelerator: string): number | null {
  const parts = accelerator.split('+').map(p => p.toLowerCase());
  const key = parts[parts.length - 1];
  let code = QT_KEY_BASE[key];
  if (code === undefined) {
    const fMatch = /^f(\d{1,2})$/.exec(key);
    if (fMatch) {
      // Qt::Key_F1 = 0x01000030, F2 = 0x01000031, ... sequential through F35.
      const n = parseInt(fMatch[1], 10);
      if (n >= 1 && n <= 35) code = 0x01000030 + (n - 1);
    }
    if (code === undefined) {
      if (key.length === 1 && /[a-z]/i.test(key)) {
        code = key.toUpperCase().charCodeAt(0);
      } else {
        return null; // unrecognised key — don't guess, skip this combo
      }
    }
  }
  for (const mod of parts.slice(0, -1)) {
    if (mod === 'cmdorctrl' || mod === 'ctrl') code |= QT_MOD.ctrl;
    else if (mod === 'shift') code |= QT_MOD.shift;
    else if (mod === 'alt') code |= QT_MOD.alt;
  }
  return code;
}

interface KdeAccelHandles {
  root: any; // org.kde.KGlobalAccel at /kglobalaccel
  component: any; // org.kde.kglobalaccel.Component at /component/<COMPONENT_UNIQUE>
}

let cachedHandles: KdeAccelHandles | null = null;
let registeredActionIds: string[] = [];

async function getHandles(onFired: (actionId: string) => void): Promise<KdeAccelHandles | null> {
  if (cachedHandles) return cachedHandles;
  try {
    // Lazy import — this module only ever runs on Linux, no reason to pull
    // dbus-native into the Windows/macOS main-process bundle's dependency graph.
    const dbus = require('dbus-native');
    const bus = dbus.sessionBus({ timeout: 8000 });
    const service = bus.getService('org.kde.kglobalaccel');

    const root = await service.getInterface('/kglobalaccel', 'org.kde.KGlobalAccel');

    const handlePress = (source: string) => (a: string, b: string) => {
      // Top-level signal shape: (componentUnique, actionUnique, timestamp).
      // Component-scoped signal shape: (actionUnique, timestamp) — no
      // componentUnique, since the object path already scopes it. Handle
      // both by checking whether `a` looks like our componentUnique.
      const actionUnique = a === COMPONENT_UNIQUE ? b : a;
      console.log(`[KGlobalAccel] fired (via ${source}): ${actionUnique}`);
      onFired(actionUnique);
    };

    try {
      await root.$subscribe('globalShortcutPressed', handlePress('/kglobalaccel'));
      console.log('[KGlobalAccel] subscribed to /kglobalaccel globalShortcutPressed');
    } catch (err: any) {
      console.warn('[KGlobalAccel] failed to subscribe on /kglobalaccel:', err?.message ?? err);
    }

    // The per-component object doesn't exist until doRegister() has created
    // it at least once, so this is attempted lazily from syncKdeGlobalShortcuts
    // after the first successful doRegister call, not here.
    const handles: KdeAccelHandles = { root, component: null };
    (handles as any).__handlePress = handlePress;
    cachedHandles = handles;
    return handles;
  } catch (err: any) {
    console.warn('[KGlobalAccel] unavailable (non-KDE desktop, or D-Bus service not running):', err?.message ?? err);
    return null;
  }
}

async function ensureComponentSubscription(handles: KdeAccelHandles): Promise<void> {
  if (handles.component) return;
  try {
    const dbus = require('dbus-native');
    const bus = dbus.sessionBus({ timeout: 8000 });
    const path = `/component/${COMPONENT_UNIQUE}`;
    const component = await bus
      .getService('org.kde.kglobalaccel')
      .getInterface(path, 'org.kde.kglobalaccel.Component');

    const handlePress = (handles as any).__handlePress as (source: string) => (a: string, b: string) => void;
    await component.$subscribe('globalShortcutPressed', handlePress(path));
    console.log(`[KGlobalAccel] subscribed to ${path} globalShortcutPressed`);
    handles.component = component;
  } catch (err: any) {
    console.warn('[KGlobalAccel] failed to subscribe on per-component object:', err?.message ?? err);
  }
}

/**
 * Re-sync KDE global shortcuts to match `map` ({ accelerator: actionId },
 * Electron's accelerator format — the same map main.ts already builds for
 * globalShortcut.register()). Unregisters everything previously registered
 * by this call first. No-ops entirely (resolves, doesn't throw) on non-KDE
 * desktops or any D-Bus failure.
 */
export async function syncKdeGlobalShortcuts(
  map: Record<string, string>,
  onFired: (actionId: string) => void,
): Promise<void> {
  if (process.platform !== 'linux') return;

  const handles = await getHandles(onFired);
  if (!handles) return;

  for (const actionUnique of registeredActionIds) {
    try {
      await handles.root.unRegister([COMPONENT_UNIQUE, actionUnique, COMPONENT_FRIENDLY, actionUnique]);
    } catch (err: any) {
      console.warn(`[KGlobalAccel] unRegister(${actionUnique}) failed:`, err?.message ?? err);
    }
  }
  registeredActionIds = [];

  for (const [accelerator, actionUnique] of Object.entries(map)) {
    const keyCode = acceleratorToQtKeyCode(accelerator);
    if (keyCode == null) {
      console.warn(`[KGlobalAccel] no Qt key-code mapping for accelerator "${accelerator}" — skipping ${actionUnique}`);
      continue;
    }
    try {
      await handles.root.doRegister([COMPONENT_UNIQUE, actionUnique, COMPONENT_FRIENDLY, actionUnique]);
      // The component object only exists once doRegister has run at least
      // once — safe/cheap to call every sync, it's a no-op after the first.
      await ensureComponentSubscription(handles);
      const result = await handles.root.setShortcut(
        [COMPONENT_UNIQUE, actionUnique, COMPONENT_FRIENDLY, actionUnique],
        [keyCode],
        4, // SetPresent flag — believed-correct per historical KGlobalAccel scripts, unverified live
      );
      console.log(`[KGlobalAccel] registered ${actionUnique} → "${accelerator}" (keyCode 0x${keyCode.toString(16)}):`, result);
      registeredActionIds.push(actionUnique);
    } catch (err: any) {
      console.warn(`[KGlobalAccel] registration failed for ${actionUnique} ("${accelerator}"):`, err?.message ?? err);
    }
  }

  // Diagnostic: ask the component what it thinks is registered, so a
  // mismatch between "what we sent" and "what KGlobalAccel actually has"
  // is visible without needing to press anything.
  if (handles.component) {
    try {
      const names = await handles.component.shortcutNames?.();
      console.log('[KGlobalAccel] component shortcutNames():', names);
    } catch (err: any) {
      console.warn('[KGlobalAccel] shortcutNames() failed:', err?.message ?? err);
    }
  }
}

/** Best-effort cleanup on app quit. */
export async function teardownKdeGlobalShortcuts(): Promise<void> {
  if (!cachedHandles) return;
  for (const actionUnique of registeredActionIds) {
    try {
      await cachedHandles.root.unRegister([COMPONENT_UNIQUE, actionUnique, COMPONENT_FRIENDLY, actionUnique]);
    } catch { /* best-effort — app is quitting regardless */ }
  }
  registeredActionIds = [];
}
