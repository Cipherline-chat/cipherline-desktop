import React from 'react';
import { nativePreviewHub, type PreviewPicture } from '../../utils/nativeSharePreview';

/**
 * Your own NATIVE (Linux hardware) share, drawn: the helper's thumbnail of the frames it is encoding (utils/nativeSharePreview.ts).
 * Mounting subscribes (which is what asks the helper for pictures); unmounting stops them, so the cost exists only while this is on
 * screen. Before the first picture (or with a helper that predates previews) it says the one short thing it can.
 */
export const NativeSharePreview = ({ fillsParent, isFilled }: { fillsParent: boolean; isFilled?: boolean }) => {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);
    const [have, setHave] = React.useState(false);
    React.useEffect(() => {
        const off = nativePreviewHub.subscribe((pic: PreviewPicture | null) => {
            const c = canvasRef.current;
            if (!pic || !c) { setHave(false); return; }
            if (c.width !== pic.w) c.width = pic.w;
            if (c.height !== pic.h) c.height = pic.h;
            const ctx = c.getContext('2d');
            if (!ctx) return;
            ctx.putImageData(new ImageData(pic.rgba as Uint8ClampedArray<ArrayBuffer>, pic.w, pic.h), 0, 0);
            setHave(true);
        });
        return off;
    }, []);
    return (
        <div
            data-testid="native-share-preview"
            className={`relative overflow-hidden bg-cl-abyss flex items-center justify-center ${
                fillsParent ? 'w-full h-full' : 'w-full shrink-0 min-h-[80px] aspect-video'
            } ${isFilled ? '' : 'rounded-xl ring-inset ring-1 ring-white/5'}`}
        >
            <canvas ref={canvasRef} className={`w-full h-full object-contain ${have ? '' : 'hidden'}`} />
            {!have && <span className="text-[11px] font-semibold text-cl-text/35 text-center px-4 leading-snug">Sharing your screen</span>}
        </div>
    );
};
