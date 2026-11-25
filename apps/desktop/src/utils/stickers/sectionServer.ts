/**
 * Which server a sticker-picker section belongs to, in the shape the shared
 * `ServerIcon` (components/server/ServerIcon.tsx) takes, so the picker draws
 * each server section with that server's real icon exactly like the server
 * rail does (same decryption + cache path, same abbreviation-tile fallback).
 *
 * The server's NAME is what the icon and its tooltip use, never the section
 * title: the current server's title is "<name> (this server)", and feeding
 * that to the abbreviation made the fallback read "A(" for "Alpha".
 *
 * A server can be in the sticker index but missing from the caller's server
 * list (the list is still loading, or you just left): the section still gets
 * a tile — a neutral name and no icon, so the coloured abbreviation fallback
 * shows instead of nothing.
 */

export interface StickerServerLite {
    server_id: string;
    name: string;
    /** Same fields as `ServerInfo` (hooks/useServers.ts); optional so a caller
     *  without icon data still type-checks and simply gets the fallback tile. */
    icon_attachment?: string | null;
    icon_key_b64?: string | null;
    icon_nonce_b64?: string | null;
}

export interface StickerSectionServer {
    serverId: string;
    name: string;
    attachmentId: string | null;
    keyB64: string | null;
    nonceB64: string | null;
}

export const UNKNOWN_SERVER_NAME = 'Server';

export function stickerSectionServer(serverId: string, servers: readonly StickerServerLite[]): StickerSectionServer {
    const s = servers.find(x => x.server_id === serverId);
    const name = s?.name?.trim() ? s.name : UNKNOWN_SERVER_NAME;
    // ServerIcon only decrypts when all three are present; normalise a partial
    // set to "no icon" here so the fallback decision is made in one place.
    const attachmentId = s?.icon_attachment || null;
    const keyB64 = s?.icon_key_b64 || null;
    const nonceB64 = s?.icon_nonce_b64 || null;
    const complete = !!(attachmentId && keyB64 && nonceB64);
    return {
        serverId,
        name,
        attachmentId: complete ? attachmentId : null,
        keyB64: complete ? keyB64 : null,
        nonceB64: complete ? nonceB64 : null,
    };
}
