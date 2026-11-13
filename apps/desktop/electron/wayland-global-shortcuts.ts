/**
 * Global shortcuts on a native Wayland session, through the desktop's own
 * `org.freedesktop.portal.GlobalShortcuts` portal, spoken to directly over the
 * session bus. Linux + Wayland only; every other session keeps Electron's
 * `globalShortcut` (see global-shortcut-mode.ts for the decision).
 *
 * Why not Electron's `globalShortcut` here? Measured on a real KDE Plasma 6.8.2
 * Wayland session with the shipping Electron 43.8.1 (Chromium 150): `register()`
 * returns true and Chromium does call the portal's CreateSession (the
 * `GlobalShortcutsPortal` feature is already on in that build, so no switch is
 * needed), but xdg-desktop-portal 1.22 answers `NotAllowed: An app id is
 * required` and nothing is ever bound. Chromium puts itself in a systemd scope
 * named `app-<name>-<pid>.scope` with the dots of the name turned into dashes,
 * which is never a valid application id, and it never calls the portal's
 * host Registry. `register()` still says true, so there is no failure to react
 * to. An app that talks to the portal itself can register an id first.
 *
 * What works (same session, measured):
 *   1. `org.freedesktop.host.portal.Registry.Register(appId)` on our own bus
 *      connection. The portal finds the app by its desktop file, so
 *      `<appId>.desktop` must exist in an XDG applications directory
 *      (`ensureDesktopEntry`); without it: "App info not found".
 *   2. CreateSession, then BindShortcuts with `preferred_trigger`s. KDE shows
 *      one "Global Shortcuts Requested" dialog the first time (OK / Cancel; the
 *      user can change a trigger there); the choice is remembered per app id, so
 *      later launches bind silently.
 *   3. The `Activated` signal arrives while ANOTHER window is focused
 *      (two Electron windows, press sent through the QEMU monitor): leave-call
 *      and toggle-camera both arrived.
 *
 * BindShortcuts is called once per session (GNOME's backend allows no more), so
 * a changed map closes the session and opens a fresh one; KDE and GNOME both
 * remember the user's earlier answer for unchanged shortcuts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PORTAL_APP_ID = 'chat.cipherline.Cipherline';
const BUS = 'org.freedesktop.portal.Desktop';
const OBJ = '/org/freedesktop/portal/desktop';
const GS = 'org.freedesktop.portal.GlobalShortcuts';
/** A dialog may be waiting on the user; past this we treat the bind as not granted. */
export const BIND_RESPONSE_TIMEOUT_MS = 120_000;
export const SETUP_RESPONSE_TIMEOUT_MS = 8_000;

// ── pure helpers ─────────────────────────────────────────────────────────────

const TRIGGER_KEYS: Record<string, string> = {
  escape: 'Escape', space: 'space', ',': 'comma', '.': 'period',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
};

/** Electron accelerator ("CmdOrCtrl+Shift+H", "F9") to the portal's trigger syntax ("CTRL+SHIFT+H", "F9"). null = not in our vocabulary. */
export function acceleratorToPortalTrigger(accelerator: string): string | null {
  const parts = accelerator.split('+');
  const key = parts[parts.length - 1] ?? '';
  const mods: string[] = [];
  for (const m of parts.slice(0, -1)) {
    const l = m.toLowerCase();
    if (l === 'cmdorctrl' || l === 'ctrl') mods.push('CTRL');
    else if (l === 'shift') mods.push('SHIFT');
    else if (l === 'alt') mods.push('ALT');
    else return null;
  }
  const lk = key.toLowerCase();
  let k = TRIGGER_KEYS[lk];
  if (!k) {
    if (/^f([1-9]|[12]\d|3[0-5])$/.test(lk)) k = lk.toUpperCase();
    else if (/^[a-z0-9]$/.test(lk)) k = lk.toUpperCase();
    else return null;
  }
  return [...mods, k].join('+');
}

/** What the user reads in the portal's dialog, per action. */
export const ACTION_DESCRIPTIONS: Record<string, string> = {
  'toggle-mute': 'Mute / unmute',
  'toggle-deafen': 'Deafen / undeafen',
  'toggle-camera': 'Camera on / off',
  'toggle-screenshare': 'Open the screen share picker',
  'leave-call': 'Leave call',
  'quick-screenshare': 'Quick screen share',
  'lock-screen': 'Lock Cipherline',
  'approve-annotation-request': 'Allow drawing request',
  'decline-annotation-request': 'Decline drawing request',
};

/**
 * The portal path binds ONE stable set: every bound global action, the
 * drawing-request pair included, whether or not a request is waiting (the
 * renderer sends it as `portalMap`). On X11 / Windows / macOS that pair is
 * registered only while a request waits (`armedOnly`), so it does not take the
 * combo from other apps the rest of the time. Through the portal, every change
 * of a session's set is a new desktop dialog: measured 2026-11-09 on staging.213,
 * GNOME 50 (Fedora 44) put its "Add Keyboard Shortcuts" dialog over the running
 * share on EVERY draw request (twice), and Cancel on it dropped all of
 * Cipherline's global shortcuts; KDE Plasma 6.8 (Arch) showed "Global Shortcuts
 * Requested: Allow drawing request" mid-share. Owner decision 2026-11-10: bind
 * the pair permanently on Wayland (the desktop's own dialog lists them once and
 * lets the person change or clear them). A press with no request waiting does
 * nothing: the renderer installs those handlers only while one is waiting.
 */
export interface PortalShortcutSpec { id: string; description: string; trigger: string }

/** { accelerator: actionId } to the portal's list; entries we cannot express are returned as `skipped` action ids. */
export function buildPortalShortcuts(map: Record<string, string>): { specs: PortalShortcutSpec[]; skipped: string[] } {
  const specs: PortalShortcutSpec[] = [];
  const skipped: string[] = [];
  for (const [accel, id] of Object.entries(map)) {
    const trigger = acceleratorToPortalTrigger(accel);
    if (!trigger) { skipped.push(id); continue; }
    specs.push({ id, description: ACTION_DESCRIPTIONS[id] ?? id, trigger });
  }
  return { specs, skipped };
}

/** Which actions the portal actually bound: those it echoed back with a non-empty trigger (the user may clear one in the dialog). */
export function boundActionIds(responseBody: unknown): string[] | null {
  if (!Array.isArray(responseBody) || responseBody[0] !== 0) return null;
  const results = (responseBody[1] ?? {}) as { shortcuts?: unknown };
  if (!Array.isArray(results.shortcuts)) return [];
  const out: string[] = [];
  for (const e of results.shortcuts) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const info = (e[1] ?? {}) as { trigger_description?: unknown };
    if (typeof info.trigger_description === 'string' && info.trigger_description !== '') out.push(e[0]);
  }
  return out;
}

/**
 * Actions whose key the USER changed during this run and the desktop did not adopt. KDE keeps the first key it
 * accepted for a shortcut id and ignores a later preferred_trigger WITHOUT any dialog, which is why "I changed a
 * keybind and was never asked" happens. `previous` = what the last successful sync asked for (empty on the first
 * sync of a launch, so startup never counts as a change); `elsewhere` = ids the desktop bound to another key.
 */
export function ignoredKeyChanges(previous: ReadonlyMap<string, string>, specs: ReadonlyArray<PortalShortcutSpec>, elsewhere: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const sp of specs) {
    const before = previous.get(sp.id);
    if (before !== undefined && before !== sp.trigger && elsewhere.includes(sp.id)) out.push(sp.id);
  }
  return out;
}

/** id -> the desktop's own description of the key it bound (non-empty only), from a BindShortcuts response. */
export function boundTriggers(responseBody: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(responseBody) || responseBody[0] !== 0) return out;
  const results = (responseBody[1] ?? {}) as { shortcuts?: unknown };
  if (!Array.isArray(results.shortcuts)) return out;
  for (const e of results.shortcuts) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const d = ((e[1] ?? {}) as { trigger_description?: unknown }).trigger_description;
    // A display string from the desktop: keep it short and printable, nothing else.
    if (typeof d === 'string' && d !== '') out[e[0]] = d.replace(/[^\x20-\x7e\u00a0-\uffff]/g, '').slice(0, 48);
  }
  return out;
}

const TRIGGER_MODS: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', meta: 'meta', super: 'meta', logo: 'meta', win: 'meta' };
const TRIGGER_KEY_ALIAS: Record<string, string> = { ',': 'comma', '.': 'period', esc: 'escape' };

function parseTrigger(t: string): string | null {
  const parts = t.split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return null;
  let key = parts.pop() as string;
  key = TRIGGER_KEY_ALIAS[key] ?? key;
  if (!/^(f([1-9]|[12]\d|3[0-5])|[a-z0-9]|escape|space|comma|period|up|down|left|right)$/.test(key)) return null;
  const mods = new Set<string>();
  for (const p of parts) { const m = TRIGGER_MODS[p]; if (!m) return null; mods.add(m); }
  return [...mods].sort().join('+') + '|' + key;
}

/**
 * Is the desktop's description the key we asked for (portal syntax "CTRL+SHIFT+F10")? true / false, or null when
 * the description is not in a vocabulary we can read (a translated "Strg+Umschalt+F10", a symbol): never claim a
 * mismatch we cannot prove. A description may list several keys ("Ctrl+Shift+F10, Meta+C"); any one matching counts.
 */
export function triggerMatches(requested: string, description: string): boolean | null {
  const want = parseTrigger(requested);
  if (!want) return null;
  const alternatives = description.split(/,\s+|\t|;\s*/).map(parseTrigger);
  if (alternatives.some((a) => a === want)) return true;
  return alternatives.length > 0 && alternatives.every((a) => a !== null) ? false : null;
}

/** Escape a path for a desktop-entry Exec= value (spec: quote, and escape the characters it names). */
function execQuote(p: string): string {
  return `"${p.replace(/(["`$\\])/g, '\\$1').replace(/%/g, '%%')}"`;
}

export function buildDesktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]', 'Type=Application', 'Name=Cipherline',
    'Comment=Cipherline (registers global shortcuts with the desktop)',
    `Exec=${execQuote(execPath)} %U`, 'Terminal=false', 'NoDisplay=true', 'Categories=Network;',
    'StartupWMClass=Cipherline', 'X-Cipherline-Managed=true', '',
  ].join('\n');
}

/**
 * The portal identifies an app by its desktop file. Packaged builds may already ship one under this id;
 * otherwise write a hidden one under the user's data dir (never overwrites an existing file, never throws).
 */
export function ensureDesktopEntry(
  execPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fsApi: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'writeFileSync' | 'readFileSync'> = fs,
): boolean {
  try {
    const home = env.HOME || os.homedir();
    const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const dirs = [dataHome, ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')].filter(Boolean);
    const file = `${PORTAL_APP_ID}.desktop`;
    const dir = path.join(dataHome, 'applications');
    const ours = path.join(dir, file);
    const want = buildDesktopEntry(execPath);
    if (dirs.some((d) => fsApi.existsSync(path.join(d, 'applications', file)))) {
      // A file of ours (the managed marker) whose Exec went stale (the AppImage moved)
      // is refreshed; anything else (a packaged one, a hand-made one) is left alone.
      if (fsApi.existsSync(ours) && fsApi.readFileSync) {
        const cur = fsApi.readFileSync(ours, 'utf8');
        if (cur.includes('X-Cipherline-Managed=true') && cur !== want) fsApi.writeFileSync(ours, want, { mode: 0o644 });
      }
      return true;
    }
    fsApi.mkdirSync(dir, { recursive: true });
    fsApi.writeFileSync(ours, want, { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}

// ── the portal conversation ──────────────────────────────────────────────────

/** The slice of a dbus-native session bus this needs; a fake in tests. */
export interface PortalSessionBus {
  /** Resolves once the bus has handed out our unique name (":1.234"). */
  uniqueName(): Promise<string>;
  invoke(msg: Record<string, unknown>): Promise<unknown>;
  addMatch(rule: string): void;
  onMessage(cb: (m: { path?: string; interface?: string; member?: string; body?: unknown }) => void): () => void;
  close(): void;
}

/**
 * `triggers`: the key the desktop says it bound for each granted action (its own words, trigger_description).
 * `elsewhere`: granted actions bound to a DIFFERENT key than we asked for. KDE keeps the key it first accepted
 * for an id and silently ignores a later preferred_trigger (measured on Plasma 6.8: asked Ctrl+Shift+V for
 * toggle-camera after Ctrl+Shift+F10 had been accepted -> "bound", no dialog, KDE still on Ctrl+Shift+F10, and
 * the press of Ctrl+Shift+V did nothing). Settings shows those keys instead of pretending ours are live.
 */
export type PortalSetup =
  | { ok: true; granted: string[]; denied: string[]; triggers?: Record<string, string>; elsewhere?: string[]; ignoredChanges?: string[] }
  | { ok: false; reason: 'unavailable' | 'declined' | 'error' };

export class WaylandGlobalShortcuts {
  private bus: PortalSessionBus | null = null;
  private sender = '';
  private session: string | null = null;
  private registered = false;
  private unsubscribe: (() => void) | null = null;
  private tokenSeq = 0;
  private active = new Set<string>();
  /** The set bound in the open session and what the desktop answered: an identical sync is a no-op (no dialog, no portal traffic). */
  private lastKey: string | null = null;
  private lastResult: PortalSetup | null = null;
  /** id -> trigger asked for in the last successful sync (to tell a user's key change from a startup bind). */
  private lastRequested = new Map<string, string>();

  constructor(
    private readonly busFactory: () => PortalSessionBus | null,
    private readonly onFired: (actionId: string) => void,
    private readonly appId: string = PORTAL_APP_ID,
    private readonly log: (m: string) => void = () => {},
  ) {}

  private token(prefix: string): string { return `${prefix}${process.pid}x${Date.now().toString(36)}${++this.tokenSeq}`; }

  private async ensureBus(): Promise<PortalSessionBus | null> {
    if (this.bus) return this.bus;
    const bus = this.busFactory();
    if (!bus) return null;
    this.sender = (await bus.uniqueName()).replace(/^:/, '').replace(/\./g, '_');
    bus.addMatch(`type='signal',interface='${GS}'`);
    this.unsubscribe = bus.onMessage((m) => {
      if (m.interface !== GS || m.member !== 'Activated') return;
      const body = Array.isArray(m.body) ? m.body : [];
      if (body[0] !== this.session || typeof body[1] !== 'string') return;
      if (this.active.has(body[1])) this.onFired(body[1]);
    });
    this.bus = bus;
    return bus;
  }

  private request(bus: PortalSessionBus, token: string, call: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const reqPath = `${OBJ}/request/${this.sender}/${token}`;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); off(); fn(); };
      const timer = setTimeout(() => finish(() => reject(new Error('portal response timeout'))), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const off = bus.onMessage((m) => {
        if (m.path === reqPath && m.interface === 'org.freedesktop.portal.Request' && m.member === 'Response') finish(() => resolve(m.body));
      });
      bus.addMatch(`type='signal',interface='org.freedesktop.portal.Request',member='Response',path='${reqPath}'`);
      bus.invoke(call).catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }

  /** Closes the previous session (if any) and binds `specs` in a new one. Never throws. */
  async sync(specs: PortalShortcutSpec[]): Promise<PortalSetup> {
    const key = JSON.stringify(specs.map((s) => [s.id, s.trigger, s.description]).sort());
    if (this.session && this.lastKey === key && this.lastResult?.ok) return { ...this.lastResult, ignoredChanges: [] };
    this.lastKey = null;
    this.lastResult = null;
    try {
      const bus = await this.ensureBus();
      if (!bus) return { ok: false, reason: 'unavailable' };
      await this.closeSession();
      this.active = new Set();
      if (specs.length === 0) return { ok: true, granted: [], denied: [] };

      if (!this.registered) {
        try {
          await bus.invoke({ destination: BUS, path: OBJ, interface: 'org.freedesktop.host.portal.Registry', member: 'Register', signature: 'sa{sv}', body: [this.appId, []] });
        } catch (e) {
          // Already registered on this connection is fine; anything else means the portal cannot name us.
          const msg = String((e as Error)?.message ?? e);
          if (!/already|associated/i.test(msg)) { this.log(`[WaylandShortcuts] Register failed: ${msg.slice(0, 160)}`); return { ok: false, reason: 'error' }; }
        }
        this.registered = true;
      }

      const t1 = this.token('cs');
      const created = await this.request(bus, t1, {
        destination: BUS, path: OBJ, interface: GS, member: 'CreateSession', signature: 'a{sv}',
        body: [[['handle_token', ['s', t1]], ['session_handle_token', ['s', this.token('sess')]]]],
      }, SETUP_RESPONSE_TIMEOUT_MS) as unknown[];
      const session = (created?.[1] as { session_handle?: unknown } | undefined)?.session_handle;
      if (created?.[0] !== 0 || typeof session !== 'string') return { ok: false, reason: 'error' };
      this.session = session;

      const t2 = this.token('bs');
      const bound = await this.request(bus, t2, {
        destination: BUS, path: OBJ, interface: GS, member: 'BindShortcuts', signature: 'oa(sa{sv})sa{sv}',
        body: [session, specs.map((s) => [s.id, [['description', ['s', s.description]], ['preferred_trigger', ['s', s.trigger]]]]), '', [['handle_token', ['s', t2]]]],
      }, BIND_RESPONSE_TIMEOUT_MS);
      const ids = boundActionIds(bound);
      if (ids === null) return { ok: false, reason: 'declined' };
      // Every shortcut we REGISTERED may fire, not only the ones the desktop echoed a trigger for. Hyprland's
      // portal assigns nothing itself (`bound 0`): the user binds `bind = MODS, KEY, global, <appid>:<id>` in
      // hyprland.conf and the compositor then sends Activated for that id. Gating on the echoed trigger
      // dropped every one of those presses (measured on Hyprland 0.57 + xdph 1.5.0: Activated reached us, nothing fired).
      this.active = new Set(specs.map((s) => s.id));
      const triggers = boundTriggers(bound);
      const elsewhere = specs.filter((sp) => triggers[sp.id] !== undefined && triggerMatches(sp.trigger, triggers[sp.id]) === false).map((sp) => sp.id);
      const ignoredChanges = ignoredKeyChanges(this.lastRequested, specs, elsewhere);
      this.lastRequested = new Map(specs.map((s) => [s.id, s.trigger]));
      const result: PortalSetup = { ok: true, granted: ids, denied: specs.map((s) => s.id).filter((id) => !ids.includes(id)), triggers, elsewhere, ignoredChanges };
      this.lastKey = key;
      this.lastResult = result;
      return result;
    } catch (e) {
      this.log(`[WaylandShortcuts] sync failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      return { ok: false, reason: 'error' };
    }
  }

  /**
   * Open the desktop's own settings for Cipherline's shortcuts (portal ConfigureShortcuts, GlobalShortcuts v2:
   * KDE Plasma 6.8 has it; GNOME 50's backend is v1). The only way to change a key the desktop remembers: a new
   * preferred_trigger is ignored there. false = no open session / not supported / refused.
   */
  async configure(): Promise<boolean> {
    const bus = this.bus;
    if (!bus || !this.session) return false;
    try {
      await bus.invoke({ destination: BUS, path: OBJ, interface: GS, member: 'ConfigureShortcuts', signature: 'osa{sv}', body: [this.session, '', []] });
      return true;
    } catch (e) {
      this.log(`[WaylandShortcuts] ConfigureShortcuts failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
      return false;
    }
  }

  private async closeSession(): Promise<void> {
    const bus = this.bus;
    const s = this.session;
    this.session = null;
    if (!bus || !s) return;
    try { await bus.invoke({ destination: BUS, path: s, interface: 'org.freedesktop.portal.Session', member: 'Close' }); } catch { /* already gone */ }
  }

  async dispose(): Promise<void> {
    await this.closeSession();
    this.unsubscribe?.();
    this.unsubscribe = null;
    try { this.bus?.close(); } catch { /* gone */ }
    this.bus = null;
    this.registered = false;
  }
}

/** dbus-native session bus adapter, or null when there is no session bus. Linux only (lazy require). */
export function dbusSessionBus(env: NodeJS.ProcessEnv = process.env): PortalSessionBus | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!env.DBUS_SESSION_BUS_ADDRESS && !(uid >= 0 && fs.existsSync(`/run/user/${uid}/bus`))) return null;
  type Raw = {
    invoke: (msg: Record<string, unknown>, cb: (err: unknown, res: unknown) => void) => void;
    addMatch: (rule: string, cb: (e: unknown) => void) => void;
    name?: string;
    connection: { name?: string; on: (ev: string, cb: (...a: never[]) => void) => void; removeListener: (ev: string, cb: (...a: never[]) => void) => void; end?: () => void };
  };
  let bus: Raw;
  let toPlain: (v: unknown) => unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require so dbus-native stays out of the Windows/macOS dependency graph (Linux-only module)
    const dbus = require('dbus-native');
    bus = dbus.sessionBus();
    toPlain = dbus.toPlain;
  } catch {
    return null;
  }
  bus.connection.on('error', (() => { /* the pending call fails on its own */ }) as never);
  const errMessage = (err: unknown): string => {
    const e = err as { dbusName?: string; message?: string; body?: unknown[] } | string;
    if (typeof e === 'string') return e;
    return `${e?.dbusName ?? ''} ${Array.isArray(e?.body) ? String(e.body[0] ?? '') : e?.message ?? ''}`.trim();
  };
  return {
    uniqueName: async () => {
      for (let i = 0; i < 60; i++) {
        const n = bus.name ?? bus.connection.name;
        if (n) return n;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('session bus did not say hello');
    },
    invoke: (msg) => new Promise((resolve, reject) => {
      bus.invoke(msg, (err, res) => (err ? reject(new Error(errMessage(err))) : resolve(res === undefined ? res : toPlain(res))));
    }),
    addMatch: (rule) => bus.addMatch(rule, () => {}),
    onMessage: (cb) => {
      const h = ((m: never) => cb(m)) as (...a: never[]) => void;
      bus.connection.on('message', h);
      return () => bus.connection.removeListener('message', h);
    },
    close: () => { try { bus.connection.end?.(); } catch { /* gone */ } },
  };
}

/**
 * The retired KGlobalAccel workaround left a component named "cipherline" in
 * the user's kglobalshortcutsrc with these keys bound to nothing that listens.
 * It collides with the portal's own binding of the same keys (KDE shows a
 * conflict warning and the press goes nowhere), so ask KDE to drop it.
 * Best-effort, once per launch, KDE only (the service is absent elsewhere).
 */
export async function cleanupLegacyKdeComponent(bus: PortalSessionBus | null = dbusSessionBus()): Promise<void> {
  if (!bus) return;
  try {
    await Promise.race([
      bus.invoke({ destination: 'org.kde.kglobalaccel', path: '/component/cipherline', interface: 'org.kde.kglobalaccel.Component', member: 'cleanUp' }),
      new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 3000); (t as { unref?: () => void }).unref?.(); }),
    ]);
  } catch { /* not KDE, or nothing to clean */ } finally {
    try { bus.close(); } catch { /* gone */ }
  }
}
