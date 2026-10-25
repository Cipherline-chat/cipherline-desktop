import { personalEmojis } from './service';
import { takePersonalEmojis } from './wire';
import { takeStatusEmoji, type TakeStatusEmojiCtx } from './statusEmoji';

/**
 * Called on every decrypted message body (DM pull, live channel message,
 * channel history) before it is shown or stored: files any personal emojis it
 * carries into the local encrypted store and returns the content without the
 * bytes. Synchronous for the caller; the images land a moment later and the
 * emoji component re-resolves when they do.
 */
export function ingestInboundContent<T>(content: T): T {
    return takePersonalEmojis(content, personalEmojis().store).content;
}

/**
 * The DM pull loop's second pass: a friend's `profile_update` may carry the
 * image of their personal-emoji status (`status_emoji`). Verified and filed in
 * the received-emoji cache; the content is returned WITHOUT the bytes so they
 * never reach the thread, the carry buffer or a backup. See statusEmoji.ts.
 */
export function ingestInboundStatusEmoji<T>(content: T, ctx: Omit<TakeStatusEmojiCtx, 'store'>): T {
    return takeStatusEmoji(content, { ...ctx, store: personalEmojis().store }).content;
}
