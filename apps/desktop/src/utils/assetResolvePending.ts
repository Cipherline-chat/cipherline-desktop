/**
 * The set of server emoji/sticker ids currently being looked up by id
 * (utils/serverAssetRefs.ts). Its own dependency-free module so the pure glyph
 * state function (components/server/emojiGlyphState.ts) can ask "is this id
 * still pending?" without importing axios / the secure store.
 */
export const pendingAssetIds = new Set<string>();
export const isAssetResolvePending = (id: string): boolean => pendingAssetIds.has(id);
