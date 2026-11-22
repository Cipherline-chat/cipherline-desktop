/**
 * Window event fired by useRealtime when the server says `discord:link_changed`
 * (Discord import phase 3b: the link was moved to or away from this account).
 * useDiscordLink listens and re-reads GET /v1/discord/link. A plain event
 * keeps useRealtime from importing the Discord API module. No dependencies.
 */
export const DISCORD_LINK_CHANGED_EVENT = 'cipherline:discord-link-changed';
