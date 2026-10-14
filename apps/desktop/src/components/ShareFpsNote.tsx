import React from 'react';
import { ClNote } from './cl/ClNote';

/** One copy for every place a screen-share frame rate can be picked. */
export const SHARE_FPS_90_NOTE = '90 fps depends on your PC and upload speed — some setups will land nearer 60.';

/**
 * Informational (not a warning) note shown only while 90 fps is selected -
 * 90 is an "up to" target, the others are not. Shared by the screen-share
 * picker and the call bar's quality panel so the wording cannot drift.
 */
export const ShareFpsNote: React.FC<{ frameRate: number; className?: string }> = ({ frameRate, className }) =>
    frameRate === 90 ? (
        <ClNote className={className} data-testid="share-fps-note">{SHARE_FPS_90_NOTE}</ClNote>
    ) : null;
