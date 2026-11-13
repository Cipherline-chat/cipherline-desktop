import React, { useEffect, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { ClButton, ClModal } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogText } from '../../dialog/DialogFrame';

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
    const what = isAvatar ? 'avatar' : 'banner';
    return (
        <ClModal open={!!target} onClose={onCancel} width={440} label="Use animated image" cardClassName="dlg-card">
            <DialogHeader
                icon={<Clapperboard size={18} strokeWidth={2.2} />}
                title={`Animated ${what}`}
                subtitle="It keeps its animation, so it is used as it is rather than cropped."
            />
            <div data-testid="animated-dialog" className="dlg-form">
                <DialogBody>
                    <DialogText>
                        It is centred and scaled to fill the frame, like this. On lists it shows
                        the first frame and plays on hover; on your profile card it plays.
                    </DialogText>
                    <div className="flex justify-center" style={{ marginTop: 14 }}>
                        {target && <Preview key={target.file.name + target.file.size} file={target.file} isAvatar={isAvatar} />}
                    </div>
                </DialogBody>
                <DialogFooter>
                    <ClButton variant="ghost" size="sm" onClick={onCancel}>Cancel</ClButton>
                    <ClButton variant="primary" size="sm" onClick={() => target && onConfirm(target.file)}>Use this image</ClButton>
                </DialogFooter>
            </div>
        </ClModal>
    );
};
