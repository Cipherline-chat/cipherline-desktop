/**
 * Screen-share picker thumbnails as JPEG data URLs (see the 'get-desktop-
 * sources' handler in main.ts for the measurements behind JPEG over PNG).
 *
 * Dependency-free on purpose (structural NativeImage type) so it can be unit
 * tested without Electron, and imports nothing from src/ (electron rootDir).
 */
export const THUMBNAIL_JPEG_QUALITY = 85;
export const EMPTY_THUMBNAIL_DATA_URL = 'data:image/png;base64,';

export function thumbnailJpegDataUrl(img: { isEmpty(): boolean; toJPEG(quality: number): Buffer }): string {
    // An empty thumbnail (minimised / zero-size window): exactly what
    // NativeImage.toDataURL() returned for it before, so the picker renders
    // it the same way it always has.
    if (img.isEmpty()) return EMPTY_THUMBNAIL_DATA_URL;
    return 'data:image/jpeg;base64,' + img.toJPEG(THUMBNAIL_JPEG_QUALITY).toString('base64');
}
