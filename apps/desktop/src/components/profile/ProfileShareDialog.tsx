import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Check, Copy, Download, Image as ImageIcon, Link2, X } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { API_BASE } from '../../constants';
import { useEncryptedAvatar } from '../../hooks/useEncryptedAvatar';
import { useEscape } from '../../hooks/useEscape';
import { writeToClipboard } from '../../utils/clipboard';
import { drawShareCard, shareLinkFor, SHARE_CARD_H, SHARE_CARD_W } from '../../utils/shareCard';
import type { ProfileCardData } from './profileCardData';
import '../../styles/profile-v3.css';

/**
 * "Share your profile": a card with your banner, avatar, name#tag and a QR
 * code for your invite link (GET /v1/billing/referral, the same link
 * Settings > Subscription shares). Someone new scans it and lands on your
 * invite page; someone already on Cipherline adds you by name#tag (printed on
 * the card). Everything is drawn on this device; the image never touches our
 * servers unless you send it somewhere.
 *
 * Actions: Copy link, Copy image, Save image (the native save dialog).
 */

const loadImage = (src: string | null): Promise<HTMLImageElement | null> => new Promise((res) => {
    if (!src) { res(null); return; }
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
});

type Done = 'link' | 'image' | 'saved' | null;

export const ProfileShareDialog: React.FC<{
    token: string;
    userId: string;
    data: ProfileCardData | null;
    avatarId: string | null;
    bannerId: string | null;
    onClose: () => void;
}> = ({ token, data, avatarId, bannerId, onClose }) => {
    useEscape(onClose);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [code, setCode] = useState<string | null | undefined>(undefined);
    const [ready, setReady] = useState(false);
    const [done, setDone] = useState<Done>(null);
    const [err, setErr] = useState<string | null>(null);
    const avatarUrl = useEncryptedAvatar(avatarId, token);
    const bannerUrl = useEncryptedAvatar(bannerId, token, null, { kind: 'banner' });
    const link = shareLinkFor(code);

    useLayoutEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, []);

    useEffect(() => {
        let alive = true;
        axios.get<{ referral_code?: string | null }>(`${API_BASE}/billing/referral`, { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 })
            .then((r) => { if (alive) setCode(r.data?.referral_code ?? null); })
            .catch(() => { if (alive) setCode(null); });
        return () => { alive = false; };
    }, [token]);

    // Redraw when anything on the card changes (fonts first, so the canvas uses the brand faces).
    useEffect(() => {
        if (code === undefined || !data) return;
        let alive = true;
        (async () => {
            try { await Promise.all(['600 26px Fredoka', '700 15px Nunito', '500 14px "JetBrains Mono"'].map((f) => document.fonts?.load?.(f))); } catch { /* fall back */ }
            const [avatar, banner] = await Promise.all([loadImage(avatarUrl), loadImage(bannerUrl)]);
            const c = canvasRef.current;
            const ctx = c?.getContext('2d');
            if (!alive || !c || !ctx) return;
            drawShareCard(ctx, {
                name: data.name, tag: data.discriminator !== null && data.discriminator !== undefined ? padDiscriminator(data.discriminator) : null,
                url: link.url, urlLabel: link.label, theme: data.theme, avatar, banner, initial: data.name.charAt(0) || '?',
            }, 2);
            setReady(true);
        })();
        return () => { alive = false; };
    }, [code, data, avatarUrl, bannerUrl, link.url, link.label]);

    useEffect(() => {
        if (!done) return;
        const t = window.setTimeout(() => setDone(null), 1800);
        return () => window.clearTimeout(t);
    }, [done]);

    const pngBlob = (): Promise<Blob | null> => new Promise((res) => {
        const c = canvasRef.current;
        if (!c) { res(null); return; }
        c.toBlob((b) => res(b), 'image/png');
    });

    const copyLink = async () => {
        setErr(null);
        try { await writeToClipboard(link.url); setDone('link'); } catch { setErr('Could not copy the link.'); }
    };
    const copyImage = async () => {
        setErr(null);
        try {
            const blob = await pngBlob();
            if (!blob || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('unsupported');
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            setDone('image');
        } catch { setErr('Could not copy the image. Try Save image instead.'); }
    };
    const saveImage = async () => {
        setErr(null);
        const blob = await pngBlob();
        if (!blob) { setErr('The card is not ready yet.'); return; }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const fileName = `${(data?.name || 'profile').replace(/[^\w.-]+/g, '_')}-cipherline.png`;
        try {
            if (window.electronAPI?.saveFileAs) {
                const r = await window.electronAPI.saveFileAs({ title: 'Save profile card', defaultPath: fileName, filters: [{ name: 'PNG image', extensions: ['png'] }] }, bytes);
                if (!r.canceled) setDone('saved');
                return;
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fileName; a.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 4000);
            setDone('saved');
        } catch { setErr('Could not save the image.'); }
    };

    return (
        <div className="psh-layer" onClick={(e) => { e.stopPropagation(); onClose(); }}>
            <div
                ref={panelRef} className="psh" role="dialog" aria-modal="true" aria-labelledby="psh-title" tabIndex={-1}
                onClick={(e) => e.stopPropagation()} data-testid="profile-share"
            >
                <div className="psh-head">
                    <h2 id="psh-title">Share your profile</h2>
                    <button type="button" className="psh-x" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
                </div>
                <div className="psh-card" data-ready={ready ? 'true' : undefined}>
                    <canvas
                        ref={canvasRef} width={SHARE_CARD_W * 2} height={SHARE_CARD_H * 2}
                        style={{ width: SHARE_CARD_W, height: SHARE_CARD_H }}
                        role="img" aria-label={`Profile card for ${data?.name ?? 'you'} with a QR code for ${link.label}`}
                    />
                </div>
                <p className="psh-note">
                    New people land on your invite page. People already here can add you as <b>{data?.name}{data?.discriminator != null ? `#${padDiscriminator(data.discriminator)}` : ''}</b>.
                </p>
                <div className="psh-actions">
                    <button type="button" className="psh-btn psh-btn--primary" onClick={() => void copyLink()} disabled={code === undefined}>
                        {done === 'link' ? <Check size={15} aria-hidden="true" /> : <Link2 size={15} aria-hidden="true" />}{done === 'link' ? 'Link copied' : 'Copy link'}
                    </button>
                    <button type="button" className="psh-btn" onClick={() => void copyImage()} disabled={!ready}>
                        {done === 'image' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{done === 'image' ? 'Image copied' : 'Copy image'}
                    </button>
                    <button type="button" className="psh-btn" onClick={() => void saveImage()} disabled={!ready}>
                        {done === 'saved' ? <Check size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}{done === 'saved' ? 'Saved' : 'Save image'}
                    </button>
                </div>
                <p className="psh-status" role="status" aria-live="polite">
                    {err ?? (code === undefined ? <><ImageIcon size={12} aria-hidden="true" /> Getting your invite link…</> : null)}
                </p>
            </div>
        </div>
    );
};

export default ProfileShareDialog;
