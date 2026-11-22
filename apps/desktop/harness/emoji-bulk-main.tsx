/* eslint-disable -- visual harness, not shipped */
// ?scene=server|my   [&state=review|running|finished]
// Both flows render the REAL BulkEmojiDialog with the same props the app passes (the My Emojis scene swaps the
// device-only store for a fake upload, since the encrypted library needs a signed-in account).
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import '../src/styles/cl-kit.css';
import '../src/styles/cl-kit-fallback.css';
import '../src/styles/cl-kit-ext.css';
import '../src/styles/settings-descent.css';
import '../src/styles/layout-drift.css';
import '../src/utils/clPhysics';
import { loadWebFonts } from '../src/utils/webFonts';
import React, { useEffect, useState } from 'react';
import { BulkEmojiDialog } from '../src/components/emoji/BulkEmojiDialog';
import { ClSegment } from '../src/components/cl';
import { validateEmojiUpload } from '../src/utils/imageUploadValidation';
import { emojiFileProblem } from '../src/utils/personalEmoji/pickFile';

loadWebFonts();
const q = new URLSearchParams(location.search);
const SCENE = q.get('scene') ?? 'server';
const STATE = q.get('state') ?? 'review';

const COLORS = ['#e06c75', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#d19a66', '#abb2bf'];
function pic(name: string, type: string, size: number, color: string): Promise<File> {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!; g.fillStyle = color; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(64, 64, 36, 0, 7); g.fill();
    return new Promise(res => c.toBlob(b => {
        const f = new File([b!], name, { type });
        Object.defineProperty(f, 'size', { value: size });
        res(f);
    }, 'image/png'));
}
const SPEC: [string, string, number][] = [
    ['Happy Face.png', 'image/png', 18_000],
    ['party-parrot.gif', 'image/gif', 240_000],
    ['huge holiday photo.jpg', 'image/jpeg', 9_400_000],
    ['notes.svg', 'image/svg+xml', 3_000],
    ['cat.png', 'image/png', 41_000],
    ['Cat.webp', 'image/webp', 12_000],
    ['a_really_long_filename_that_goes_on_and_on_and_on_forever_and_ever.webp', 'image/webp', 22_000],
    ['dog.png', 'image/png', 30_000],
];

const Scene: React.FC = () => {
    const [files, setFiles] = useState<File[] | null>(null);
    const [mode, setMode] = useState<'crop' | 'fit'>('crop');
    useEffect(() => { Promise.all(SPEC.map(([n, t, s], i) => pic(n, t, s, COLORS[i % COLORS.length]))).then(setFiles); }, []);
    if (!files) return null;
    const server = SCENE === 'server';
    const slow = STATE === 'running';
    return (
        <div data-scene={SCENE}>
            <BulkEmojiDialog
                key={SCENE + STATE}
                title="Add emojis"
                subtitle={server ? 'Check the names, then upload them all. The server checks each one again.' : 'Shrunk to 128 px on this computer. Nothing is uploaded.'}
                initialFiles={STATE === 'review' ? files : files.filter(f => f.size < 5_000_000 && f.type !== 'image/svg+xml')}
                existingNames={server ? ['dog', 'blobcat'] : ['happy_face']}
                slots={server ? 1000 - 993 : 100 - 94}
                slotNoun={server ? 'on this server' : 'in My Emojis'}
                fileProblem={server ? f => { const r = validateEmojiUpload(f); return r.ok ? null : r.reason; } : emojiFileProblem}
                concurrency={server ? 2 : 1}
                minGapMs={() => 0}
                activeLabel={server ? 'Uploading' : 'Adding'}
                previewFit={mode === 'fit' ? 'contain' : 'cover'}
                errorMessage={e => (e instanceof Error ? e.message : 'failed')}
                extra={server ? undefined : (
                    <div>
                        <div className="text-xs text-cl-faint mb-1.5">Shape for all of them</div>
                        <ClSegment options={[{ value: 'crop', label: 'Crop to square' }, { value: 'fit', label: 'Fit whole picture' }]} value={mode} onChange={setMode as any} />
                    </div>
                )}
                upload={async (row) => {
                    await new Promise(r => setTimeout(r, slow ? 60_000 : 150));
                    if (row.name.startsWith('cat')) throw new Error('This server is rate limiting uploads. Try again in a moment.');
                }}
                onClose={() => {}}
            />
        </div>
    );
};
createRoot(document.getElementById('root')!).render(<Scene />);
