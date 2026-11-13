/**
 * Ask the Linux secret service what state it is in BEFORE the first, blocking,
 * `safeStorage` call, without blocking ourselves.
 *
 * Why this exists. On Wayland, Chromium commits surfaces and answers frame
 * callbacks on the browser main thread. `safeStorage.isEncryptionAvailable()`
 * makes a SYNCHRONOUS D-Bus call to the wallet and parks that thread until the
 * user answers the wallet's password dialog, so a window created "just before"
 * the call never gets its first frame (measured on real KDE Plasma 6.8
 * Wayland: the notice never mapped on a first launch). The only way to put a
 * window up first is to know, without blocking, that a prompt is coming. Electron
 * exposes no async D-Bus, so we spawn `busctl` (systemd; every systemd distro)
 * from the main process and read its text output. Nothing here blocks the
 * thread, nothing here prompts, and nothing is written.
 *
 * What is asked (all read-only):
 *   KWallet (`org.kde.kwalletd6` / `kwalletd5` / `kwalletd`)
 *       isEnabled, wallets, networkWallet, isOpen(networkWallet)
 *   Secret Service (`org.freedesktop.secrets`, GNOME Keyring / KeePassXC / ...)
 *       ReadAlias("default"), then the default collection's `Locked` property
 *
 * Any failure, parse surprise or timeout is `unknown`, and `unknown` means "do
 * exactly what the code did before this module existed". A probe can therefore
 * only ever ADD a better notice; it can never stop the key store opening.
 *
 * Pure: the bus is an injected function. No `electron` import (unit-testable).
 */

export type WalletProbe =
    /** The wallet is open: safeStorage answers at once, nothing to explain. */
    | { kind: 'unlocked' }
    /** A wallet exists and is closed: safeStorage will put up the password dialog. */
    | { kind: 'locked' }
    /** The service is up but no wallet exists yet: the first use creates one (a wizard). */
    | { kind: 'no-wallet'; walletName: string | null }
    /** The service says it is switched off: safeStorage fails at once, no dialog. */
    | { kind: 'disabled' }
    /**
     * Could not tell (no busctl, parse surprise, no service): previous behaviour.
     * `timedOut`: the service was too slow to answer within the budget, which on a
     * cold login almost always means the daemon is still starting up with its
     * password dialog about to open (measured on KDE Plasma 6.8: the first call
     * after the daemon is killed takes 1-1.7 s).
     */
    | { kind: 'unknown'; timedOut?: boolean };

/** Where a backend's secret service lives on the session bus. */
export type WalletService =
    | { service: 'kwallet'; bus: string; path: string }
    | { service: 'secret-service' };

export function serviceForBackend(backend: string | null | undefined): WalletService | null {
    switch (backend) {
        case 'kwallet6': return { service: 'kwallet', bus: 'org.kde.kwalletd6', path: '/modules/kwalletd6' };
        case 'kwallet5': return { service: 'kwallet', bus: 'org.kde.kwalletd5', path: '/modules/kwalletd5' };
        case 'kwallet': return { service: 'kwallet', bus: 'org.kde.kwalletd', path: '/modules/kwalletd' };
        case 'gnome_libsecret': return { service: 'secret-service' };
        default: return null;
    }
}

/** Hard ceiling for the whole probe (spec: never hold the launch for more than this). */
export const PROBE_TIMEOUT_MS = 1500;

/** One bus call: `ok:false` for a non-zero exit, a spawn error or a timeout. */
export type BusExec = (args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string }>;

// --------------------------------------------------------------------------
// busctl output parsing. Formats (systemd 240+): `b true`, `s "kdewallet"`,
// `as 1 "kdewallet"`, `as 0`, `o "/"`, `i -1`, `x 12`.
// --------------------------------------------------------------------------

function unquote(token: string): string | null {
    if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') return null;
    return token.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

export function parseBool(out: string): boolean | null {
    const m = /^b (true|false)\s*$/.exec(out.trim());
    return m ? m[1] === 'true' : null;
}

export function parseString(out: string): string | null {
    const m = /^s (".*")\s*$/s.exec(out.trim());
    return m ? unquote(m[1]) : null;
}

export function parseObjectPath(out: string): string | null {
    const m = /^o (".*")\s*$/s.exec(out.trim());
    return m ? unquote(m[1]) : null;
}

export function parseStringArray(out: string): string[] | null {
    const t = out.trim();
    const head = /^as (\d+)\s*(.*)$/s.exec(t);
    if (!head) return null;
    const count = Number(head[1]);
    const items: string[] = [];
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(head[2])) !== null) items.push(m[1].replace(/\\(["\\])/g, '$1'));
    return items.length === count ? items : null;
}

/** busctl `i -1`, `x 0`, `i 123`. */
export function parseInteger(out: string): number | null {
    const m = /^[ix] (-?\d+)\s*$/.exec(out.trim());
    return m ? Number(m[1]) : null;
}

/** A wallet name is passed as a busctl argument: keep it to plain words. */
export function isSafeWalletName(name: string | null | undefined): name is string {
    return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,63}$/.test(name);
}

// --------------------------------------------------------------------------
// The decision tables.
// --------------------------------------------------------------------------

export interface KWalletAnswers {
    isEnabled: boolean | null;
    wallets: string[] | null;
    networkWallet: string | null;
    isOpen: boolean | null;
}

/**
 *   isEnabled === false                           -> disabled
 *   wallets() is empty                            -> no-wallet   (a fresh account)
 *   networkWallet unreadable / not in wallets()   -> no-wallet when the list is
 *                                                    non-empty but lacks it, else unknown
 *   isOpen(networkWallet) true / false            -> unlocked / locked
 *   anything we could not read                    -> unknown
 */
export function classifyKWallet(a: KWalletAnswers): WalletProbe {
    if (a.isEnabled === false) return { kind: 'disabled' };
    if (a.isEnabled === null || a.wallets === null) return { kind: 'unknown' };
    if (a.wallets.length === 0) {
        return { kind: 'no-wallet', walletName: isSafeWalletName(a.networkWallet) ? a.networkWallet : null };
    }
    if (!isSafeWalletName(a.networkWallet)) return { kind: 'unknown' };
    if (!a.wallets.includes(a.networkWallet)) return { kind: 'no-wallet', walletName: a.networkWallet };
    if (a.isOpen === true) return { kind: 'unlocked' };
    if (a.isOpen === false) return { kind: 'locked' };
    return { kind: 'unknown' };
}

export interface SecretServiceAnswers {
    /** `ReadAlias("default")`: an object path, "/" for none, null when the call failed. */
    defaultAlias: string | null;
    /** The collection's `Locked`, null when it could not be read. */
    locked: boolean | null;
}

export function classifySecretService(a: SecretServiceAnswers): WalletProbe {
    if (a.defaultAlias === null) return { kind: 'unknown' };
    if (a.defaultAlias === '/') return { kind: 'no-wallet', walletName: null };
    if (a.locked === true) return { kind: 'locked' };
    if (a.locked === false) return { kind: 'unlocked' };
    return { kind: 'unknown' };
}

// --------------------------------------------------------------------------
// Running it.
// --------------------------------------------------------------------------

const SESSION = ['--user', '--no-pager'];
const KWALLET_IFACE = 'org.kde.KWallet';

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>(resolve => {
        const t = setTimeout(() => resolve(fallback), ms);
        p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(fallback); });
    });
}

async function call(exec: BusExec, timeoutMs: number, args: string[]): Promise<string | null> {
    try {
        const r = await exec([...SESSION, ...args], timeoutMs);
        return r.ok ? r.stdout : null;
    } catch {
        return null;
    }
}

async function probeKWallet(svc: Extract<WalletService, { service: 'kwallet' }>, exec: BusExec, ms: number): Promise<WalletProbe> {
    const k = (method: string, ...rest: string[]) => call(exec, ms, ['call', svc.bus, svc.path, KWALLET_IFACE, method, ...rest]);
    // The first call may have to START the daemon (D-Bus activation); the three
    // reads are independent, so they share that one wait.
    const [en, ws, nw] = await Promise.all([k('isEnabled'), k('wallets'), k('networkWallet')]);
    const isEnabled = en === null ? null : parseBool(en);
    const wallets = ws === null ? null : parseStringArray(ws);
    const networkWallet = nw === null ? null : parseString(nw);
    let isOpen: boolean | null = null;
    if (isEnabled !== false && wallets && wallets.length > 0 && isSafeWalletName(networkWallet) && wallets.includes(networkWallet)) {
        const o = await k('isOpen', 's', networkWallet);
        isOpen = o === null ? null : parseBool(o);
    }
    const verdict = classifyKWallet({ isEnabled, wallets, networkWallet, isOpen });
    if (verdict.kind === 'unlocked') {
        // `isOpen` alone is not trustworthy on Plasma 6.8's kwalletd6 / ksecretd:
        // after a CANCELLED password dialog, `open()` still hands back a handle
        // and `isOpen` says true while the wallet is in fact closed (measured:
        // the next safeStorage call put the dialog up again). The wallet's
        // Secret Service view of the same state, `Locked`, was right every time.
        // So a "locked" there overrides an "open" here, never the other way.
        const ss = await probeSecretService(exec, ms);
        if (ss.kind === 'locked') return { kind: 'locked' };
    }
    return verdict;
}

async function probeSecretService(exec: BusExec, ms: number): Promise<WalletProbe> {
    const ra = await call(exec, ms, ['call', 'org.freedesktop.secrets', '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service', 'ReadAlias', 's', 'default']);
    const defaultAlias = ra === null ? null : parseObjectPath(ra);
    let locked: boolean | null = null;
    if (defaultAlias && defaultAlias !== '/' && /^\/[A-Za-z0-9_/]+$/.test(defaultAlias)) {
        const lk = await call(exec, ms, ['get-property', 'org.freedesktop.secrets', defaultAlias, 'org.freedesktop.Secret.Collection', 'Locked']);
        locked = lk === null ? null : parseBool(lk);
    }
    return classifySecretService({ defaultAlias, locked });
}

/** Never rejects, never takes longer than `timeoutMs`; `unknown` on any trouble. */
export async function probeWallet(backend: string | null | undefined, exec: BusExec, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<WalletProbe> {
    const svc = serviceForBackend(backend);
    if (!svc) return { kind: 'unknown' };
    const unknown: WalletProbe = { kind: 'unknown', timedOut: true };
    const run = svc.service === 'kwallet' ? probeKWallet(svc, exec, timeoutMs) : probeSecretService(exec, timeoutMs);
    return withDeadline(run, timeoutMs, unknown);
}

// --------------------------------------------------------------------------
// What the launch does about it.
// --------------------------------------------------------------------------

export type NoticeMode = 'unlock' | 'create';

export type KeyringPlan =
    /** Nothing to explain: the call will not prompt (unlocked) or will fail at once (disabled). */
    | { action: 'none' }
    /**
     * Could not tell: the previous behaviour (announced once per boot, with the
     * page's own 400 ms reveal), except that a probe that merely ran out of time
     * (`immediate`) shows the notice at once: a service still starting up is a
     * prompt that is about to open, and a delayed card never maps on Wayland.
     */
    | { action: 'legacy'; immediate: boolean }
    /** A prompt is coming: show the notice, wait until it is on screen, THEN call safeStorage. */
    | { action: 'notice-first'; mode: NoticeMode }
    /** KWallet with no wallet: show the notice, make KDE open its creation wizard (async), then call safeStorage. */
    | { action: 'create-wallet'; mode: 'create'; walletName: string };

export function decideKeyringPlan(service: WalletService | null, probe: WalletProbe): KeyringPlan {
    switch (probe.kind) {
        case 'unlocked':
        case 'disabled':
            return { action: 'none' };
        case 'unknown':
            return { action: 'legacy', immediate: probe.timedOut === true };
        case 'locked':
            return { action: 'notice-first', mode: 'unlock' };
        case 'no-wallet':
            // Only KWallet is asked to create one by us; libsecret creates its
            // own keyring inside the safeStorage call, so there the notice is the
            // whole job. A KWallet that told us no name falls back to the default.
            if (service?.service === 'kwallet') {
                return { action: 'create-wallet', mode: 'create', walletName: isSafeWalletName(probe.walletName) ? probe.walletName : 'kdewallet' };
            }
            return { action: 'notice-first', mode: 'create' };
    }
}

/** What opening the wallet ourselves came to. */
export type OpenWalletResult = 'opened' | 'cancelled' | 'failed';

/** Longest we wait for a person to finish KDE's wizard / password dialog. */
export const OPEN_WALLET_TIMEOUT_MS = 5 * 60_000;

/**
 * `org.kde.KWallet.open(wallet, wId=0, appid)`: the SAME call, with the same
 * appid, Chromium makes (measured with dbus-monitor), but asynchronous for us,
 * so the notice keeps painting while the wizard is up. Returns a positive
 * handle when the wallet was created/opened and -1 when the person cancelled.
 */
export async function openKWallet(
    svc: Extract<WalletService, { service: 'kwallet' }>,
    walletName: string,
    appId: string,
    exec: BusExec,
    timeoutMs: number = OPEN_WALLET_TIMEOUT_MS,
): Promise<OpenWalletResult> {
    if (!isSafeWalletName(walletName)) return 'failed';
    const out = await call(exec, timeoutMs, ['call', svc.bus, svc.path, KWALLET_IFACE, 'open', 'sxs', walletName, '0', appId]);
    if (out === null) return 'failed';
    const handle = parseInteger(out);
    if (handle === null) return 'failed';
    if (handle > 0) return 'opened';
    return handle === -1 ? 'cancelled' : 'failed';
}

/**
 * Create-and-open, as the wizard actually behaves. Measured on real KDE Plasma
 * 6.8 (kwalletd6 / ksecretd): when the wallet does not exist, the FIRST
 * `open()` runs the creation wizard and the password dialog and, even when the
 * person completes both and the wallet file is written, returns -1; a second
 * `open()` then returns a handle at once. A genuine cancel (the person pressed
 * Cancel in the wizard) writes nothing and leaves `wallets()` empty. So -1 only
 * means "refused" when no wallet exists afterwards; otherwise ask once more.
 * Either way nothing is written by US: the daemon writes its own wallet.
 */
export async function createKWallet(
    svc: Extract<WalletService, { service: 'kwallet' }>,
    walletName: string,
    appId: string,
    exec: BusExec,
    timeoutMs: number = OPEN_WALLET_TIMEOUT_MS,
): Promise<OpenWalletResult> {
    const first = await openKWallet(svc, walletName, appId, exec, timeoutMs);
    if (first !== 'cancelled') return first;
    const out = await call(exec, PROBE_TIMEOUT_MS, ['call', svc.bus, svc.path, KWALLET_IFACE, 'wallets']);
    const wallets = out === null ? null : parseStringArray(out);
    if (!wallets || !wallets.includes(walletName)) return 'cancelled';
    return openKWallet(svc, walletName, appId, exec, timeoutMs);
}

// --------------------------------------------------------------------------
// Someone else already creating the keyring (Secret Service, no collection yet).
// --------------------------------------------------------------------------

/**
 * Why this exists (Linux VM matrix 2026-11-09, staging.213; Ubuntu 20.04 /
 * 22.04 Cinnamon / 24.04, GNOME Keyring with no keyring yet — an autologin or
 * fresh account): TWO clients inside our own process ask GNOME Keyring to create
 * the default keyring at once — Chromium's asynchronous key provider (its own
 * D-Bus connection: ReadAlias, CreateCollection, Prompt) and, a moment later,
 * safeStorage through libsecret (SearchItems, CreateItem, CreateCollection,
 * Prompt). The person sees ONE "Choose password for new keyring" dialog; after
 * they answer, GNOME Keyring completes that prompt and leaves the other one
 * pending for ever (observed: no Completed signal, the object stays listed).
 * When the stranded prompt is safeStorage's, the main thread blocks in
 * `isEncryptionAvailable()` for good: no window, nothing stored, the notice up.
 * A relaunch works (the keyring then exists). Fedora 44 happened to complete
 * the other order.
 *
 * The preflight runs BEFORE safeStorage, so a prompt already pending then is not
 * ours. Waiting (asynchronously) until the keyring exists, or that prompt has
 * gone (cancelled), means safeStorage finds a collection and never raises a
 * prompt of its own.
 */
export const SECRET_PROMPT_SEEN_GRACE_MS = 1500;
export const SECRET_COLLECTION_WAIT_MS = 5 * 60_000;
export const SECRET_COLLECTION_POLL_MS = 400;

/** Pending Secret Service prompt objects, from `busctl --user tree org.freedesktop.secrets` output. */
export function parsePendingPrompts(treeOut: string): string[] {
    const out = new Set<string>();
    for (const m of treeOut.matchAll(/\/org\/freedesktop\/secrets\/prompt\/[A-Za-z0-9_]+/g)) out.add(m[0]);
    return [...out];
}

export type CollectionWaitResult =
    /** No other prompt showed up within the grace period: nothing to wait for. */
    | 'no-other-prompt'
    /** The default keyring exists now (the person answered the other prompt). */
    | 'created'
    /** The other prompt went away without a keyring (cancelled / dismissed). */
    | 'prompt-gone'
    /** Gave up waiting; the caller goes ahead as before. */
    | 'timeout';

export async function waitForConcurrentCollectionCreate(
    exec: BusExec,
    deps: { now?: () => number; sleep?: (ms: number) => Promise<void>; graceMs?: number; maxMs?: number; pollMs?: number } = {},
): Promise<CollectionWaitResult> {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const grace = deps.graceMs ?? SECRET_PROMPT_SEEN_GRACE_MS;
    const max = deps.maxMs ?? SECRET_COLLECTION_WAIT_MS;
    const poll = deps.pollMs ?? SECRET_COLLECTION_POLL_MS;
    const callMs = 1500;
    const aliasExists = async () => {
        const ra = await call(exec, callMs, ['call', 'org.freedesktop.secrets', '/org/freedesktop/secrets', 'org.freedesktop.Secret.Service', 'ReadAlias', 's', 'default']);
        const p = ra === null ? null : parseObjectPath(ra);
        return !!p && p !== '/';
    };
    const pending = async (): Promise<string[] | null> => {
        const t = await call(exec, callMs, ['tree', 'org.freedesktop.secrets']);
        return t === null ? null : parsePendingPrompts(t);
    };
    const t0 = now();
    let seen = false;
    while (now() - t0 < max) {
        if (await aliasExists()) return seen ? 'created' : 'no-other-prompt';
        const p = await pending();
        if (p === null) return seen ? 'prompt-gone' : 'no-other-prompt'; // cannot list: behave as before
        if (p.length > 0) seen = true;
        else if (seen) return 'prompt-gone';
        else if (now() - t0 >= grace) return 'no-other-prompt';
        await sleep(poll);
    }
    return 'timeout';
}
