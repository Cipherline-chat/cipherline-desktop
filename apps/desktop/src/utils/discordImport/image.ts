/**
 * Fit a Discord server icon / banner to Cipherline's presets (the same sizes
 * Server Settings crops to), automatically, with a centred "cover" crop.
 * Canvas-based, so it only runs in the app; tests inject their own
 * `prepareImage`. An animated source arrives from the CDN as a still frame
 * (see electron/discord-import/snapshot.ts), so this never needs to decode a
 * GIF: the result is a JPEG, except an icon with see-through pixels, which stays
 * a PNG (keepTransparency) so a transparent server logo is not flattened onto
 * white. Banners always stay JPEG.
 */
import { AVATAR_OUTPUT, BANNER_OUTPUT, IDENTITY_CROP, imageUploadType, loadImageElement, renderCroppedBlob } from '../imageCrop';

export async function prepareGuildImage(blob: Blob, kind: 'icon' | 'banner'): Promise<{ blob: Blob; mime: string }> {
    const out = kind === 'icon' ? AVATAR_OUTPUT : BANNER_OUTPUT;
    const img = await loadImageElement(blob);
    const cropped = await renderCroppedBlob(
        img, IDENTITY_CROP, out.width, out.height, out.width, out.height, undefined,
        { keepTransparency: kind === 'icon' },
    );
    return { blob: cropped, mime: imageUploadType(cropped) };
}
