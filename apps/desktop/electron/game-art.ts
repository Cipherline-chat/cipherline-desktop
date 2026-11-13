/**
 * The picture and launcher of the game the detector found - read from THIS
 * computer, for the profile's "Playing ..." row.
 *
 * What leaves this module, and where it goes: `{ name, icon, store, appId }` is
 * returned to the renderer over the sender-checked `game:get-current-art`
 * channel. `icon` is a small PNG data URL of the game's own executable icon,
 * `store` one word naming the launcher folder it lives under, `appId` a Steam
 * app number. The executable's PATH is used here to find the icon and the
 * launcher and goes nowhere else: not to the renderer, not to the API, not into
 * a log. Friends never receive any of this (they see the game's name, which
 * presence already carries, and look the picture up by that name on their own
 * device: src/utils/gameCatalog.ts).
 *
 * Free of any `electron` import so it can be tested: the Electron pieces
 * (`app.getFileIcon`, `nativeImage`) are passed in as `GameArtDeps`.
 */

export type StoreId = 'steam' | 'epic' | 'riot' | 'battlenet' | 'xbox' | 'ea' | 'ubisoft' | 'gog';
/** Mirrors src/utils/gameCatalog.ts STORE_LABEL (game-art.test.ts reads that file). */
export const STORE_IDS: readonly StoreId[] = ['steam', 'epic', 'riot', 'battlenet', 'xbox', 'ea', 'ubisoft', 'gog'];

export interface GameArtResult {
    name: string;
    icon: string | null;
    store: StoreId | null;
    appId: number | null;
}

/** An icon larger than this (as a data URL) is dropped, never sent. Mirrors src/utils/gameArt.ts. */
export const ICON_MAX_CHARS = 100_000;
const ICON_PX = 128;

/** The few NativeImage members used (a fake in tests). */
export interface ImageLike {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    resize(o: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): ImageLike;
    toPNG(): Buffer;
}

export interface GameArtDeps {
    platform: NodeJS.Platform;
    /** Run a program with extra environment; resolves stdout. Never a shell. */
    exec(file: string, args: string[], env: Record<string, string>): Promise<string>;
    exists(path: string): Promise<boolean>;
    /** `app.getFileIcon(path, { size: 'large' })`. */
    fileIcon(path: string): Promise<ImageLike>;
    /** `nativeImage.createThumbnailFromPath` (Windows / macOS), when present: a large icon. */
    thumbnail?(path: string, px: number): Promise<ImageLike>;
    /** Installed Steam game name -> app id (game-detector.ts). */
    steamAppId(name: string): number | null;
    env: Record<string, string | undefined>;
    now(): number;
}

/** The game, as the detector reports it. */
export interface GameRef { name: string; processName: string }

// ── Which launcher? From where the executable lives ──────────────────────

const LAUNCHER_DIRS: ReadonlyArray<readonly [StoreId, readonly string[]]> = [
    ['steam', ['/steamapps/common/']],
    ['epic', ['/epic games/', '/epicgames/']],
    ['riot', ['/riot games/']],
    ['battlenet', ['/battle.net/', '/blizzard entertainment/']],
    ['xbox', ['/windowsapps/', '/xboxgames/']],
    ['ea', ['/ea games/', '/electronic arts/', '/ea desktop/', '/origin games/']],
    ['ubisoft', ['/ubisoft game launcher/', '/ubisoft/ubisoft game launcher/']],
    ['gog', ['/gog galaxy/games/', '/gog games/']],
];

/** The launcher whose games folder `exePath` sits in, or null (a plain install path says nothing). */
export function classifyStore(exePath: string): StoreId | null {
    const p = '/' + exePath.replace(/\\/g, '/').toLowerCase().replace(/^\/+/, '');
    for (const [store, dirs] of LAUNCHER_DIRS) {
        if (dirs.some(d => p.includes(d))) return store;
    }
    return null;
}

// ── Finding the executable ───────────────────────────────────────────────

/** Process names come from the process list; refuse anything odd before it reaches a command. */
export const isSafeProcessName = (n: unknown): n is string => typeof n === 'string' && /^[\w .+()'-]{1,100}$/.test(n);

/** A plausible absolute executable path (Windows `X:\...\a.exe`), no control characters. */
export function readExePath(line: string): string | null {
    const p = line.trim();
    if (p.length < 5 || p.length > 520) return null;
    for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) < 0x20) return null;
    return /^[A-Za-z]:\\[^<>"|?*]+\.exe$/i.test(p) ? p : null;
}

/** macOS: the `.app` bundle a `ps` command path sits in (its icon is the app's), else the path itself. */
export function macAppRoot(commPath: string): string {
    const i = commPath.indexOf('.app/');
    return i > 0 ? commPath.slice(0, i + 4) : commPath;
}

// The process name travels in the environment, never in the script text, so no
// quoting rule can be broken out of. WQL needs a single quote doubled. The
// script itself has no double quotes, so it survives Windows' argv quoting.
const PS_FIND_EXE =
    '$q = [char]39; $n = $env:CL_PROC.Replace($q, $q + $q) + \'.exe\'; ' +
    "$p = Get-CimInstance Win32_Process -Filter ('Name = ' + $q + $n + $q) | Where-Object { $_.ExecutablePath } | Select-Object -First 1; " +
    'if ($p) { $p.ExecutablePath }';

export async function findExecutablePath(processName: string, deps: GameArtDeps): Promise<string | null> {
    if (!isSafeProcessName(processName)) return null;
    try {
        if (deps.platform === 'win32') {
            const out = await deps.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_FIND_EXE], { CL_PROC: processName });
            return readExePath(out.split(/\r?\n/)[0] ?? '');
        }
        if (deps.platform === 'darwin') {
            const out = await deps.exec('ps', ['-axo', 'comm='], {});
            for (const line of out.split('\n')) {
                const l = line.trim();
                if (l.startsWith('/') && l.length <= 520 && l.slice(l.lastIndexOf('/') + 1).toLowerCase() === processName) return macAppRoot(l);
            }
        }
    } catch { /* not found / not allowed */ }
    return null;
}

/** Minecraft Java runs as java(w).exe, whose icon is a coffee cup: its own launcher's icon is the right one. */
export function minecraftLauncherCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
    if (platform === 'win32') {
        return [env['ProgramFiles(x86)'], env['ProgramFiles'], env['LOCALAPPDATA'] ? `${env['LOCALAPPDATA']}\\Programs` : undefined]
            .filter((d): d is string => !!d)
            .map(d => `${d}\\Minecraft Launcher\\MinecraftLauncher.exe`);
    }
    if (platform === 'darwin') return ['/Applications/Minecraft.app'];
    return [];
}

// ── Making the picture ───────────────────────────────────────────────────

/** An image -> a bounded PNG data URL, or null (empty, too big, throws). */
export function toIconDataUrl(img: ImageLike | null | undefined): string | null {
    try {
        if (!img || img.isEmpty()) return null;
        const { width, height } = img.getSize();
        if (!(width > 0 && height > 0)) return null;
        const sized = Math.max(width, height) > ICON_PX ? img.resize({ width: ICON_PX, height: ICON_PX, quality: 'best' }) : img;
        const png = sized.toPNG();
        if (png.length === 0) return null;
        const url = `data:image/png;base64,${png.toString('base64')}`;
        return url.length <= ICON_MAX_CHARS ? url : null;
    } catch { return null; }
}

async function iconFor(path: string, deps: GameArtDeps): Promise<string | null> {
    // A big icon where the OS has one (256 px), else the shell's "large" icon (32 px on Windows).
    if (deps.thumbnail) {
        try {
            const big = toIconDataUrl(await deps.thumbnail(path, 256));
            if (big) return big;
        } catch { /* fall through */ }
    }
    try { return toIconDataUrl(await deps.fileIcon(path)); } catch { return null; }
}

/** The art for one detected game. Never throws. */
export async function resolveGameArt(game: GameRef, deps: GameArtDeps): Promise<GameArtResult> {
    const out: GameArtResult = { name: game.name, icon: null, store: null, appId: deps.steamAppId(game.name) };
    if (out.appId !== null) out.store = 'steam';
    const isMinecraft = game.name === 'Minecraft';
    try {
        // Minecraft Java has no executable of its own to read (the process is java).
        const exe = game.processName === 'java' ? null : await findExecutablePath(game.processName, deps);
        if (exe) {
            out.store = classifyStore(exe) ?? out.store;
            out.icon = await iconFor(exe, deps);
        }
        if (!out.icon && isMinecraft) {
            for (const c of minecraftLauncherCandidates(deps.platform, deps.env)) {
                if (!(await deps.exists(c))) continue;
                out.icon = await iconFor(c, deps);
                if (out.icon) break;
            }
        }
    } catch { /* leave what we have */ }
    return out;
}

/**
 * Remembers each game's answer for the session so a profile opened ten times
 * costs one lookup. A game with no picture is asked again after 10 minutes
 * (a launcher may not have been readable yet); one with a picture, never.
 */
export class GameArtResolver {
    private done = new Map<string, { at: number; value: GameArtResult }>();
    private inflight = new Map<string, Promise<GameArtResult>>();
    static readonly RETRY_MS = 10 * 60_000;
    static readonly MAX = 32;

    constructor(private readonly deps: GameArtDeps) {}

    get(game: GameRef): Promise<GameArtResult> {
        const key = `${game.processName}\n${game.name}`;
        const hit = this.done.get(key);
        if (hit && (hit.value.icon || this.deps.now() - hit.at < GameArtResolver.RETRY_MS)) return Promise.resolve(hit.value);
        let p = this.inflight.get(key);
        if (!p) {
            p = resolveGameArt(game, this.deps).then((value) => {
                this.done.delete(key);
                this.done.set(key, { at: this.deps.now(), value });
                while (this.done.size > GameArtResolver.MAX) this.done.delete(this.done.keys().next().value as string);
                return value;
            }).finally(() => this.inflight.delete(key));
            this.inflight.set(key, p);
        }
        return p;
    }
}
