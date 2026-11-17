/**
 * Rich Presence application id → display name, from a bundled static list.
 *
 * Rich Presence clients identify themselves only by an application id (a
 * Discord "client_id" snowflake). The names come from Discord's public
 * detectable-applications list, fetched at DEV time by
 * scripts/fetch-rpc-app-names.mjs and checked in as ./rpc-app-names.data.ts
 * (ids and names only). Nothing here, or anywhere in the app, calls a Discord
 * endpoint at runtime.
 *
 * Parsed lazily on first use (the Rich Presence listener only runs while the
 * user shares game activity), then kept for the life of the process.
 */
import { RPC_APP_NAMES_TSV } from './rpc-app-names.data';
import { gameNameKey } from './rpc-activity';

export { gameNameKey };

let byId: Map<string, string> | null = null;
let names: Set<string> | null = null;

export function parseAppNames(tsv: string): Map<string, string> {
    const m = new Map<string, string>();
    for (const line of tsv.split('\n')) {
        const tab = line.indexOf('\t');
        if (tab <= 0) continue;
        m.set(line.slice(0, tab), line.slice(tab + 1));
    }
    return m;
}

function load(): Map<string, string> {
    if (!byId) byId = parseAppNames(RPC_APP_NAMES_TSV);
    return byId;
}

/** The bundled name for an application id, or null when unknown. */
export function rpcAppName(clientId: string): string | null {
    return load().get(clientId) ?? null;
}

/**
 * Is a game of this name in the list (i.e. registered as an application that
 * can announce Rich Presence)? Used only for the local "another app is holding
 * Rich Presence" hint. A heuristic: being listed does not prove the game sends
 * Rich Presence.
 */
export function isKnownRpcGameName(name: string): boolean {
    if (!names) {
        names = new Set();
        for (const n of load().values()) names.add(gameNameKey(n));
    }
    return names.has(gameNameKey(name));
}

export function rpcAppNameCount(): number {
    return load().size;
}
