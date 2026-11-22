/**
 * The bot invite link. Pure; UX only (the real gate is Discord's own consent
 * screen, where the server owner picks the server and approves the bot).
 *
 * The application id is NEVER typed by the user. It comes from the bot token
 * itself (main process: GET /oauth2/applications/@me), so the link always
 * invites the bot the token belongs to. A hand-typed id was the root cause of
 * "the bot is not in any server": the owner invited one application's bot and
 * pasted another's token, and nothing checked the two belonged together.
 *
 * Permissions = 8, ADMINISTRATOR (owner decision 2026-11-22). The import copies
 * everything: every channel including private ones, roles, and per-member
 * permission overwrites. Discord only shows a bot all of that when it can see
 * every channel, and View Channels + Read Message History alone leaves private
 * channels (and their messages) invisible. Cipherline still only ever sends GET
 * requests through the bot (electron/discord-import/discord-client.ts hardcodes
 * the method, and a test enforces it): Administrator is for reading.
 */
export const ADMINISTRATOR_BIT = 1 << 3;
export const BOT_PERMISSIONS = ADMINISTRATOR_BIT; // 8

/** Guild install (not a user install): the bot joins a server. */
const GUILD_INSTALL = 0;

/** An application id (a snowflake) from the main process. Anything else is never put in a URL. */
function isAppId(input: unknown): input is string {
    return typeof input === 'string' && /^[0-9]{15,25}$/.test(input);
}

export function buildInviteUrl(applicationId: unknown): string | null {
    if (!isAppId(applicationId)) return null;
    return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${BOT_PERMISSIONS}&integration_type=${GUILD_INSTALL}`;
}

export const DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';

/** The Bot page of one application in the Developer Portal (where the intents and the token live). */
export function botPageUrl(applicationId: unknown): string {
    return isAppId(applicationId) ? `${DEVELOPER_PORTAL_URL}/${applicationId}/bot` : DEVELOPER_PORTAL_URL;
}

/**
 * "Watch a video" in the wizard's instructions (owner 2026-11-22: "you can just
 * have a link that says watch a video in the instructions that takes it to the
 * youtube video"). The ONE place the address lives. Empty = the link is hidden;
 * paste the YouTube link here once the video is up.
 */
export const DISCORD_IMPORT_VIDEO_URL = '';

const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be']);

/**
 * The video address as it will be opened, or null (the link is then hidden).
 * It goes to the system browser (shell.openExternal through main, which only
 * permits https), so it is held to more than that here (CLAUDE.md, Electron:
 * never open an unvalidated URL): https only, YouTube's own hosts only, no
 * user name / password, no port. Returns the PARSED href, so what was checked
 * is what is opened.
 */
export function videoUrlToOpen(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const raw = input.trim();
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    if (!raw || raw.length > 300 || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    if (u.username || u.password || u.port) return null;
    if (!VIDEO_HOSTS.has(u.hostname.toLowerCase())) return null;
    return u.href;
}
