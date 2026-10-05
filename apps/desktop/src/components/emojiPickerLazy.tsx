import React, { Suspense, lazy } from 'react';
import type { PickerProps } from './EmojiPicker';
import { loadEmojiPickerModule } from './emojiSearch';

/**
 * Boot-light entry point for the emoji picker.
 *
 * EmojiPicker.tsx pulls in emoji-mart, its React wrapper and the full emoji
 * dataset, and runs emoji-mart's `init()` over that dataset when it loads.
 * Importing it statically put all of that on the startup critical path (see
 * emojiSearch.ts). This wrapper is what the composer imports instead: the
 * heavy module loads on first open, or — normally, long before anyone opens a
 * picker — from prefetchEmojiPicker (emojiSearch.ts) once the app is idle
 * after boot.
 *
 * Opening the picker before the prefetch has finished renders nothing for the
 * few milliseconds the local chunk takes to load; it then appears exactly as
 * before (it positions itself off-screen first and snaps into place anyway).
 */
const LazyPopover = lazy(loadEmojiPickerModule);

const EmojiPickerPopover: React.FC<PickerProps> = (props) => (
    <Suspense fallback={null}>
        <LazyPopover {...props} />
    </Suspense>
);

export default EmojiPickerPopover;
