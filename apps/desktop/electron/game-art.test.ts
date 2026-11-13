import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    classifyStore, readExePath, macAppRoot, isSafeProcessName, minecraftLauncherCandidates, toIconDataUrl,
    resolveGameArt, findExecutablePath, GameArtResolver, STORE_IDS, ICON_MAX_CHARS,
    type GameArtDeps, type ImageLike,
} from './game-art';

const here = dirname(fileURLToPath(import.meta.url));

function img(w: number, h: number, bytes = 400, empty = false): ImageLike & { resized: number } {
    const o = {
        resized: 0,
        isEmpty: () => empty,
        getSize: () => ({ width: w, height: h }),
        resize: () => { o.resized += 1; return o; },
        toPNG: () => Buffer.alloc(bytes, 7),
    };
    return o;
}

function deps(over: Partial<GameArtDeps> = {}): GameArtDeps & { execCalls: Array<{ file: string; args: string[]; env: Record<string, string> }>; iconCalls: string[] } {
    const execCalls: Array<{ file: string; args: string[]; env: Record<string, string> }> = [];
    const iconCalls: string[] = [];
    return {
        platform: 'win32',
        exec: async (file, args, env) => { execCalls.push({ file, args, env }); return 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\BeamNG.drive\\BeamNG.drive.exe\r\n'; },
        exists: async () => false,
        fileIcon: async (p) => { iconCalls.push(p); return img(32, 32); },
        steamAppId: () => null,
        env: {},
        now: () => 1_000,
        ...over,
        execCalls, iconCalls,
    } as GameArtDeps & { execCalls: typeof execCalls; iconCalls: string[] };
}

describe('classifyStore: the launcher folder an executable sits in', () => {
    it.each([
        ['C:\\Program Files (x86)\\Steam\\steamapps\\common\\BeamNG.drive\\x.exe', 'steam'],
        ['D:\\SteamLibrary\\steamapps\\common\\Rust\\Rust.exe', 'steam'],
        ['C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe', 'epic'],
        ['C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', 'riot'],
        ['C:\\Riot Games\\League of Legends\\Game\\League of Legends.exe', 'riot'],
        ['C:\\Program Files (x86)\\Battle.net\\Battle.net.exe', 'battlenet'],
        ['C:\\Program Files\\Blizzard Entertainment\\Hearthstone\\Hearthstone.exe', 'battlenet'],
        ['C:\\Program Files\\WindowsApps\\Microsoft.254428597.Forza_1.0_x64__8wekyb3d8bbwe\\forza.exe', 'xbox'],
        ['C:\\XboxGames\\Halo\\Content\\haloinfinite.exe', 'xbox'],
        ['C:\\Program Files\\EA Games\\Battlefield 2042\\BF2042.exe', 'ea'],
        ['C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe', 'ea'],
        ['C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Far Cry 6\\FarCry6.exe', 'ubisoft'],
        ['C:\\GOG Galaxy\\Games\\Witcher 3\\witcher3.exe', 'gog'],
        ['C:\\GOG Games\\Witcher 3\\witcher3.exe', 'gog'],
        ['/home/me/.local/share/Steam/steamapps/common/Dota 2/game/bin/dota2', 'steam'],
    ] as const)('%s -> %s', (p, want) => {
        expect(classifyStore(p)).toBe(want);
    });

    it('says nothing for a plain install path, and does not match a folder merely named alike', () => {
        expect(classifyStore('C:\\Games\\Cool Game\\cool.exe')).toBeNull();
        expect(classifyStore('C:\\Users\\me\\Downloads\\steamapps-notes\\a.exe')).toBeNull();
        expect(classifyStore('C:\\Program Files\\Epic Gamesy\\a.exe')).toBeNull();
        expect(classifyStore('')).toBeNull();
    });
});

describe('what main will accept from a process list and from PowerShell', () => {
    it('process names: plain names only', () => {
        for (const n of ['beamng.drive.x64', 'league of legends', "don't starve", 'forzahorizon5', 'r5apex']) expect(isSafeProcessName(n), n).toBe(true);
        for (const n of ['a;b', 'a"b', 'a`b', 'a$b', 'a|b', 'a&b', 'a\nb', '', 'x'.repeat(101), 'a\\b', 'a/b', 5, null]) expect(isSafeProcessName(n), String(n)).toBe(false);
    });

    it('an executable path must be an absolute .exe path with no control characters', () => {
        expect(readExePath('C:\\Games\\a b\\x.exe\r')).toBe('C:\\Games\\a b\\x.exe');
        expect(readExePath('C:\\Games\\x.EXE')).toBe('C:\\Games\\x.EXE');
        for (const bad of ['', 'x.exe', '\\\\server\\share\\x.exe', 'C:\\a\\b.dll', 'C:\\a\\b\u0007.exe', 'C:\\a"b.exe', 'C:\\' + 'a'.repeat(600) + '.exe', 'Access is denied']) {
            expect(readExePath(bad), bad.slice(0, 30)).toBeNull();
        }
    });

    it('macOS: the .app bundle, else the path', () => {
        expect(macAppRoot('/Applications/Cool.app/Contents/MacOS/Cool')).toBe('/Applications/Cool.app');
        expect(macAppRoot('/usr/local/bin/tool')).toBe('/usr/local/bin/tool');
    });
});

describe('findExecutablePath', () => {
    it('Windows: the process name travels in the environment, never in the script', async () => {
        const d = deps();
        const p = await findExecutablePath("it's a game", d);
        expect(p).toBe('C:\\Program Files (x86)\\Steam\\steamapps\\common\\BeamNG.drive\\BeamNG.drive.exe');
        const [call] = d.execCalls;
        expect(call.file).toBe('powershell');
        expect(call.env).toEqual({ CL_PROC: "it's a game" });
        const script = call.args[call.args.length - 1];
        expect(script).not.toContain("it's a game");
        expect(script).toContain('$env:CL_PROC');
        // No double quotes in the script: it survives Windows argv quoting.
        expect(script).not.toContain('"');
    });

    it('refuses an unsafe name without running anything', async () => {
        const d = deps();
        expect(await findExecutablePath('a"; Remove-Item', d)).toBeNull();
        expect(d.execCalls).toHaveLength(0);
    });

    it('macOS: finds the bundle from ps output by program name', async () => {
        const d = deps({ platform: 'darwin', exec: async () => '/sbin/launchd\n/Applications/Cool Game.app/Contents/MacOS/CoolGame\n' });
        expect(await findExecutablePath('coolgame', d)).toBe('/Applications/Cool Game.app');
    });

    it('a failing lookup is null, not a throw; Linux has none', async () => {
        expect(await findExecutablePath('x', deps({ exec: async () => { throw new Error('denied'); } }))).toBeNull();
        expect(await findExecutablePath('x', deps({ platform: 'linux' }))).toBeNull();
    });
});

describe('toIconDataUrl', () => {
    it('makes a PNG data URL, shrinking anything larger than 128 px', () => {
        const big = img(256, 256);
        const url = toIconDataUrl(big);
        expect(url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
        expect(big.resized).toBe(1);
        const small = img(32, 32);
        expect(toIconDataUrl(small)).not.toBeNull();
        expect(small.resized).toBe(0);
    });

    it('drops empty, zero-sized, oversize and throwing images', () => {
        expect(toIconDataUrl(null)).toBeNull();
        expect(toIconDataUrl(img(32, 32, 400, true))).toBeNull();
        expect(toIconDataUrl(img(0, 0))).toBeNull();
        expect(toIconDataUrl(img(32, 32, 0))).toBeNull();
        expect(toIconDataUrl(img(32, 32, ICON_MAX_CHARS))).toBeNull();
        const bad = { ...img(32, 32), toPNG: () => { throw new Error('boom'); } };
        expect(toIconDataUrl(bad)).toBeNull();
    });
});

describe('resolveGameArt', () => {
    it('reads the icon of the running executable and the launcher from its folder; the path stays inside', async () => {
        const d = deps({ steamAppId: () => 284160 });
        const r = await resolveGameArt({ name: 'BeamNG.drive', processName: 'beamng.drive.x64' }, d);
        expect(r.icon).toMatch(/^data:image\/png;base64,/);
        expect(r.store).toBe('steam');
        expect(r.appId).toBe(284160);
        expect(d.iconCalls).toEqual(['C:\\Program Files (x86)\\Steam\\steamapps\\common\\BeamNG.drive\\BeamNG.drive.exe']);
        // Nothing of the filesystem is in the answer.
        expect(Object.keys(r).sort()).toEqual(['appId', 'icon', 'name', 'store']);
        expect(JSON.stringify(r)).not.toMatch(/steamapps|Program Files|\\\\/);
    });

    it('prefers the big shell thumbnail and falls back to the file icon', async () => {
        const seen: number[] = [];
        const d = deps({ thumbnail: async (_p, px) => { seen.push(px); return img(256, 256); } });
        await resolveGameArt({ name: 'X', processName: 'x' }, d);
        expect(seen).toEqual([256]);
        expect(d.iconCalls).toEqual([]);

        const d2 = deps({ thumbnail: async () => { throw new Error('no thumbnail'); } });
        const r2 = await resolveGameArt({ name: 'X', processName: 'x' }, d2);
        expect(r2.icon).not.toBeNull();
        expect(d2.iconCalls).toHaveLength(1);
    });

    it('a game from another launcher: store from its folder, no Steam id', async () => {
        const d = deps({ exec: async () => 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe\r\n' });
        const r = await resolveGameArt({ name: 'VALORANT', processName: 'valorant-win64-shipping' }, d);
        expect(r.store).toBe('riot');
        expect(r.appId).toBeNull();
    });

    it('Minecraft Java (the process is java): never reads javaw, uses its own launcher icon', async () => {
        const launcher = 'C:\\Program Files (x86)\\Minecraft Launcher\\MinecraftLauncher.exe';
        const d = deps({
            env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' },
            exists: async (p) => p === launcher,
        });
        const r = await resolveGameArt({ name: 'Minecraft', processName: 'java' }, d);
        expect(d.execCalls).toHaveLength(0);
        expect(d.iconCalls).toEqual([launcher]);
        expect(r.icon).not.toBeNull();
        expect(r.store).toBeNull();
    });

    it('Minecraft with no launcher found: no icon (the row draws its cube), no throw', async () => {
        const r = await resolveGameArt({ name: 'Minecraft', processName: 'java' }, deps({ env: { ProgramFiles: 'C:\\Program Files' } }));
        expect(r.icon).toBeNull();
    });

    it('every failure leaves a plain answer', async () => {
        const d = deps({ exec: async () => { throw new Error('x'); }, fileIcon: async () => { throw new Error('y'); } });
        const r = await resolveGameArt({ name: 'Anything', processName: 'anything' }, d);
        expect(r).toEqual({ name: 'Anything', icon: null, store: null, appId: null });
    });

    it('Minecraft launcher paths: Windows and macOS only', () => {
        expect(minecraftLauncherCandidates('win32', { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF' })).toEqual([
            'C:\\PF86\\Minecraft Launcher\\MinecraftLauncher.exe', 'C:\\PF\\Minecraft Launcher\\MinecraftLauncher.exe',
        ]);
        expect(minecraftLauncherCandidates('darwin', {})).toEqual(['/Applications/Minecraft.app']);
        expect(minecraftLauncherCandidates('linux', {})).toEqual([]);
    });
});

describe('GameArtResolver', () => {
    it('answers a game once per session, and concurrent callers share one lookup', async () => {
        const d = deps();
        const r = new GameArtResolver(d);
        const g = { name: 'X', processName: 'x' };
        const [a, b] = await Promise.all([r.get(g), r.get(g)]);
        await r.get(g);
        expect(a).toBe(b);
        expect(d.execCalls).toHaveLength(1);
    });

    it('a game with no picture is asked again after 10 minutes, not before', async () => {
        let now = 1_000;
        const d = deps({ now: () => now, fileIcon: async () => img(0, 0) });
        const r = new GameArtResolver(d);
        const g = { name: 'X', processName: 'x' };
        await r.get(g);
        now += 60_000;
        await r.get(g);
        expect(d.execCalls).toHaveLength(1);
        now += 10 * 60_000;
        await r.get(g);
        expect(d.execCalls).toHaveLength(2);
    });
});

describe('contracts with the renderer', () => {
    it('the launcher words match src/utils/gameCatalog.ts', () => {
        const src = readFileSync(join(here, '..', 'src', 'utils', 'gameCatalog.ts'), 'utf8');
        const block = /STORE_LABEL[^=]*=\s*\{([\s\S]*?)\};/.exec(src)![1];
        const ids = [...block.matchAll(/^\s*([a-z]+):/gm)].map(m => m[1]);
        expect(ids).toEqual([...STORE_IDS]);
    });

    it('the icon cap matches src/utils/gameArt.ts and the preload bridge', () => {
        const renderer = readFileSync(join(here, '..', 'src', 'utils', 'gameArt.ts'), 'utf8');
        expect(renderer).toMatch(new RegExp(`GAME_ICON_MAX_CHARS = ${ICON_MAX_CHARS.toString().replace(/(\d)(?=(\d{3})+$)/g, '$1_')}`));
        const preload = readFileSync(join(here, 'preload.ts'), 'utf8');
        expect(preload).toMatch(/r\.icon\.length <= 100_000/);
        expect(preload).toContain("'game:get-current-art'");
    });

    it('the IPC handler takes no argument: the renderer cannot name a process or a path', () => {
        const main = readFileSync(join(here, 'main.ts'), 'utf8');
        const m = /ipcMain\.handle\('game:get-current-art',\s*async\s*\(([^)]*)\)/.exec(main);
        expect(m).not.toBeNull();
        expect(m![1].trim()).toBe('');
    });
});
