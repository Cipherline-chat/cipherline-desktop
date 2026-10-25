import React from 'react';
import { StatusPersonalEmoji } from './StatusPersonalEmoji';
import { isPersonalEmojiId } from '../utils/personalEmoji/token';

/**
 * The `renderCustom` for `StatusEmoji` that draws a personal ("My Emojis")
 * emoji from this device's library / received cache only (no fetch).
 * `userId` = whose status it is (unused for resolving); `animate` plays an animated one (profile card). Any other `cl:` value
 * renders nothing. A plain .ts file so StatusLine.tsx stays components-only.
 */
export const personalStatusEmoji = (userId?: string | null, animate = false) => (ref: string): React.ReactNode =>
    isPersonalEmojiId(ref) ? React.createElement(StatusPersonalEmoji, { id: ref, userId, animate }) : null;
