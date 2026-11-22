/**
 * A sticker message in the feed: the image, large (STICKER_DISPLAY_PX = 160
 * CSS px, stored at 2x), no text and no card chrome. The message's `text` is
 * only the fallback an older client shows. Right-click on the row offers "Add
 * to My stickers" (ChatPane's message menu, `addToMyStickersItem`).
 */
import React from 'react';
import { STICKER_DISPLAY_PX } from '@cipherline/shared';
import { StickerImage } from './StickerImage';
import type { StickerRef } from '../../utils/stickers/wire';

export const StickerMessage: React.FC<{ sticker: StickerRef; token: string | null; size?: number }> = ({ sticker, token, size = STICKER_DISPLAY_PX }) => (
    <div
        className="cl-sticker-msg mt-0.5 inline-flex"
        role="group"
        aria-label={`Sticker: ${sticker.name}`}
        data-sticker-source={sticker.source}
        style={{ width: size, height: size }}
    >
        <StickerImage sticker={sticker} token={token} size={size} />
    </div>
);

export default StickerMessage;
