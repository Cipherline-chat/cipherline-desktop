/**
 * One sticker image at a given size, whichever kind it is. The image path is
 * the custom-emoji one on purpose (reuse, not a fork):
 *   personal -> PersonalEmojiImage (the shared on-device blob store; animated
 *               ones freeze when the app is not in front / reduced motion)
 *   server   -> EmojiImage (serverEmojiLoader: encrypted disk cache, batched
 *               signed URLs, freeze when away)
 * Loading shows a pulsing box; a sticker that is gone (deleted from its
 * server, or never received on this device) shows a labelled placeholder with
 * its name, never a broken image.
 */
import React from 'react';
import { Sticker as StickerIcon } from 'lucide-react';
import { PersonalEmojiImage } from '../PersonalEmoji';
import { EmojiImage, EmojiPlaceholder } from '../server/EmojiImage';
import { useServerSticker, type ServerSticker } from '../../utils/stickers/serverStickers';
import type { StickerRef } from '../../utils/stickers/wire';

interface Props {
    sticker: StickerRef;
    token: string | null;
    /** CSS px of the square box the image is fitted into. */
    size: number;
    /** A server sticker row already in hand (picker/settings) - skips the lookup. */
    row?: ServerSticker;
    className?: string;
}

export const StickerUnavailable: React.FC<{ name: string; size: number }> = ({ name, size }) => (
    <span
        role="img"
        aria-label={`Sticker "${name}" is not available`}
        title={`Sticker: ${name} — not available`}
        className="inline-flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-cl-border text-cl-faint"
        style={{ width: size, height: size }}
    >
        <StickerIcon size={Math.max(16, Math.round(size / 5))} aria-hidden="true" />
        {size >= 96 && <span className="text-[11px] px-2 truncate max-w-full">{name}</span>}
    </span>
);

const ServerStickerImage: React.FC<Props> = ({ sticker, token, size, row, className }) => {
    const looked = useServerSticker(row ? null : sticker.server_id, sticker.id, token);
    const s = row ?? looked;
    const box = { width: size, height: size };
    if (s === undefined) return <EmojiPlaceholder style={box} className={`rounded-xl ${className ?? ''}`} />;
    if (s === null) return <StickerUnavailable name={sticker.name} size={size} />;
    return (
        <EmojiImage
            name={s.name}
            serverId={s.server_id}
            attachmentId={s.attachment_id}
            keyB64={s.key_b64}
            nonceB64={s.nonce_b64}
            token={token}
            style={box}
            className={className}
        />
    );
};

export const StickerImage: React.FC<Props> = (props) => {
    const { sticker, size, className } = props;
    if (sticker.source === 'server') return <ServerStickerImage {...props} />;
    return (
        <PersonalEmojiImage
            id={sticker.id}
            name={sticker.name}
            saveable={false}
            className={className}
            style={{ width: size, height: size }}
        />
    );
};
