import { useCallback, type MutableRefObject } from 'react';
import { planLiveConversion } from '../utils/composerShortcodeTyping';
import { replaceRangeUndoable } from '../utils/composerCaret';
import { getNativeShortcodeIndex, lookupNativeShortcode } from '../utils/nativeEmojiShortcodes';
import { personalEmojis } from '../utils/personalEmoji/service';
import { resolveExactEmoji, type PersonalCandidate, type ServerCandidate } from '../components/composer/emojiSuggestions';

/**
 * Live `:name:` -> emoji conversion in the composer text box.
 *
 * Call the returned function from the textarea's change handler with the new
 * value and caret. When the character just typed is the closing colon of a
 * complete name the viewer can use, it edits the box right there - BEFORE the
 * message is sent - and leaves the caret directly after the result:
 *  - a standard emoji: `:red_heart:` becomes the glyph;
 *  - a server / My Emoji: the box keeps `:name:` (a textarea cannot hold a
 *    picture), canonicalised, and the same wire token picking it from the
 *    autocomplete registers is registered, so it sends as that emoji.
 * What counts as "a name the viewer can use" is resolveExactEmoji - the
 * autocomplete's own candidate rule - so another server's emoji, a My Emoji
 * whose picture is not on this device, or an unknown name is left as typed.
 *
 * The edit is made as a real typing edit (replaceRangeUndoable) so one Ctrl+Z
 * brings the typed `:name:` back; it is deferred one microtask so it never runs
 * inside React's own change handling, and skipped if the box moved meanwhile.
 */
export function useComposerShortcodes(args: {
    serverEmojis: ReadonlyArray<ServerCandidate>;
    myEmojiEntries: ReadonlyArray<PersonalCandidate>;
    emojiTokenMapRef: MutableRefObject<Record<string, string>>;
    setInputText: (v: string) => void;
}) {
    const { serverEmojis, myEmojiEntries, emojiTokenMapRef, setInputText } = args;
    return useCallback((val: string, cursor: number, ta: HTMLTextAreaElement | null): void => {
        if (cursor < 1 || val[cursor - 1] !== ':') return;
        const plan = planLiveConversion(val, cursor, typed => resolveExactEmoji(typed, serverEmojis, myEmojiEntries, {
            availablePersonalIds: new Set(personalEmojis().store.ids()),
            nativeLookup: t => lookupNativeShortcode(getNativeShortcodeIndex(), t),
        }));
        if (!plan) return;
        if (plan.pick) emojiTokenMapRef.current[plan.pick.display] = plan.pick.token;
        if (plan.replacement === val.slice(plan.start, plan.end)) return;
        queueMicrotask(() => {
            // The person kept typing, or moved: leave their text alone.
            if (!ta || ta.value !== val || ta.selectionStart !== cursor || ta.selectionEnd !== cursor) return;
            if (replaceRangeUndoable(ta, plan.start, plan.end, plan.replacement)) return;
            setInputText(val.slice(0, plan.start) + plan.replacement + val.slice(plan.end));
            const pos = plan.start + plan.replacement.length;
            requestAnimationFrame(() => { ta.setSelectionRange(pos, pos); });
        });
    }, [serverEmojis, myEmojiEntries, emojiTokenMapRef, setInputText]);
}
