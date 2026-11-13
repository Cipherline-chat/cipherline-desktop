/* eslint-disable -- visual harness, not shipped */
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useEffect, useState } from 'react';
import { ClImageCropper } from '../src/components/cl';
import { ServerIcon } from '../src/components/server/ServerIcon';
import { AVATAR_OUTPUT, BANNER_OUTPUT } from '../src/utils/imageCrop';

/**
 * Animated server art harness. The cropper (with its real animated-crop worker), ServerIcon, the
 * still gate and the app stylesheets are the real ones; only the network/decrypt hook is stubbed
 * (animated-art-hook-stub.ts).
 *
 * ?scene=crop&kind=icon|banner&src=/art/x.gif   the cropper on an animated pick; Apply, then the result
 *                                               is decoded back in the page (frame count, timing, size)
 *                                               and laid out as a frame strip
 * ?scene=server                                 the server rail (first frame, plays on hover) + the open
 *                                               server's banner header (plays)
 */
loadWebFonts();
const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'crop';
declare const ImageDecoder: any;

async function fetchArt(path: string) {
    const r = await fetch(path);
    const blob = await r.blob();
    return { blob, mime: blob.type || r.headers.get('content-type') || 'application/octet-stream' };
}

/** Decode an animated image in the page and report frames/timing + draw a strip. */
async function inspect(blob: Blob) {
    const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type: blob.type });
    await dec.completed; await dec.tracks.ready;
    const n = dec.tracks.selectedTrack.frameCount;
    const durations: number[] = [];
    const picks = Array.from({ length: Math.min(6, n) }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, Math.min(6, n) - 1)));
    const frames: { i: number; bmp: ImageBitmap }[] = [];
    let w = 0, h = 0;
    for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        durations.push(Math.round((image.duration ?? 0) / 1000));
        w = image.displayWidth; h = image.displayHeight;
        if (picks.includes(i)) frames.push({ i, bmp: await createImageBitmap(image) });
        image.close();
    }
    const cell = 150, gap = 8;
    const canvas = document.getElementById('strip') as HTMLCanvasElement;
    const sc = Math.min(cell / w, cell / h);
    canvas.width = frames.length * (cell + gap); canvas.height = cell + 22;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0B0F1E'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '12px sans-serif'; ctx.fillStyle = '#9fb0d0';
    frames.forEach((f, k) => {
        ctx.drawImage(f.bmp, k * (cell + gap), 0, w * sc, h * sc);
        ctx.fillText(`frame ${f.i + 1}/${n}`, k * (cell + gap), cell + 16);
    });
    dec.close();
    return { frames: n, durations, width: w, height: h };
}

const CropScene: React.FC = () => {
    const kind = (q.get('kind') ?? 'icon') as 'icon' | 'banner';
    const src = q.get('src') ?? '/art/photo.gif';
    const [file, setFile] = useState<File | null>(null);
    const [done, setDone] = useState<Blob | null>(null);
    const [info, setInfo] = useState<any>(null);
    const [url, setUrl] = useState('');
    const [srcUrl, setSrcUrl] = useState('');
    const out = kind === 'banner' ? BANNER_OUTPUT : AVATAR_OUTPUT;
    useEffect(() => { fetchArt(src).then(({ blob }) => { setFile(new File([blob], src.split('/').pop()!, { type: blob.type })); setSrcUrl(URL.createObjectURL(blob)); }); }, []);
    useEffect(() => {
        if (!done) return;
        const u = URL.createObjectURL(done); setUrl(u);
        (window as any).__resultBlob = done;
        inspect(done).then((i) => { const r = { ...i, bytes: done.size, type: done.type }; setInfo(r); (window as any).__result = r; });
        return () => URL.revokeObjectURL(u);
    }, [done]);
    return (
        <div style={{ padding: 24, color: '#F4F7FF', fontFamily: 'var(--cl-font-body)', minHeight: 760, boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
                <div>
                    <div style={{ fontSize: 12, color: '#9fb0d0', marginBottom: 6 }}>Original pick (animated GIF)</div>
                    {srcUrl && <img id="src-img" src={srcUrl} style={{ width: 360, borderRadius: 10, display: 'block' }} />}
                </div>
                {done && (
                    <div>
                        <div style={{ fontSize: 12, color: '#9fb0d0', marginBottom: 6 }}>Stored result (cropped animated WebP) - plays</div>
                        <img id="result-img" src={url} style={{ width: kind === 'banner' ? 360 : 160, borderRadius: kind === 'banner' ? 10 : 22, display: 'block' }} />
                        <pre id="info" style={{ fontSize: 12, color: '#9fb0d0', marginTop: 10, whiteSpace: 'pre-wrap' }}>{info ? JSON.stringify({ ...info, durations: `${info.durations.length} x ~${info.durations[0]}ms` }, null, 1) : 'decoding…'}</pre>
                    </div>
                )}
            </div>
            <canvas id="strip" style={{ display: done ? 'block' : 'none', marginTop: 18 }} />
            <ClImageCropper
                open={!!file && !done}
                file={file}
                outputWidth={out.width}
                outputHeight={out.height}
                shape="rect"
                title={kind === 'banner' ? 'Position the server banner' : 'Position the server icon'}
                allowAnimated
                onCancel={() => {}}
                onConfirm={(b) => setDone(b)}
            />
        </div>
    );
};

const ServerScene: React.FC = () => {
    const [ready, setReady] = useState(false);
    useEffect(() => {
        (async () => {
            const art: Record<string, { url: string; mime: string }> = {};
            for (const [id, p] of [['icon-gif', '/art/icon.gif'], ['icon-webp', '/art/icon.webp'], ['banner-gif', '/art/banner.gif'], ['icon-png', '/art/static.png']] as const) {
                const { blob, mime } = await fetchArt(p);
                art[id] = { url: URL.createObjectURL(blob), mime };
            }
            (window as any).__art = art;
            setReady(true);
        })();
    }, []);
    if (!ready) return <div style={{ color: '#fff', padding: 20 }}>loading art…</div>;
    const tile = (id: string, name: string, att: string | null, active = false) => (
        <button key={id} data-testid={`tile-${id}`} type="button"
            style={{ position: 'relative', width: 44, height: 44, border: 'none', background: 'none', cursor: 'pointer', borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, flex: 'none' }}>
            <ServerIcon serverId={id} name={name} attachmentId={att} keyB64={att ? 'k' : null} nonceB64={att ? 'n' : null} token="t"
                className={`w-10 h-10 text-sm rounded-[10px] object-cover ${active ? '' : 'ring-1 ring-white/[0.08]'}`} />
        </button>
    );
    return (
        <div style={{ display: 'flex', width: 640, height: 420, background: 'var(--cl-abyss)', color: 'var(--cl-text)', fontFamily: 'var(--cl-font-body)', border: '1px solid var(--cl-border)' }}>
            <nav style={{ width: 72, borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, paddingTop: 20 }}>
                {tile('s1', 'Night Owls', 'icon-gif', true)}
                {tile('s2', 'Pixel Lab', 'icon-webp')}
                {tile('s3', 'Static Crew', 'icon-png')}
                {tile('s4', 'No Icon', null)}
            </nav>
            <div style={{ width: 260, borderRight: '1px solid var(--cl-border)', display: 'flex', flexDirection: 'column' }}>
                {/* The open server's masthead, exactly as ServerChannelList builds it (banner + gradient + title). */}
                <div data-testid="masthead" className="relative shrink-0 w-full overflow-hidden h-36">
                    <ServerIcon serverId="s1" name="Night Owls" attachmentId="banner-gif" keyB64="k" nonceB64="n" token="t" className="w-full h-full object-cover" animate />
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-cl-deep via-cl-deep/70 to-transparent pointer-events-none h-24" />
                    <div className="absolute inset-x-0 bottom-0 flex items-end justify-between px-3 pb-2 gap-1.5">
                        <h2 className="text-[18px] font-semibold text-cl-text truncate flex-1 leading-tight m-0" style={{ fontFamily: 'var(--cl-font-display)', textShadow: '0 1px 10px rgba(0,0,0,0.7)' }}>Night Owls</h2>
                    </div>
                </div>
                <div style={{ padding: 14, color: '#9fb0d0', fontSize: 13, lineHeight: 1.8 }}># general<br /># off-topic<br /># voice lounge</div>
            </div>
            <div style={{ flex: 1, padding: 16, color: '#9fb0d0', fontSize: 12.5, lineHeight: 1.6 }}>
                Rail: animated icons show their FIRST FRAME and play on hover. The open server&apos;s banner plays while Cipherline is in front.
            </div>
        </div>
    );
};

createRoot(document.getElementById('root')!).render(scene === 'server' ? <ServerScene /> : <CropScene />);
