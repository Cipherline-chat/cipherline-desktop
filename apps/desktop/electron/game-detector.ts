/**
 * Cipherline Game Detector — 3-Layer Detection System
 *
 * Priority stack (first match wins):
 *   1. User Custom Games   — manually tagged executables
 *   2. Steam Library Scan  — auto-discovered from installed Steam games
 *   3. Curated Database     — 300+ hardcoded executable→name mappings
 *
 * Core detection method: executable name → display name mapping.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile, readdir, access, stat } from 'fs/promises';
import { openSync, readSync, closeSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { parseVDF } from './vdf-parser';

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: User Custom Games (synced from renderer via IPC)
// ═══════════════════════════════════════════════════════════════════════════

let customGames: Map<string, string> = new Map();
let ignoredProcesses: Set<string> = new Set();

export function setCustomGames(games: { processName: string; displayName: string }[]) {
    customGames = new Map(games.map(g => [g.processName.toLowerCase(), g.displayName]));
}

export function setIgnoredProcesses(ignored: string[]) {
    ignoredProcesses = new Set(ignored.map(p => p.toLowerCase()));
}

// ═══════════════════════════════════════════════════════════════════════════
// Poll scheduling (pure — main.ts owns the timer)
// ═══════════════════════════════════════════════════════════════════════════

export const GAME_POLL_MS = 10_000;
export const GAME_POLL_BATTERY_MS = 30_000;
export const GAME_POLL_AWAY_MS = 60_000;
/** System idle beyond this = nobody at the keyboard; poll slowly. */
export const GAME_AWAY_IDLE_SEC = 10 * 60;
/** First poll after launch / after a wake: let startup or resume settle. */
export const GAME_POLL_SETTLE_MS = 15_000;

export interface GamePollContext {
    /** The renderer still wants game activity (Settings → Game activity). */
    enabled: boolean;
    /** Between powerMonitor 'suspend' and 'resume'. */
    suspended: boolean;
    /** powerMonitor.getSystemIdleTime(), seconds. */
    systemIdleSec: number;
    onBattery: boolean;
}

/**
 * How long until the next background poll, or null for "don't poll". The
 * detector used to run every 10 s unconditionally — asleep, on battery, with
 * nobody at the PC, and with game activity switched off in Settings. Game
 * activity stays as responsive as before whenever someone is actually using
 * the machine on mains power.
 */
export function nextGamePollDelayMs(ctx: GamePollContext): number | null {
    if (!ctx.enabled || ctx.suspended) return null;
    if (ctx.systemIdleSec >= GAME_AWAY_IDLE_SEC) return GAME_POLL_AWAY_MS;
    if (ctx.onBattery) return GAME_POLL_BATTERY_MS;
    return GAME_POLL_MS;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Steam Library Auto-Detection
// ═══════════════════════════════════════════════════════════════════════════

let steamCache: Map<string, string> = new Map();
let steamCacheTime = 0;
const STEAM_CACHE_TTL = 300_000; // 5 minutes

/** Helper process names to ignore when scanning Steam install dirs. */
const HELPER_PROCESSES = new Set([
    'unitycrashhandler64', 'unitycrashhandler32', 'unitycrashhandler',
    'crashreportclient', 'crashhandler', 'crashpad_handler',
    'ue4prereqsetup_x64', 'ue4prereqsetup',
    'dxsetup', 'directx_redist', 'vcredist_x64', 'vcredist_x86',
    'vc_redist.x64', 'vc_redist.x86',
    'unins000', 'setup', 'installer', 'install',
    'dotnetfx35setup', 'dotnetfx',
    'updater', 'bootstrap', 'launcher',
    'easyanticheat_setup', 'easyanticheat',
    'beclient', 'beclient_x64', 'beservice', 'beservice_x64',
    'steamworks_common_redistributables',
    // Shared runtimes that games BUNDLE but never ARE. These also run
    // system-wide for unrelated reasons — msedgewebview2.exe is alive on
    // most Windows boxes for Widgets / Office / Teams — so mapping one to
    // whichever game's folder happened to ship it (Forza Horizon 5 was the
    // report: "playing Forza" with Forza closed) produces a permanent
    // false positive. See also resolveSteamOwners() for the general guard.
    'msedgewebview2', 'msedge', 'msedge_proxy', 'cefsharp.browsersubprocess',
    'unrealcefsubprocess', 'cef', 'chrome', 'electron',
    'dotnet', 'node', 'python', 'pythonw', 'java', 'javaw',
    'powershell', 'pwsh', 'cmd', 'conhost', 'wscript', 'cscript',
    'msiexec', 'rundll32', 'regsvr32', 'vcredist', 'oalinst',
    'crashsender', 'crashreporter', 'crashreportclient', 'bugsplat', 'bsSndRpt'.toLowerCase(),
    'eac_launcher', 'start_protected_game', 'anticheatlauncher', 'launchhelper',
]);

/**
 * Turn "exe name → every Steam game whose folder contains it" into the
 * detection cache. An executable that shows up under two or more different
 * games is a shared runtime or helper that HELPER_PROCESSES didn't know
 * about (a CEF subprocess, a redistributable, a bundled tool) — it cannot
 * identify a game, so it is dropped rather than credited to whichever game
 * was scanned first. Pure; exported for tests.
 */
export function resolveSteamOwners(owners: Map<string, Set<string>>): Map<string, string> {
    const cache = new Map<string, string>();
    for (const [exe, games] of owners) {
        if (games.size === 1) cache.set(exe, games.values().next().value as string);
    }
    return cache;
}

function getSteamPaths(): string[] {
    const home = homedir();
    if (process.platform === 'win32') {
        return [
            'C:\\Program Files (x86)\\Steam',
            'C:\\Program Files\\Steam',
            join(home, 'Steam'),
        ];
    } else if (process.platform === 'darwin') {
        return [join(home, 'Library', 'Application Support', 'Steam')];
    } else {
        // Linux
        return [
            join(home, '.steam', 'steam'),
            join(home, '.local', 'share', 'Steam'),
        ];
    }
}

async function fileExists(path: string): Promise<boolean> {
    try { await access(path); return true; } catch { return false; }
}

async function findSteamLibraryFolders(): Promise<string[]> {
    const folders: string[] = [];
    for (const steamPath of getSteamPaths()) {
        const vdfPath = join(steamPath, 'steamapps', 'libraryfolders.vdf');
        if (!await fileExists(vdfPath)) continue;
        try {
            const text = await readFile(vdfPath, 'utf-8');
            const data = parseVDF(text);
            const root = data['libraryfolders'] ?? data;
            for (const key of Object.keys(root)) {
                const entry = root[key];
                if (typeof entry === 'object' && entry?.path) {
                    folders.push(entry.path);
                }
            }
        } catch {}
    }
    // Deduplicate
    return [...new Set(folders)];
}

async function scanDirForExecutables(dir: string, gameName: string, owners: Map<string, Set<string>>): Promise<void> {
    const claim = (exe: string) => { const set = owners.get(exe) ?? new Set<string>(); set.add(gameName); owners.set(exe, set); };
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const name = entry.name.toLowerCase();

            if (entry.isFile()) {
                let exeName: string;
                if (process.platform === 'win32') {
                    if (!name.endsWith('.exe')) continue;
                    exeName = name.replace(/\.exe$/, '');
                } else {
                    // On Linux/macOS, check if file is executable (skip common non-game extensions)
                    if (name.endsWith('.txt') || name.endsWith('.cfg') || name.endsWith('.ini') ||
                        name.endsWith('.log') || name.endsWith('.vdf') || name.endsWith('.sh') ||
                        name.endsWith('.py') || name.endsWith('.dll') || name.endsWith('.so') ||
                        name.endsWith('.dylib') || name.endsWith('.json') || name.endsWith('.xml') ||
                        name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.ico') ||
                        name.endsWith('.md') || name.endsWith('.html')) continue;
                    try {
                        const s = await stat(join(dir, entry.name));
                        if (!(s.mode & 0o111)) continue; // not executable
                    } catch { continue; }
                    exeName = name;
                }

                if (HELPER_PROCESSES.has(exeName)) continue;
                claim(exeName);
            } else if (entry.isDirectory()) {
                // Scan one level deep (many games put the exe in a subfolder like bin/, Binaries/)
                const subName = name.toLowerCase();
                if (subName === '_commonredist' || subName === '__installer' ||
                    subName === 'directx' || subName === 'redist' ||
                    subName === '_redist' || subName === 'dotnet') continue;
                try {
                    const subEntries = await readdir(join(dir, entry.name), { withFileTypes: true });
                    for (const sub of subEntries) {
                        if (!sub.isFile()) continue;
                        const subFileName = sub.name.toLowerCase();
                        let subExeName: string;
                        if (process.platform === 'win32') {
                            if (!subFileName.endsWith('.exe')) continue;
                            subExeName = subFileName.replace(/\.exe$/, '');
                        } else {
                            if (subFileName.endsWith('.txt') || subFileName.endsWith('.cfg') ||
                                subFileName.endsWith('.ini') || subFileName.endsWith('.dll') ||
                                subFileName.endsWith('.so') || subFileName.endsWith('.dylib') ||
                                subFileName.endsWith('.sh') || subFileName.endsWith('.py')) continue;
                            try {
                                const s = await stat(join(dir, entry.name, sub.name));
                                if (!(s.mode & 0o111)) continue;
                            } catch { continue; }
                            subExeName = subFileName;
                        }
                        if (HELPER_PROCESSES.has(subExeName)) continue;
                        claim(subExeName);
                    }
                } catch {}
            }
        }
    } catch {}
}

let steamDirStamp = '';
let steamCacheBuiltAt = 0;
const STEAM_CACHE_MAX_AGE = 60 * 60_000;

/**
 * A cheap fingerprint of the Steam libraries: the mtime of every
 * libraryfolders.vdf and every library's steamapps directory (installing or
 * removing a game adds/removes an appmanifest there, which bumps the
 * directory's mtime). A few stat() calls instead of the full walk.
 */
async function steamLibraryStamp(): Promise<string> {
    const parts: string[] = [];
    for (const steamPath of getSteamPaths()) {
        try { parts.push(`${steamPath}:${(await stat(join(steamPath, 'steamapps', 'libraryfolders.vdf'))).mtimeMs}`); } catch { /* absent */ }
    }
    if (parts.length === 0) return '';
    for (const folder of await findSteamLibraryFolders()) {
        try { parts.push(`${folder}:${(await stat(join(folder, 'steamapps'))).mtimeMs}`); } catch { /* absent */ }
    }
    return parts.join('|');
}

async function buildSteamCache(): Promise<Map<string, string>> {
    const owners = new Map<string, Set<string>>();
    try {
        const libraryFolders = await findSteamLibraryFolders();
        for (const folder of libraryFolders) {
            const steamappsDir = join(folder, 'steamapps');
            let manifests: string[];
            try {
                const allFiles = await readdir(steamappsDir);
                manifests = allFiles.filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));
            } catch { continue; }

            for (const manifest of manifests) {
                try {
                    const text = await readFile(join(steamappsDir, manifest), 'utf-8');
                    const data = parseVDF(text);
                    const appState = data['AppState'] ?? data;
                    const gameName = appState?.name;
                    const installDir = appState?.installdir;
                    if (!gameName || !installDir) continue;
                    // Skip generic tools/proton/steamworks
                    if (gameName.startsWith('Steamworks') || gameName.startsWith('Proton') ||
                        gameName.startsWith('Steam Linux Runtime')) continue;

                    const gameDir = join(steamappsDir, 'common', installDir);
                    if (await fileExists(gameDir)) {
                        await scanDirForExecutables(gameDir, gameName, owners);
                    }
                } catch {}
            }
        }
    } catch {}
    return resolveSteamOwners(owners);
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 3: Curated Game Database (300+ entries)
// ═══════════════════════════════════════════════════════════════════════════
//
// Format: lowercase process name (no .exe) → display name | null (exclude)
//
// null entries = launchers / helpers that should never match as games.

const GAME_DB: Record<string, string | null> = {
    // ── Valve / Steam ──────────────────────────────────────────────────
    'csgo':                             'Counter-Strike: Global Offensive',
    'cs2':                              'Counter-Strike 2',
    'hl2':                              'Half-Life 2',
    'hl':                               'Half-Life',
    'hla':                              'Half-Life: Alyx',
    'dota2':                            'Dota 2',
    'tf2':                              'Team Fortress 2',
    'tf_win64':                         'Team Fortress 2',
    'portal2':                          'Portal 2',
    'portal':                           'Portal',
    'left4dead2':                       'Left 4 Dead 2',
    'left4dead':                        'Left 4 Dead',
    'deadlock':                         'Deadlock',

    // ── Riot Games ─────────────────────────────────────────────────────
    'riotclientservices':               'League of Legends',
    'league of legends':                'League of Legends',
    'leagueclient':                     'League of Legends',
    'valorant-win64-shipping':          'VALORANT',
    'valorant':                         'VALORANT',
    'lor':                              'Legends of Runeterra',
    'bacon':                            'VALORANT',    // internal Riot codename

    // ── Blizzard / Activision ──────────────────────────────────────────
    'overwatch':                        'Overwatch 2',
    'diablo iv':                        'Diablo IV',
    'diablo4':                          'Diablo IV',
    'diablo iii64':                     'Diablo III',
    'diablo iii':                       'Diablo III',
    'wow':                              'World of Warcraft',
    'wowclassic':                       'World of Warcraft Classic',
    'hearthstone':                      'Hearthstone',
    'heroes of the storm':              'Heroes of the Storm',
    'heroesofthestorm_x64':             'Heroes of the Storm',
    'starcraft ii':                     'StarCraft II',
    'sc2_x64':                          'StarCraft II',
    'sc2':                              'StarCraft II',
    'd2r':                              'Diablo II: Resurrected',
    'modernwarfare':                    'Call of Duty: Modern Warfare',
    'cod':                              'Call of Duty',
    'blackopscoldwar':                  'Call of Duty: Black Ops Cold War',
    'codmw2':                           'Call of Duty: Modern Warfare II',

    // ── Epic / Fortnite ────────────────────────────────────────────────
    'fortniteclient-win64-shipping':    'Fortnite',
    'fortnitelauncher':                 'Fortnite',
    'rocketleague':                     'Rocket League',
    'fallguys_client':                  'Fall Guys',
    'fallguys_client_shipping':         'Fall Guys',
    'alanwake2':                        'Alan Wake 2',
    'control_dx12':                     'Control',
    'control_dx11':                     'Control',

    // ── EA / Electronic Arts ───────────────────────────────────────────
    'r5apex':                           'Apex Legends',
    'bf2042':                           'Battlefield 2042',
    'bf1':                              'Battlefield 1',
    'bfv':                              'Battlefield V',
    'bf4':                              'Battlefield 4',
    'bf3':                              'Battlefield 3',
    'starwarsbattlefrontii':            'Star Wars Battlefront II',
    'fifa23':                           'FIFA 23',
    'fifa24':                           'EA Sports FC 24',
    'fc25':                             'EA Sports FC 25',
    'fc24':                             'EA Sports FC 24',
    'madden24':                         'Madden NFL 24',
    'nhl24':                            'NHL 24',
    'ts4_x64':                          'The Sims 4',
    'thesims4':                         'The Sims 4',
    'simcity':                          'SimCity',
    'jedifallenorder':                  'Star Wars Jedi: Fallen Order',
    'jedisurvivor':                     'Star Wars Jedi: Survivor',
    'masseffectlegendaryedition':       'Mass Effect Legendary Edition',
    'masseffect3':                      'Mass Effect 3',
    'masseffect2':                      'Mass Effect 2',
    'masseffect1':                      'Mass Effect',
    'dragonageinquisition':             'Dragon Age: Inquisition',
    'dragonagetheveilguard':            'Dragon Age: The Veilguard',
    'needforspeed':                     'Need for Speed',
    'nfs-unbound':                      'Need for Speed Unbound',
    'nfsunbound':                       'Need for Speed Unbound',
    'nfsheat':                          'Need for Speed Heat',
    'pvzgw2':                           'Plants vs. Zombies: Garden Warfare 2',
    'deadspace':                        'Dead Space',
    'ittak':                            'It Takes Two',

    // ── Ubisoft ────────────────────────────────────────────────────────
    'acvalhalla':                       'Assassin\'s Creed Valhalla',
    'acvalhalla_plus':                  'Assassin\'s Creed Valhalla',
    'acodyssey':                        'Assassin\'s Creed Odyssey',
    'acorigins':                        'Assassin\'s Creed Origins',
    'acmirage':                         'Assassin\'s Creed Mirage',
    'acshadows':                        'Assassin\'s Creed Shadows',
    'rainbowsix':                       'Rainbow Six Siege',
    'r6-siege':                         'Rainbow Six Siege',
    'rainbowsix_vulkan':                'Rainbow Six Siege',
    'thedivision2':                     'Tom Clancy\'s The Division 2',
    'thedivision':                      'Tom Clancy\'s The Division',
    'farcry6':                          'Far Cry 6',
    'farcry5':                          'Far Cry 5',
    'farcry4':                          'Far Cry 4',
    'farcry3':                          'Far Cry 3',
    'watchdogslegion':                  'Watch Dogs: Legion',
    'watchdogs2':                       'Watch Dogs 2',
    'xdefiant':                         'XDefiant',
    'ghostreconbreakpoint':             'Ghost Recon Breakpoint',
    'grw':                              'Ghost Recon Wildlands',
    'starlinkbattle':                   'Starlink: Battle for Atlas',
    'skullnbones':                      'Skull and Bones',

    // ── Rockstar ───────────────────────────────────────────────────────
    'gta5':                             'Grand Theft Auto V',
    'gtav':                             'Grand Theft Auto V',
    'gta4':                             'Grand Theft Auto IV',
    'rdr2':                             'Red Dead Redemption 2',
    'maxpayne3':                        'Max Payne 3',
    'launchermc':                       'Midnight Club: Los Angeles',

    // ── FromSoftware ───────────────────────────────────────────────────
    'eldenring':                        'Elden Ring',
    'darksoulsiii':                     'Dark Souls III',
    'darksoulsii':                      'Dark Souls II',
    'darksouls':                        'Dark Souls: Remastered',
    'sekiro':                           'Sekiro: Shadows Die Twice',
    'armoredcore6':                     'Armored Core VI: Fires of Rubicon',
    'armoredcorevi':                    'Armored Core VI: Fires of Rubicon',

    // ── CD Projekt Red ─────────────────────────────────────────────────
    'cyberpunk2077':                    'Cyberpunk 2077',
    'witcher3':                         'The Witcher 3: Wild Hunt',
    'witcher2':                         'The Witcher 2: Assassins of Kings',
    'witcher':                          'The Witcher',

    // ── Bethesda / id Software ─────────────────────────────────────────
    'skyrimse':                         'The Elder Scrolls V: Skyrim Special Edition',
    'skyrim':                           'The Elder Scrolls V: Skyrim',
    'tesv':                             'The Elder Scrolls V: Skyrim',
    'fallout4':                         'Fallout 4',
    'fallout76':                        'Fallout 76',
    'fallout3':                         'Fallout 3',
    'falloutnv':                        'Fallout: New Vegas',
    'starfield':                        'Starfield',
    'doom':                             'DOOM',
    'doometermal':                      'DOOM Eternal',
    'doom64':                           'DOOM 64',
    'wolfenstein2_thenewcolossus':      'Wolfenstein II: The New Colossus',
    'wolfensteinii':                    'Wolfenstein II: The New Colossus',
    'prey':                             'Prey',
    'deathloop':                        'Deathloop',
    'dishonored2':                      'Dishonored 2',
    'dishonored':                       'Dishonored',
    'eso64':                            'The Elder Scrolls Online',
    'eso':                              'The Elder Scrolls Online',
    'quakechampions':                   'Quake Champions',

    // ── Square Enix ────────────────────────────────────────────────────
    'ffxiv':                            'Final Fantasy XIV',
    'ffxiv_dx11':                       'Final Fantasy XIV',
    'ffxvi-demo':                       'Final Fantasy XVI',
    'ffxvi':                            'Final Fantasy XVI',
    'ffviir':                           'Final Fantasy VII Remake',
    'nier':                             'NieR: Automata',
    'nierautomata':                     'NieR: Automata',
    'nierreplicant':                    'NieR Replicant',
    'kh3':                              'Kingdom Hearts III',
    'kingdomhearts3':                   'Kingdom Hearts III',
    'dragonquest11':                    'Dragon Quest XI',
    'dqxi':                             'Dragon Quest XI',
    'trianglestrategy':                 'Triangle Strategy',
    'octopathtraveler':                 'Octopath Traveler',
    'octopathtraveler2':                'Octopath Traveler II',
    'tombraider':                       'Tomb Raider',
    'rottr':                            'Rise of the Tomb Raider',
    'sottr':                            'Shadow of the Tomb Raider',
    'lifeisstr2':                       'Life is Strange 2',
    'lifeisstrange':                    'Life is Strange',
    'justcause4':                       'Just Cause 4',
    'justcause3':                       'Just Cause 3',
    'marvelguardiansofthegalaxy':       'Marvel\'s Guardians of the Galaxy',
    'marvelavengers':                   'Marvel\'s Avengers',
    'outriders':                        'Outriders',

    // ── Sony / PlayStation PC ──────────────────────────────────────────
    'horizonzerodawn':                  'Horizon Zero Dawn',
    'horizonforbiddenwest':             'Horizon Forbidden West',
    'godofwar':                         'God of War',
    'gow':                              'God of War',
    'godofwarragnarok':                 'God of War Ragnarök',
    'spiderman':                        'Marvel\'s Spider-Man',
    'spidermanmilesmorales':            'Marvel\'s Spider-Man: Miles Morales',
    'spiderman2':                       'Marvel\'s Spider-Man 2',
    'uncharted4':                       'Uncharted 4',
    'uncharted':                        'Uncharted: Legacy of Thieves',
    'thelastofus':                      'The Last of Us Part I',
    'tlou':                             'The Last of Us Part I',
    'daysbone':                         'Days Gone',
    'daysgone':                         'Days Gone',
    'returnal':                         'Returnal',
    'sackboy':                          'Sackboy: A Big Adventure',
    'ratchetandclank':                  'Ratchet & Clank: Rift Apart',
    'ghostoftsushima':                  'Ghost of Tsushima',

    // ── Microsoft / Xbox ───────────────────────────────────────────────
    'halo infinite':                    'Halo Infinite',
    'haloinfinite':                     'Halo Infinite',
    'mcc-win64-shipping':               'Halo: The Master Chief Collection',
    'forzahorizon5':                    'Forza Horizon 5',
    'forzahorizon4':                    'Forza Horizon 4',
    'forza_motorsport':                 'Forza Motorsport',
    'forzamotorsport':                  'Forza Motorsport',
    'msfs':                             'Microsoft Flight Simulator',
    'flightsimulator':                  'Microsoft Flight Simulator',
    'ageofempires2de':                  'Age of Empires II: Definitive Edition',
    'aoe2de_s':                         'Age of Empires II: Definitive Edition',
    'ageofempires4':                    'Age of Empires IV',
    'grounded':                         'Grounded',
    'seaofthieves':                     'Sea of Thieves',
    'ori':                              'Ori and the Will of the Wisps',
    'psychonauts2':                     'Psychonauts 2',
    'stateofdeckay2':                   'State of Decay 2',
    'gears5':                           'Gears 5',
    'gearsofwar4':                      'Gears of War 4',
    'crackdown3':                       'Crackdown 3',

    // ── Indie / Popular ────────────────────────────────────────────────
    'stardewvalley':                    'Stardew Valley',
    'stardew valley':                   'Stardew Valley',
    'terraria':                         'Terraria',
    'factorio':                         'Factorio',
    'rimworld':                         'RimWorld',
    'rimworldwin':                      'RimWorld',
    'valheim':                          'Valheim',
    'satisfactory':                     'Satisfactory',
    'satisfactoryearlylaccess':         'Satisfactory',
    'hades':                            'Hades',
    'hades2':                           'Hades II',
    'hadesii':                          'Hades II',
    'celeste':                          'Celeste',
    'hollowknight':                     'Hollow Knight',
    'silksong':                         'Hollow Knight: Silksong',
    'lethal company':                   'Lethal Company',
    'lethalcompany':                    'Lethal Company',
    'palworld':                         'Palworld',
    'palworld-win64-shipping':          'Palworld',
    'bg3':                              'Baldur\'s Gate 3',
    'bg3_dx11':                         'Baldur\'s Gate 3',
    'baldursgate3':                     'Baldur\'s Gate 3',
    'helldivers2':                      'Helldivers 2',
    'amongus':                          'Among Us',
    'among us':                         'Among Us',
    'cuphead':                          'Cuphead',
    'ori and the blind forest':         'Ori and the Blind Forest',
    'undertale':                        'Undertale',
    'deltarune':                        'Deltarune',
    'shovelknight':                     'Shovel Knight',
    'enterthegungeon':                  'Enter the Gungeon',
    'deadcells':                        'Dead Cells',
    'slayethespire':                    'Slay the Spire',
    'slayethespire2':                   'Slay the Spire 2',
    'inscryption':                      'Inscryption',
    'returnoftheobradinn':              'Return of the Obra Dinn',
    'outerwilds':                       'Outer Wilds',
    'brotato':                          'Brotato',
    'balatro':                          'Balatro',
    'vampiresurvivors':                 'Vampire Survivors',
    'davethedriver':                    'Dave the Diver',
    'dave the diver':                   'Dave the Diver',
    'plagtalerequiem':                  'A Plague Tale: Requiem',
    'plagtaleinnocence':                'A Plague Tale: Innocence',
    'tunic':                            'TUNIC',
    'sifu':                             'Sifu',
    'furi':                             'Furi',
    'hotlinemiami':                     'Hotline Miami',
    'hotlinemiami2':                    'Hotline Miami 2',
    'katanazero':                       'Katana ZERO',
    'ultrakill':                        'ULTRAKILL',
    'duskgame':                         'DUSK',
    'unpacking':                        'Unpacking',
    'spiritfarer':                      'Spiritfarer',
    'crosscode':                        'CrossCode',
    'eastward':                         'Eastward',
    'disco elysium':                    'Disco Elysium',
    'discoelysium':                     'Disco Elysium',
    'pillarsofeternity':                'Pillars of Eternity',
    'pillarsofeternity2':               'Pillars of Eternity II',
    'divinity_original_sin_2':          'Divinity: Original Sin 2',
    'divinity2':                        'Divinity: Original Sin 2',
    'pathfinder_wrathoftherighteous':   'Pathfinder: Wrath of the Righteous',
    'pathfinderwotr':                   'Pathfinder: Wrath of the Righteous',
    'warhammer3':                       'Total War: Warhammer III',
    'warhammer2':                       'Total War: Warhammer II',
    'vermintide2':                      'Warhammer: Vermintide 2',
    'darktide':                         'Warhammer 40,000: Darktide',
    'spacemarine2':                     'Warhammer 40,000: Space Marine 2',
    'content warning':                  'Content Warning',
    'contentwarning':                   'Content Warning',

    // ── Battle Royale ──────────────────────────────────────────────────
    'pubg':                             'PUBG: Battlegrounds',
    'tslgame':                          'PUBG: Battlegrounds',
    'cod-warzone':                      'Call of Duty: Warzone',
    'hunt':                             'Hunt: Showdown',
    'thefinals':                        'THE FINALS',
    'thefinals-win64-shipping':         'THE FINALS',
    'superpeople':                      'Super People',
    'naraka':                           'Naraka: Bladepoint',
    'narakabladepoint':                 'Naraka: Bladepoint',

    // ── MMO / Online RPG ───────────────────────────────────────────────
    'guildwars2-64':                    'Guild Wars 2',
    'gw2-64':                           'Guild Wars 2',
    'guildwars2':                       'Guild Wars 2',
    'newworld':                         'New World',
    'newworld_shipping':                'New World',
    'lostark':                          'Lost Ark',
    'lost-ark':                         'Lost Ark',
    'runescape':                        'RuneScape',
    'osrsbot':                          'Old School RuneScape',
    'rs2client':                        'RuneScape',
    'pathofexile':                      'Path of Exile',
    'pathofexile_x64':                  'Path of Exile',
    'pathofexile_x64steam':             'Path of Exile',
    'pathofexile2':                     'Path of Exile 2',
    'warframe.x64':                     'Warframe',
    'warframe':                         'Warframe',
    'albion-online':                    'Albion Online',
    'albion':                           'Albion Online',
    'blackdesert64':                    'Black Desert Online',
    'bdo':                              'Black Desert Online',
    'maplestory':                       'MapleStory',
    'swtor':                            'Star Wars: The Old Republic',

    // ── Survival / Sandbox ─────────────────────────────────────────────
    'rustclient':                       'Rust',
    'rust':                             'Rust',
    'shootergame':                      'ARK: Survival Evolved',
    'arksurvivalevolved':               'ARK: Survival Evolved',
    'ark':                              'ARK: Survival Ascended',
    'dayz':                             'DayZ',
    'dayzserver':                       null,
    '7daystodie':                       '7 Days to Die',
    'subnautica':                       'Subnautica',
    'subnauticazero':                   'Subnautica: Below Zero',
    'nms':                              'No Man\'s Sky',
    'nomanssky':                        'No Man\'s Sky',
    'theforest':                        'The Forest',
    'sonsoftheforest':                  'Sons of the Forest',
    'sonsoftheforestclient':            'Sons of the Forest',
    'raft':                             'Raft',
    'projectzombiod':                   'Project Zomboid',
    'projectzomboid64':                 'Project Zomboid',
    'conanexiles':                      'Conan Exiles',
    'conansandbox':                     'Conan Exiles',
    'v rising':                         'V Rising',
    'vrising':                          'V Rising',
    'corekeeper':                       'Core Keeper',
    'astroneer':                        'Astroneer',
    'graveyard keeper':                 'Graveyard Keeper',
    'dontstarve':                       'Don\'t Starve Together',

    // ── Strategy / Management ──────────────────────────────────────────
    'civ6':                             'Civilization VI',
    'civilizationvi':                   'Civilization VI',
    'civilizationvi_dx12':              'Civilization VI',
    'civ5':                             'Civilization V',
    'crusaderkings3':                   'Crusader Kings III',
    'ck3':                              'Crusader Kings III',
    'eu4':                              'Europa Universalis IV',
    'hoi4':                             'Hearts of Iron IV',
    'stellaris':                        'Stellaris',
    'victoria3':                        'Victoria 3',
    'cityskylines2':                    'Cities: Skylines II',
    'cities':                           'Cities: Skylines',
    'citiesskylines':                   'Cities: Skylines',
    'totalwar_troy':                    'Total War: Troy',
    'rome2':                            'Total War: Rome II',
    'xcom2':                            'XCOM 2',
    'xcom':                             'XCOM: Enemy Unknown',
    'anno1800':                         'Anno 1800',
    'frostpunk2':                       'Frostpunk 2',
    'frostpunk':                        'Frostpunk',
    'manor lords':                      'Manor Lords',
    'manorlords':                       'Manor Lords',
    'planetcoaster2':                   'Planet Coaster 2',
    'planetcoaster':                    'Planet Coaster',
    'planetzoo':                        'Planet Zoo',
    'twopointhospital':                 'Two Point Hospital',
    'twopointcampus':                   'Two Point Campus',
    'kerbalspaceprogram':               'Kerbal Space Program',
    'ksp2':                             'Kerbal Space Program 2',
    'dysonspherergram':                 'Dyson Sphere Program',
    'oxygen not included':              'Oxygen Not Included',
    'oxygennotincluded':                'Oxygen Not Included',

    // ── Racing / Sports ────────────────────────────────────────────────
    'assettocorsa':                     'Assetto Corsa',
    'assettocorsacompetizione':         'Assetto Corsa Competizione',
    'iracing':                          'iRacing',
    'iracing.exe':                      'iRacing',
    'beamng':                           'BeamNG.drive',
    'eurotrucks2':                      'Euro Truck Simulator 2',
    'amtrucks':                         'American Truck Simulator',
    'f1_23':                            'F1 23',
    'f1_24':                            'F1 24',
    'dirtally2':                        'DiRT Rally 2.0',
    'wrc':                              'WRC',
    'trackmania':                       'Trackmania',

    // ── Horror ─────────────────────────────────────────────────────────
    'phasmophobia':                     'Phasmophobia',
    'devour':                           'DEVOUR',
    'outlast':                          'Outlast',
    'outlast2':                         'Outlast 2',
    'amnesia_tdd':                      'Amnesia: The Dark Descent',
    'residentevil8':                    'Resident Evil Village',
    'revillagemo':                      'Resident Evil Village',
    're4':                              'Resident Evil 4',
    'residentevil4':                    'Resident Evil 4',
    're2':                              'Resident Evil 2',
    'residentevil2':                    'Resident Evil 2',
    're3':                              'Resident Evil 3',
    'silenthill2':                      'Silent Hill 2',
    'alanwake':                         'Alan Wake',
    'themedium':                        'The Medium',

    // ── Fighting / Action ──────────────────────────────────────────────
    'streetfighter6':                   'Street Fighter 6',
    'sf6':                              'Street Fighter 6',
    'tekken8':                          'Tekken 8',
    'tekken7':                          'Tekken 7',
    'mortalkombat1':                    'Mortal Kombat 1',
    'mk11':                             'Mortal Kombat 11',
    'guilty gear strive':               'Guilty Gear -Strive-',
    'ggst':                             'Guilty Gear -Strive-',
    'dragonballfighterz':               'Dragon Ball FighterZ',
    'dbfz':                             'Dragon Ball FighterZ',
    'dragonballsparkingzero':           'Dragon Ball: Sparking! ZERO',
    'granblue fantasy versus':          'Granblue Fantasy Versus',
    'devilmaycry5':                     'Devil May Cry 5',
    'dmc5':                             'Devil May Cry 5',
    'monsterhunterworld':               'Monster Hunter: World',
    'monsterhunterrise':                'Monster Hunter Rise',
    'monsterhunterwilds':               'Monster Hunter Wilds',

    // ── Multiplayer / Co-op ────────────────────────────────────────────
    'starcitizen':                      'Star Citizen',
    'squadgame':                        'Squad',
    'squad':                            'Squad',
    'escape from tarkov':               'Escape from Tarkov',
    'tarkov':                           'Escape from Tarkov',
    'eft':                              'Escape from Tarkov',
    'destiny2':                         'Destiny 2',
    'readyornot':                       'Ready or Not',
    'insurgency':                       'Insurgency: Sandstorm',
    'insurgencysandstorm':              'Insurgency: Sandstorm',
    'arma3':                            'Arma 3',
    'arma3_x64':                        'Arma 3',
    'armareforger':                     'Arma Reforger',
    'hellletloose':                     'Hell Let Loose',
    'deeprockgalactic':                 'Deep Rock Galactic',
    'pso2':                             'Phantasy Star Online 2',
    'gtfo':                             'GTFO',
    'payday3':                          'Payday 3',
    'payday2':                          'Payday 2',
    'riskofrain2':                      'Risk of Rain 2',
    'remnant2':                         'Remnant II',
    'remnant':                          'Remnant: From the Ashes',

    // ── Minecraft variants ─────────────────────────────────────────────
    'minecraft.windows':                'Minecraft',
    // Note: Java Edition detected via isMinecraftJavaRunning() below

    // ── VR Games ───────────────────────────────────────────────────────
    'vrchat':                           'VRChat',
    'beatsaber':                        'Beat Saber',
    'boneworks':                        'Boneworks',
    'bonelab':                          'Bonelab',
    'pavlov':                           'Pavlov VR',
    'bladeand sorcery':                 'Blade & Sorcery',
    'phasmophobiavr':                   'Phasmophobia VR',

    // ── Emulators ──────────────────────────────────────────────────────
    'retroarch':                        'RetroArch',
    'dolphin':                          'Dolphin Emulator',
    'yuzu':                             'Yuzu',
    'ryujinx':                          'Ryujinx',
    'pcsx2':                            'PCSX2',
    'pcsx2-qt':                         'PCSX2',
    'rpcs3':                            'RPCS3',
    'cemu':                             'Cemu',
    'citra':                            'Citra',
    'citra-qt':                         'Citra',
    'desmume':                          'DeSmuME',
    'mgba':                             'mGBA',
    'ppsspp':                           'PPSSPP',
    'ppssppsdl':                        'PPSSPP',
    'xemu':                             'xemu',
    'mame':                             'MAME',
    'zsnes':                            'ZSNES',
    'snes9x':                           'Snes9x',

    // ── Roblox ─────────────────────────────────────────────────────────
    'robloxplayerbeta':                 'Roblox',
    'robloxplayer':                     'Roblox',

    // ── Additional Popular Games ───────────────────────────────────────
    'genshinimpact':                    'Genshin Impact',
    'genshin impact':                   'Genshin Impact',
    'yuanshen':                         'Genshin Impact',
    'starrailbase':                     'Honkai: Star Rail',
    'starraildirect':                   'Honkai: Star Rail',
    'honkaistarrail':                   'Honkai: Star Rail',
    'zenlesszonezero':                  'Zenless Zone Zero',
    'wutheringwaves':                   'Wuthering Waves',
    'toweroffantasy':                   'Tower of Fantasy',
    'bluearchive':                      'Blue Archive',
    'arknights':                        'Arknights',
    'persona5royal':                    'Persona 5 Royal',
    'persona4golden':                   'Persona 4 Golden',
    'persona3reload':                   'Persona 3 Reload',
    'atelier':                          'Atelier Series',
    'metaphor':                         'Metaphor: ReFantazio',

    // ── Puzzle / Casual ────────────────────────────────────────────────
    'thewitness':                       'The Witness',
    'return to monkey island':          'Return to Monkey Island',
    'tetriseffect':                     'Tetris Effect',
    'worldofgoo':                       'World of Goo',
    'baba is you':                      'Baba Is You',
    'babaisyou':                        'Baba Is You',
    'thetalossprinciple2':              'The Talos Principle 2',
    'talos2':                           'The Talos Principle 2',

    // ── Card / Board Games ─────────────────────────────────────────────
    'mtga':                             'Magic: The Gathering Arena',
    'mtgarena':                         'Magic: The Gathering Arena',
    'tabletopsimulator':                'Tabletop Simulator',

    // ── Launchers / Helpers (explicitly excluded) ──────────────────────
    // Consulted BEFORE the Steam-folder layer in detectCurrentGame: a
    // curated "never a game" beats a folder-scan guess.
    'msedgewebview2':                   null,  // WebView2 runtime — Widgets/Office/Teams, and bundled by games
    'msedge':                           null,
    'cefsharp.browsersubprocess':       null,
    'unrealcefsubprocess':              null,
    'steam':                            null,
    'steamwebhelper':                   null,
    'steamerrorreporter':               null,
    'steamservice':                     null,
    'epicgameslauncher':                null,
    'epicwebhelper':                    null,
    'eadesktop':                        null,
    'eaapp':                            null,
    'eabackgroundservice':              null,
    'battle.net':                       null,
    'agent':                            null,  // Blizzard Agent
    'riotclientux':                     null,
    'riotclientcrashhandler':           null,
    'gog galaxy':                       null,
    'galaxyclient':                     null,
    'upc':                              null,
    'ubisoft connect':                  null,
    'ubisoftconnect':                   null,
    'ubisoftgamelauncher':              null,
    'xboxapp':                          null,
    'gamebar':                          null,
    'gamebarpresencewriter':            null,
    'gamingservices':                    null,
    'nvidia share':                     null,
    'nvcontainer':                      null,
    'geforceexperience':                null,
    'discord':                          null,
    'msiafterburner':                   null,
    'rivatunerstatisticsserver':        null,
    'overwolf':                         null,
    'playnite':                         null,
    'playnitedesktop':                  null,
    'steamvr':                          null,
    'vrserver':                         null,
    'vrmonitor':                        null,
    'vrcompositor':                     null,
    'oculusclient':                     null,
    'oculusdash':                       null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Process scanning
// ═══════════════════════════════════════════════════════════════════════════

// Child processes are started with execFile — never through a shell — and
// hidden. `exec` wrapped every poll in `cmd.exe /d /s /c` on Windows (a second
// process per poll) and, on Linux, in a shell loop that forked head/tr/basename
// once per running process (hundreds of forks of a large Electron process per
// poll; measured as 0.27–0.48 s main-process stalls labelled game:detect).
const CHILD_OPTS = { timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 } as const;

/** Parse `tasklist /FO CSV /NH` output into lowercase names without `.exe`. */
export function parseTasklistCsv(stdout: string): string[] {
    return stdout.split('\n')
        .map(line => {
            const first = line.split(',')[0];
            if (!first) return '';
            return first.replace(/"/g, '').trim().toLowerCase().replace(/\.exe$/, '');
        })
        .filter(Boolean);
}

/** argv[0]'s basename from a /proc/<pid>/cmdline blob (NUL-separated). */
export function procCmdlineName(cmdline: string): string {
    const argv0 = cmdline.split('\0')[0]?.trim() ?? '';
    if (!argv0) return '';
    return basename(argv0).toLowerCase();
}

async function linuxProcessNames(): Promise<string[]> {
    // P2-ELEC-14: /proc/*/comm truncates to 15 chars; read argv[0] from
    // cmdline instead and extract the basename so longer names match. Read
    // directly — no child processes at all.
    //
    // Synchronous reads in small chunks, yielding between them, on purpose:
    // procfs is generated from kernel memory (no disk), so a 512-byte read is
    // a few microseconds. Measured on the dev box with ~400 processes: one
    // async readFile per pid = 190–260 ms wall and up to 74 ms loop stalls
    // (thousands of thread-pool round trips landing on the main thread);
    // sync in chunks of 64 = 18–33 ms wall, worst chunk ≤ 6 ms.
    const pids = (await readdir('/proc')).filter(n => /^\d+$/.test(n));
    const buf = Buffer.alloc(512);
    const names: string[] = [];
    for (let i = 0; i < pids.length; i += 64) {
        for (const pid of pids.slice(i, i + 64)) {
            try {
                const fd = openSync(`/proc/${pid}/cmdline`, 'r');
                try {
                    const n = readSync(fd, buf, 0, buf.length, 0);
                    const name = procCmdlineName(buf.toString('utf8', 0, n));
                    if (name) names.push(name);
                } finally { closeSync(fd); }
            } catch { /* process exited meanwhile */ }
        }
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    return names;
}

async function getRunningProcessNames(): Promise<string[]> {
    try {
        if (process.platform === 'win32') {
            const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], CHILD_OPTS);
            return parseTasklistCsv(stdout);
        } else if (process.platform === 'darwin') {
            const { stdout } = await execFileAsync('ps', ['-eo', 'comm='], CHILD_OPTS);
            return stdout.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
        } else {
            return await linuxProcessNames();
        }
    } catch {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Minecraft Java Edition — command-line class inspection
// ═══════════════════════════════════════════════════════════════════════════

const MC_RUNNING_PATTERNS = [
    'net.minecraft.client.main.Main',
    'net.minecraft.launchwrapper.Launch',
    'net.fabricmc.loader',
    'cpw.mods.bootstraplauncher',
    'org.quiltmc',
];

/**
 * Only a Java process can be Minecraft Java Edition, and the process list is
 * already in hand — so the expensive command-line inspection below runs only
 * when one exists. It used to run on EVERY poll in which no other game
 * matched (i.e. nearly every poll), which on Windows meant starting
 * PowerShell + a WMI query every 10 seconds, all day: roughly half a second
 * of CPU and ~60 MB of transient memory per poll, system-wide.
 */
export function mayBeMinecraftJava(procs: readonly string[]): boolean {
    // macOS `ps -eo comm=` reports a full path (…/bin/java).
    return procs.some(p => p === 'java' || p === 'javaw' || p.endsWith('/java'));
}

async function isMinecraftJavaRunning(): Promise<boolean> {
    try {
        let cmdlines: string;
        if (process.platform === 'win32') {
            // P2-ELEC-14: wmic was removed from Windows 11 24H2+; use PowerShell
            // Get-CimInstance which is the supported replacement on all Win11+ builds.
            const { stdout } = await execFileAsync('powershell', [
                '-NoProfile', '-NonInteractive', '-Command',
                'Get-CimInstance Win32_Process | Where-Object Name -eq javaw.exe | Select-Object -ExpandProperty CommandLine',
            ], { ...CHILD_OPTS, timeout: 10000 });
            cmdlines = stdout;
        } else {
            const { stdout } = await execFileAsync('ps', ['-eo', 'args='], CHILD_OPTS);
            cmdlines = stdout;
        }
        return MC_RUNNING_PATTERNS.some(pattern => cmdlines.includes(pattern));
    } catch {
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main detection — 3-layer priority stack
// ═══════════════════════════════════════════════════════════════════════════

export interface DetectedGame {
    name: string;
    /** The matched executable name — what settings' ignore list operates on.
     *  For the Minecraft command-line heuristic (no single matched exe) this
     *  is the sentinel 'java', so ignoring it behaves like ignoring any other
     *  process: consistent, if a little broad (would also skip other
     *  Java-based games) — an acceptable tradeoff given there's no more
     *  specific exe to point at. */
    processName: string;
}

/**
 * Windows: is every thread of every process with this name suspended?
 *
 * UWP / Game Pass titles (Forza Horizon 5 is the canonical report) are NOT
 * closed when the user quits them — Windows freezes the process, and it sits
 * in the task list indefinitely, indistinguishable from a running game in
 * `tasklist` output. Task Manager shows these as "Suspended": every thread is
 * in the Wait state with WaitReason Suspended. Reporting one as "playing" is
 * the "it says I'm playing Forza when I'm not" bug.
 *
 * Only invoked AFTER a name matched a game (at most one PS spawn per poll,
 * and zero when no game-like process exists) — never for the full process
 * list. Fails open (not suspended) on any error: a detection heuristic must
 * degrade to the old behavior, not start hiding genuinely running games.
 */
async function isProcessSuspendedWin32(procName: string): Promise<boolean> {
    // Names come from our own DB keys / tasklist basenames (lowercase, no
    // path); strip anything shell-hostile anyway before interpolating.
    const safe = procName.replace(/[^a-z0-9 ._-]/gi, '');
    if (!safe) return false;
    // Cached per name: while a game keeps running, every 10 s poll used to
    // start PowerShell again just to re-confirm it. A verdict is reused for
    // SUSPENDED_CHECK_TTL_MS; detection of "quit to suspended" is delayed by
    // at most that long, the same order as the poll itself when idle.
    const cached = suspendedVerdicts.get(safe);
    const now = Date.now();
    if (cached && now - cached.at < SUSPENDED_CHECK_TTL_MS) return cached.suspended;
    try {
        const { stdout } = await execFileAsync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `$ps = Get-Process -Name '${safe}' -ErrorAction SilentlyContinue;` +
            ' if (-not $ps) { \'GONE\'; exit }' +
            ' foreach ($p in $ps) { foreach ($t in $p.Threads) {' +
            ' if (-not ($t.ThreadState -eq \'Wait\' -and $t.WaitReason -eq \'Suspended\')) { \'ACTIVE\'; exit }' +
            ' } }' +
            ' \'SUSPENDED\'',
        ], CHILD_OPTS);
        const suspended = stdout.trim() === 'SUSPENDED';
        suspendedVerdicts.set(safe, { at: now, suspended });
        if (suspendedVerdicts.size > 64) suspendedVerdicts.delete(suspendedVerdicts.keys().next().value as string);
        return suspended;
    } catch {
        return false; // fail open
    }
}

const SUSPENDED_CHECK_TTL_MS = 60_000;
const suspendedVerdicts = new Map<string, { at: number; suspended: boolean }>();

let inFlight: Promise<DetectedGame | null> | null = null;
let lastResult: { at: number; game: DetectedGame | null } | null = null;

/**
 * Scan for a running game. Concurrent callers share one scan (the poller and
 * an on-demand `game:get-current` used to run two full scans side by side).
 */
export function detectCurrentGame(): Promise<DetectedGame | null> {
    if (inFlight) return inFlight;
    inFlight = detectCurrentGameOnce()
        .then((game) => { lastResult = { at: Date.now(), game }; return game; })
        .finally(() => { inFlight = null; });
    return inFlight;
}

/**
 * The most recent scan's answer if it is at most `maxAgeMs` old, else a fresh
 * scan. For on-demand callers (the screen-share picker, the renderer's mount
 * query) — the poller has almost always just answered the same question.
 */
export function getCurrentGameCached(maxAgeMs: number): Promise<DetectedGame | null> {
    if (lastResult && Date.now() - lastResult.at <= maxAgeMs) return Promise.resolve(lastResult.game);
    return detectCurrentGame();
}

/** Test hook. */
export function __resetGameDetectorForTests(): void {
    inFlight = null;
    lastResult = null;
    steamCache = new Map();
    steamCacheTime = 0;
    steamDirStamp = '';
    suspendedVerdicts.clear();
}

async function detectCurrentGameOnce(): Promise<DetectedGame | null> {
    const procs = await getRunningProcessNames();

    // Refresh Steam cache if stale — but only re-walk the libraries when they
    // actually changed (a game installed or removed rewrites the steamapps
    // directory). The full walk is two readdir levels into every installed
    // game, every 5 minutes, forever; now it runs on change, or hourly.
    if (Date.now() - steamCacheTime > STEAM_CACHE_TTL) {
        try {
            const stamp = await steamLibraryStamp();
            if (stamp !== steamDirStamp || Date.now() - steamCacheBuiltAt > STEAM_CACHE_MAX_AGE) {
                steamCache = await buildSteamCache();
                steamDirStamp = stamp;
                steamCacheBuiltAt = Date.now();
            }
        } catch {
            steamCache = new Map();
        }
        steamCacheTime = Date.now();
    }

    // A matched candidate must also be genuinely running — a suspended UWP
    // ghost (see isProcessSuspendedWin32) keeps scanning instead of matching.
    const liveMatch = async (name: string, proc: string): Promise<DetectedGame | null> => {
        if (process.platform === 'win32' && await isProcessSuspendedWin32(proc)) return null;
        return { name, processName: proc };
    };

    for (const proc of procs) {
        if (ignoredProcesses.has(proc)) continue;

        // Layer 1: User custom games (highest priority)
        if (customGames.has(proc)) {
            const m = await liveMatch(customGames.get(proc)!, proc);
            if (m) return m;
            continue;
        }

        // Curated exclusions outrank the Steam-folder heuristic: a shared
        // runtime sitting in a game's install dir must never be that game.
        if (Object.prototype.hasOwnProperty.call(GAME_DB, proc) && GAME_DB[proc] === null) continue;

        // Layer 2: Steam library
        if (steamCache.has(proc)) {
            const m = await liveMatch(steamCache.get(proc)!, proc);
            if (m) return m;
            continue;
        }

        // Layer 3: Curated database
        if (Object.prototype.hasOwnProperty.call(GAME_DB, proc)) {
            const name = GAME_DB[proc];
            if (name !== null && name !== undefined) {
                const m = await liveMatch(name, proc);
                if (m) return m;
            }
        }
    }

    // Java games need command-line inspection — previously ungated by
    // ignoredProcesses (the loop above only covers the 3 layered lookups),
    // so "ignoring" Minecraft silently did nothing. Gated on the same 'java'
    // sentinel this now reports as processName.
    if (!ignoredProcesses.has('java') && mayBeMinecraftJava(procs) && await isMinecraftJavaRunning()) {
        return { name: 'Minecraft', processName: 'java' };
    }
    return null;
}

/** Returns deduplicated sorted list of running process names (for settings UI). */
export async function getRunningProcessList(): Promise<string[]> {
    return [...new Set(await getRunningProcessNames())].sort();
}
