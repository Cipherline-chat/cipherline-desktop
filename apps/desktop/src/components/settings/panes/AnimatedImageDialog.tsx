import React, { useEffect, useState } from 'react';
import { ClButton, ClModal } from '../../cl';

/**
 * Shown instead of the cropper for an animated avatar / banner. The crop
 * would flatten the animation to a still JPEG, so the file is kept as-is and
 * this previews exactly how it will be framed: centred, scaled to fill, with
 * the overflow cut off (CSS object-fit: cover, the same rule the app uses to
 * draw it everywhere).
 */
/** The preview itself; mounted per picked file so its object URL has a clean lifetime. */
const Preview: React.FC<{ file: File; isAvatar: boolean }> = ({ file, isAvatar }) => {
    const [url] = useState(() => URL.createObjectURL(file));
    useEffect(() => () => URL.revokeObjectURL(url), [url]);
    return isAvatar ? (
        <img src={url} alt="Preview" className="rounded-full object-cover" style={{ width: 112, height: 112 }} />
    ) : (
        <img src={url} alt="Preview" className="rounded-xl object-cover" style={{ width: 360, maxWidth: '100%', aspectRatio: '2.5 / 1' }} />
    );
};

export const AnimatedImageDialog: React.FC<{
    target: { kind: 'avatar' | 'banner'; file: File } | null;
    onCancel: () => void;
    onConfirm: (file: File) => void;
}> = ({ target, onCancel, onConfirm }) => {
    const isAvatar = target?.kind === 'avatar';
    return (
        <ClModal open={!!target} onClose={onCancel} width={420} label="Use animated image">
            <div className="p-5" data-testid="animated-dialog">
                <h3 className="m-0 mb-1 text-[16px]" style={{ fontFamily: 'var(--cl-font-display)' }}>Animated {isAvatar ? 'avatar' : 'banner'}</h3>
                <p className="m-0 mb-4 text-[12.5px]" style={{ color: 'var(--cl-muted)' }}>
                    This image keeps its animation, so it is used as it is rather than cropped. It is centred and scaled to fill the frame, like this.
                    On lists it shows the first frame and plays on hover; on your profile card it plays.
                </p>
                <div className="flex justify-center mb-4">
                    {target && <Preview key={target.file.name + target.file.size} file={target.file} isAvatar={isAvatar} />}
                </div>
                <div className="flex justify-end gap-2">
                    <ClButton variant="ghost" onClick={onCancel}>Cancel</ClButton>
                    <ClButton variant="primary" onClick={() => target && onConfirm(target.file)}>Use this image</ClButton>
                </div>
            </div>
        </ClModal>
    );
};
