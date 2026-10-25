/**
 * The short lines under the loading screen: a tip, or something dry, changing
 * every few seconds while the app gets ready (components/LoadingTip.tsx).
 *
 * House rules (the test enforces the checkable ones):
 *   - Plain or dry. Never a pun, and nothing nautical (no sea, bubble, dive,
 *     wave, tide, swim, fish...). The wait is not the place to try hard.
 *   - A tip says only what the app actually does. A joke never claims work the
 *     app is not doing.
 *   - Short enough for one line on a small window.
 *   - Static strings only: nothing here reads the user's data.
 */

export const LOADING_TIPS: readonly string[] = [
    // Tips
    'Messages are encrypted before they leave this device.',
    'Every keyboard shortcut can be changed in Settings.',
    'Your mute shortcut works even when Cipherline is in the background.',
    'Type # in a server channel to link to another channel.',
    'Type @ to mention someone.',
    'Right-click the DMs button for Mark all as read.',
    'Esc closes whatever is on top.',
    'Safety numbers let you check you are talking to who you think you are.',
    'The Screen Lock hides everything until you enter your PIN.',
    'Encrypted backups can go to a local folder or to Google Drive.',
    'You can message yourself. Search your own name.',
    'Stop watching a screen share and it stops using your bandwidth.',
    'A reaction that did not go through turns red, with Retry and Remove.',
    'The padlock in a call tells you if anyone in it is not encrypted.',
    'A pill at the edge of the channel list points to unread channels out of view.',
    'Echo cancellation is on by default. It lives in Settings, under Voice and Video.',
    'Pressing ? outside a text box shows every shortcut.',
    'Your recovery key is in Settings. Keep a copy somewhere that is not this computer.',
    // Dry
    'We cannot read your messages. It saves us a lot of time.',
    'The bar below has no percentage. We would be guessing.',
    'We did consider a progress bar that lies. We did not.',
    'No ads were loaded during this wait.',
    'This line has been read by more people than most documentation.',
    'If this takes long enough, you can read all of these.',
    'The next line is not better.',
    'Please remain seated. You are already seated. Good.',
    'A watched app loads at exactly the same speed.',
    'No account manager has been assigned to this loading screen.',
    'Loading screens are the elevator music of apps.',
    'Status: loading. Mood: professional.',
    'This is the part where we pretend this is deliberate.',
    'Still here. So are you.',
    'Nothing on this screen is the app. It is nearly here.',
    'Fun fact: this is not a fun fact.',
    'Somewhere, a server is relaying something it cannot read.',
    'You could be looking at a spinner. Consider yourself upgraded.',
    'Reading this counts as productive. We have decided.',
    'Nobody has ever been faster by refreshing.',
    'This screen is the only part of the app we are sure about right now.',
    'Patience is the one feature this screen exists to test.',
];

/** How long each line stays up. */
export const TIP_MS = 3000;

/** The line to show `elapsedMs` into the wait, starting from `start`. Pure. */
export function tipAt(elapsedMs: number, start: number, lines: readonly string[] = LOADING_TIPS): string {
    const n = lines.length;
    if (n === 0) return '';
    const step = Math.max(0, Math.floor(elapsedMs / TIP_MS));
    return lines[(((start + step) % n) + n) % n];
}

/** A random place in the list to begin, so every launch does not open on the same line. */
export function pickTipStart(rng: () => number = Math.random, lines: readonly string[] = LOADING_TIPS): number {
    return lines.length === 0 ? 0 : Math.floor(rng() * lines.length) % lines.length;
}
