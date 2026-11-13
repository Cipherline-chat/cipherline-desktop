/**
 * What the app knows about a game from its NAME alone - for the profile's
 * "Playing ..." row, on the VIEWER's device (a friend's presence carries only
 * the game's display name; their executable, its icon and their launcher never
 * leave their computer).
 *
 * A small, bundled, text-only table. It contains no artwork, no image URLs and
 * no network lookups:
 *  - `steamAppId` is the one number needed to ask OUR art proxy for the game's
 *    Steam store picture (GET /v1/integrations/art?ref=steam:<id>:...: the
 *    viewer never talks to Steam, exactly as the Steam showcase already works).
 *    Only titles that are sold on Steam have one.
 *  - `only` names the single store a title is sold through, and only when that
 *    is true (Valve's own games). It is what lets a friend's row say
 *    "on Steam" honestly. A multi-platform title (Elden Ring, GTA V) gets no
 *    "on <store>" because the name does not say where THEY own it.
 *  - `site` is the publisher's own page, used only for titles that have no
 *    Steam page to point at. The link is labelled as a website, never as a
 *    store.
 *  - `glyph` picks a plain, original drawing for a title with no usable
 *    picture. These are generic shapes, not any publisher's artwork.
 *
 * Which pictures are fine to show is a licensing decision recorded per entry
 * in docs/releases/NEXT.md; nothing here ships a publisher's art.
 */

export type StoreId = 'steam' | 'epic' | 'riot' | 'battlenet' | 'xbox' | 'ea' | 'ubisoft' | 'gog';

/** "on Steam", "on Epic Games", ... - the store's own name, as people say it. */
export const STORE_LABEL: Readonly<Record<StoreId, string>> = {
    steam: 'Steam',
    epic: 'Epic Games',
    riot: 'Riot Games',
    battlenet: 'Battle.net',
    xbox: 'Xbox',
    ea: 'EA app',
    ubisoft: 'Ubisoft Connect',
    gog: 'GOG',
};

export const STORE_IDS: readonly StoreId[] = Object.keys(STORE_LABEL) as StoreId[];
export const isStoreId = (v: unknown): v is StoreId => typeof v === 'string' && (STORE_IDS as readonly string[]).includes(v);

export type GameGlyph = 'block';

export interface KnownGame {
    /** Display name drawn in the row's tooltip; lookups use `names` too. */
    name: string;
    /** Other spellings the detector or Steam uses for the same title. */
    names?: readonly string[];
    steamAppId?: number;
    only?: StoreId;
    site?: string;
    glyph?: GameGlyph;
}

const g = (name: string, o: Omit<KnownGame, 'name'> = {}): KnownGame => ({ name, ...o });

/**
 * Well-known games. Names are what the detector (electron/game-detector.ts) or
 * Steam's own library calls them; `normGameName` makes the match forgiving
 * about case, punctuation, (R)/(TM) marks. Every Steam id below was checked
 * against Steam's public store listing for that title.
 */
export const KNOWN_GAMES: readonly KnownGame[] = [
    // Valve: sold on Steam only.
    g('Counter-Strike 2', { steamAppId: 730, only: 'steam' }),
    g('Dota 2', { steamAppId: 570, only: 'steam' }),
    g('Team Fortress 2', { steamAppId: 440, only: 'steam' }),
    g('Left 4 Dead 2', { steamAppId: 550, only: 'steam' }),
    g('Deadlock', { steamAppId: 1422450, only: 'steam' }),
    g("Garry's Mod", { steamAppId: 4000, only: 'steam' }),
    // On Steam (and elsewhere).
    g('BeamNG.drive', { steamAppId: 284160 }),
    g('Euro Truck Simulator 2', { steamAppId: 227300 }),
    g('Apex Legends', { steamAppId: 1172470 }),
    g('PUBG: Battlegrounds', { steamAppId: 578080 }),
    g('Rust', { steamAppId: 252490 }),
    g('Grand Theft Auto V', { steamAppId: 271590, names: ['Grand Theft Auto V Legacy', 'Grand Theft Auto V Enhanced'] }),
    g('Red Dead Redemption 2', { steamAppId: 1174180 }),
    g('Elden Ring', { steamAppId: 1245620 }),
    g("Baldur's Gate 3", { steamAppId: 1086940 }),
    g('Cyberpunk 2077', { steamAppId: 1091500 }),
    g('The Witcher 3: Wild Hunt', { steamAppId: 292030, names: ['The Witcher 3: Wild Hunt - Remastered'] }),
    g('Terraria', { steamAppId: 105600 }),
    g('Stardew Valley', { steamAppId: 413150 }),
    g('Helldivers 2', { steamAppId: 553850 }),
    g('Palworld', { steamAppId: 1623730 }),
    g('Lethal Company', { steamAppId: 1966720 }),
    g('Warframe', { steamAppId: 230410 }),
    g('Destiny 2', { steamAppId: 1085660 }),
    g('Marvel Rivals', { steamAppId: 2767030 }),
    g('Valheim', { steamAppId: 892970 }),
    g('Hades', { steamAppId: 1145360 }),
    g('Hollow Knight', { steamAppId: 367520 }),
    g('Among Us', { steamAppId: 945360 }),
    g('Fall Guys', { steamAppId: 1097150 }),
    g('Phasmophobia', { steamAppId: 739630 }),
    g('Schedule I', { steamAppId: 3164500 }),
    g('Black Myth: Wukong', { steamAppId: 2358720 }),
    g('Monster Hunter Wilds', { steamAppId: 2246340 }),
    g('Hogwarts Legacy', { steamAppId: 990080 }),
    g('Sea of Thieves', { steamAppId: 1172620 }),
    g('Call of Duty', { steamAppId: 1938090, names: ['Call of Duty: Warzone'] }),
    g('Overwatch 2', { steamAppId: 2357570, names: ['Overwatch'] }),
    g('Dead by Daylight', { steamAppId: 381210 }),
    g('Rainbow Six Siege', { steamAppId: 359550, names: ["Tom Clancy's Rainbow Six Siege"] }),
    g('Satisfactory', { steamAppId: 526870 }),
    g('RimWorld', { steamAppId: 294100 }),
    g('Factorio', { steamAppId: 427520 }),
    g('Project Zomboid', { steamAppId: 108600 }),
    g('Deep Rock Galactic', { steamAppId: 548430 }),
    g('THE FINALS', { steamAppId: 2073850 }),
    // Not on Steam: no store picture to ask for. A website (the publisher's
    // own page) and a plain drawing where there is nothing else.
    g('Minecraft', { site: 'https://www.minecraft.net/', glyph: 'block' }),
    g('VALORANT', { only: 'riot', site: 'https://playvalorant.com/' }),
    g('League of Legends', { only: 'riot', site: 'https://www.leagueoflegends.com/' }),
    g('Fortnite', { only: 'epic', site: 'https://www.fortnite.com/' }),
    g('Rocket League', { site: 'https://www.rocketleague.com/' }),
    g('World of Warcraft', { only: 'battlenet', site: 'https://worldofwarcraft.blizzard.com/' }),
    g('Hearthstone', { only: 'battlenet', site: 'https://hearthstone.blizzard.com/' }),
];

/** Lowercase, drop (R)/(TM)/(C), turn every other run of punctuation into one space. */
export function normGameName(raw: string): string {
    // Marks first: NFKD would otherwise spell the trademark sign out as the letters "TM".
    return raw
        .replace(/[\u2122\u00ae\u00a9]/g, '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/['\u2019]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

const INDEX: ReadonlyMap<string, KnownGame> = (() => {
    const m = new Map<string, KnownGame>();
    for (const k of KNOWN_GAMES) {
        for (const n of [k.name, ...(k.names ?? [])]) {
            const key = normGameName(n);
            if (key && !m.has(key)) m.set(key, k);
        }
    }
    return m;
})();

/** The catalogue entry for a game name, or null. */
export function lookupKnownGame(name: string | null | undefined): KnownGame | null {
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) return null;
    return INDEX.get(normGameName(name)) ?? null;
}

export const steamStoreUrl = (appId: number): string => `https://store.steampowered.com/app/${appId}/`;

/** The art-proxy refs for a Steam title, best first (the grammar is apps/api/src/integrations/art.ts). */
export const steamArtRefs = (appId: number): string[] => [`steam:${appId}:portrait`, `steam:${appId}:header`, `steam:${appId}:capsule`];
