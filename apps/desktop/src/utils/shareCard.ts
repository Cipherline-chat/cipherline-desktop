import QRCode from 'qrcode';
import { themeSurface, type ProfileTheme } from './profileTheme';

/**
 * The profile share card, drawn on a canvas so the card you see IS the image
 * you save or copy (no DOM-to-image step, nothing leaves the device).
 *
 * The QR code is generated on-device by `qrcode` (MIT, already a desktop
 * dependency for QR sign-in). Error correction "M" and a quiet zone of 3
 * modules on a near-white plate: dark-on-light at high contrast is what every
 * phone camera reads first time, so the plate stays light even on a dark card.
 */

export const SHARE_CARD_W = 360;
export const SHARE_CARD_H = 588;

/** The link the card shares: the referral page (shows your name + avatar, then the app / sign-up). */
export function shareLinkFor(code: string | null | undefined): { url: string; label: string } {
    const clean = typeof code === 'string' && /^[A-Za-z0-9-]{4,32}$/.test(code) ? code : null;
    return clean
        ? { url: `https://cipherline.chat/ref/${clean}`, label: `cipherline.chat/ref/${clean}` }
        : { url: 'https://cipherline.chat', label: 'cipherline.chat' };
}

export interface QrMatrix { size: number; dark: (row: number, col: number) => boolean }

export function qrMatrix(text: string): QrMatrix {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const m = qr.modules;
    return { size: m.size, dark: (r, c) => m.get(r, c) === 1 };
}

export interface ShareCardInput {
    name: string;
    tag: string | null;
    url: string;
    urlLabel: string;
    theme: ProfileTheme | null;
    avatar: CanvasImageSource | null;
    banner: CanvasImageSource | null;
    /** Shown in the avatar circle when there is no avatar image. */
    initial: string;
}

const NAVY = '#131a30';
const ABYSS = '#0b0f1e';
const TEXT = '#f4f7ff';
const MUTED = '#a7b3d4';
const FAINT = '#5e6b8f';
const LUME = '#25e0c8';
const PLATE = '#f4f7ff';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** object-fit: cover for drawImage. */
function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, x: number, y: number, w: number, h: number) {
    const iw = (img as HTMLImageElement).naturalWidth || (img as HTMLCanvasElement).width || w;
    const ih = (img as HTMLImageElement).naturalHeight || (img as HTMLCanvasElement).height || h;
    const s = Math.max(w / iw, h / ih);
    const sw = w / s, sh = h / s;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
    if (ctx.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
    return `${t}…`;
}

/** Draw the card at `scale` (2 = a crisp 720px-wide image). The canvas must be SHARE_CARD_W*scale by SHARE_CARD_H*scale. */
export function drawShareCard(ctx: CanvasRenderingContext2D, input: ShareCardInput, scale = 2): void {
    const W = SHARE_CARD_W, H = SHARE_CARD_H;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Body: the theme's tinted surface (the same contrast-capped colours as the profile card), else navy.
    const surface = input.theme ? themeSurface(input.theme) : null;
    roundRect(ctx, 0, 0, W, H, 26);
    ctx.save();
    ctx.clip();
    if (surface) {
        const g = ctx.createLinearGradient(0, 0, W * 0.4, H);
        g.addColorStop(0, surface.from);
        g.addColorStop(1, surface.to);
        ctx.fillStyle = g;
    } else ctx.fillStyle = NAVY;
    ctx.fillRect(0, 0, W, H);

    // Banner (or a quiet abyss band), fading into the body.
    const BH = 132;
    if (input.banner) drawCover(ctx, input.banner, 0, 0, W, BH);
    else {
        ctx.fillStyle = ABYSS;
        ctx.fillRect(0, 0, W, BH);
    }
    const fade = ctx.createLinearGradient(0, BH - 56, 0, BH);
    fade.addColorStop(0, 'rgba(0,0,0,0)');
    fade.addColorStop(1, surface ? surface.from : NAVY);
    ctx.fillStyle = fade;
    ctx.fillRect(0, BH - 56, W, 56);
    ctx.restore();

    // Frame: the theme's true colours, else a hairline.
    roundRect(ctx, 1, 1, W - 2, H - 2, 25);
    if (input.theme) {
        const f = ctx.createLinearGradient(0, 0, W, H);
        f.addColorStop(0, input.theme.primary);
        f.addColorStop(1, input.theme.accent);
        ctx.strokeStyle = f;
        ctx.lineWidth = 2;
    } else {
        ctx.strokeStyle = 'rgba(255,255,255,.10)';
        ctx.lineWidth = 1;
    }
    ctx.stroke();

    // Avatar with a ring of the body colour.
    const AV = 96, ax = W / 2, ay = BH;
    ctx.beginPath();
    ctx.arc(ax, ay, AV / 2 + 6, 0, Math.PI * 2);
    ctx.fillStyle = surface ? surface.from : NAVY;
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(ax, ay, AV / 2, 0, Math.PI * 2);
    ctx.clip();
    if (input.avatar) drawCover(ctx, input.avatar, ax - AV / 2, ay - AV / 2, AV, AV);
    else {
        ctx.fillStyle = '#243056';
        ctx.fillRect(ax - AV / 2, ay - AV / 2, AV, AV);
        ctx.fillStyle = TEXT;
        ctx.font = '600 40px Fredoka, Nunito, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(input.initial.toUpperCase(), ax, ay + 2);
    }
    ctx.restore();

    // Name #tag.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 26px Fredoka, Nunito, sans-serif';
    const name = fitText(ctx, input.name, W - 64);
    const tag = input.tag ? `#${input.tag}` : '';
    ctx.font = '500 14px "JetBrains Mono", monospace';
    const tagW = tag ? ctx.measureText(tag).width + 8 : 0;
    ctx.font = '600 26px Fredoka, Nunito, sans-serif';
    const nameW = ctx.measureText(name).width;
    const nx = W / 2 - (nameW + tagW) / 2;
    ctx.textAlign = 'left';
    ctx.fillStyle = TEXT;
    ctx.fillText(name, nx, 230);
    if (tag) {
        ctx.font = '500 14px "JetBrains Mono", monospace';
        ctx.fillStyle = MUTED;
        ctx.fillText(tag, nx + nameW + 8, 230);
    }

    // QR plate.
    const PS = 196, px = (W - PS) / 2, py = 254;
    roundRect(ctx, px, py, PS, PS, 18);
    ctx.fillStyle = PLATE;
    ctx.fill();
    const qr = qrMatrix(input.url);
    const quiet = 3;
    const cell = (PS - 8) / (qr.size + quiet * 2);
    const ox = px + 4 + quiet * cell, oy = py + 4 + quiet * cell;
    ctx.fillStyle = ABYSS;
    const inFinder = (r: number, c: number) => (r < 7 && c < 7) || (r < 7 && c >= qr.size - 7) || (r >= qr.size - 7 && c < 7);
    for (let r = 0; r < qr.size; r++) {
        for (let c = 0; c < qr.size; c++) {
            if (!qr.dark(r, c) || inFinder(r, c)) continue;
            roundRect(ctx, ox + c * cell + 0.35, oy + r * cell + 0.35, cell - 0.7, cell - 0.7, cell * 0.32);
            ctx.fill();
        }
    }
    // Finder patterns: rounded rings with a rounded core (still the standard 7/5/3 geometry).
    for (const [r, c] of [[0, 0], [0, qr.size - 7], [qr.size - 7, 0]] as const) {
        const x = ox + c * cell, y = oy + r * cell;
        roundRect(ctx, x, y, cell * 7, cell * 7, cell * 2);
        ctx.fillStyle = ABYSS; ctx.fill();
        roundRect(ctx, x + cell, y + cell, cell * 5, cell * 5, cell * 1.4);
        ctx.fillStyle = PLATE; ctx.fill();
        roundRect(ctx, x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell);
        ctx.fillStyle = ABYSS; ctx.fill();
    }

    // Caption.
    ctx.textAlign = 'center';
    ctx.fillStyle = TEXT;
    ctx.font = '700 15px Nunito, sans-serif';
    ctx.fillText('Scan to join me on Cipherline', W / 2, py + PS + 30);
    ctx.font = '500 12.5px "JetBrains Mono", monospace';
    ctx.fillStyle = LUME;
    ctx.fillText(fitText(ctx, input.urlLabel, W - 48), W / 2, py + PS + 52);

    // Footer: how existing users find you, and the promise.
    ctx.font = '600 12.5px Nunito, sans-serif';
    ctx.fillStyle = MUTED;
    ctx.fillText(fitText(ctx, `Already on Cipherline? Add ${input.name}${tag}`, W - 48), W / 2, H - 48);
    ctx.font = '600 11.5px Nunito, sans-serif';
    ctx.fillStyle = FAINT;
    ctx.fillText('End-to-end encrypted messages and calls', W / 2, H - 26);
    ctx.restore();
}
