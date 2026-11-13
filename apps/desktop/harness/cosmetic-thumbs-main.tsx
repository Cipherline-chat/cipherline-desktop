/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/settings-ui.css';
import '../src/styles/profile-settings.css';
import { loadWebFonts } from '../src/utils/webFonts';
import React from 'react';
import { AvatarDecoration } from '../src/components/ProfileCosmetics';
import { AVATAR_DECORATIONS } from '../src/utils/profileCosmetics';

/**
 * Cosmetic thumbnails harness. AvatarDecoration, the art and the picker's stylesheets are the real ones;
 * the grid markup mirrors ProfileCosmeticsSection's Tile + DecoThumb (a 36px face in a 56px preview box).
 *
 * ?scene=grid      the Decoration picker grid, every item (&locked=1: every tile locked, as most users see the
 *                  rarer ones; &face=light: a light avatar photo; &tint=<css colour>: "Match theme")
 * ?scene=detail    &ids=a,b,c  each item at the switch (26), grid (36), inspector (44) and card (92) sizes, on a
 *                  mid-tone and a light avatar
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'grid';
const tint = q.get('tint');

const svgUri = (s: string) => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
// A stand-in avatar photo: a person on a backdrop (mid-tone, the common case) or a bright, washed-out one.
const FACES: Record<string, string> = {
    mid: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="b" x2="0" y2="1"><stop offset="0" stop-color="#5B7FA8"/><stop offset="1" stop-color="#2E4566"/></linearGradient></defs><rect width="100" height="100" fill="url(#b)"/><ellipse cx="50" cy="98" rx="38" ry="26" fill="#3B3F4C"/><rect x="43" y="58" width="14" height="16" fill="#C98F6B"/><ellipse cx="50" cy="44" rx="18" ry="21" fill="#D9A27E"/><path d="M31 42 Q32 18 50 19 Q70 18 69 42 Q66 30 50 29 Q36 30 31 42Z" fill="#3A2A22"/></svg>`),
    light: svgUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#EDE6DA"/><ellipse cx="50" cy="98" rx="38" ry="26" fill="#F7F7F2"/><rect x="43" y="58" width="14" height="16" fill="#EBC3A5"/><ellipse cx="50" cy="44" rx="18" ry="21" fill="#F2CFB3"/><path d="M31 42 Q32 18 50 19 Q70 18 69 42 Q66 30 50 29 Q36 30 31 42Z" fill="#D8B27A"/></svg>`),
};
const Face: React.FC<{ face: string }> = ({ face }) => <img src={FACES[face] ?? FACES.mid} alt="" style={{ width: '100%', height: '100%', display: 'block' }} />;

/** ProfileCosmeticsSection's DecoThumb, with the stand-in face. */
const Thumb: React.FC<{ id: string | null; size: number; face: string }> = ({ id, size, face }) => (
    <AvatarDecoration decoration={id} tint={tint} className="shrink-0" compact={size <= 44}>
        <span className="su-avatar-face" style={{ width: size, height: size }}><Face face={face} /></span>
    </AvatarDecoration>
);

const items = AVATAR_DECORATIONS.filter((d) => !d.legacy);

function Grid() {
    const locked = q.get('locked') === '1';
    const face = q.get('face') ?? 'mid';
    return (
        <div style={{ width: 560, padding: 20, background: 'var(--cl-deep)', color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body, Nunito, sans-serif)' }}>
            <div className="pst-grid" data-testid="grid">
                {[{ id: null as string | null, label: 'None' }, ...items].map((it) => (
                    <button key={it.id ?? 'none'} type="button" className="pst-tile" data-tile={it.id ?? 'none'} role="radio" aria-checked={false}
                        data-locked={locked && it.id ? 'true' : undefined}>
                        <span className="pst-tile-prev"><Thumb id={it.id} size={36} face={face} /></span>
                        <span className="pst-tile-name">{it.label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

function Detail() {
    const ids = (q.get('ids') ?? 'orrery,bat-halo,eclipse').split(',');
    const sizes = [26, 36, 44, 92];
    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: 16, background: 'var(--cl-deep)', color: 'var(--cl-muted)', fontFamily: 'Nunito, sans-serif', fontSize: 12 }}>
            {ids.map((id) => (
                <div key={id} data-row={id} style={{ display: 'flex', alignItems: 'center', gap: 34, padding: '34px 30px' }}>
                    <div style={{ width: 90 }}>{id}</div>
                    {['mid', 'light'].map((face) => sizes.map((s) => (
                        <div key={face + s} style={{ width: s + 40, display: 'flex', justifyContent: 'center' }}><Thumb id={id} size={s} face={face} /></div>
                    )))}
                </div>
            ))}
        </div>
    );
}

createRoot(document.getElementById('root')!).render(scene === 'detail' ? <Detail /> : <Grid />);
