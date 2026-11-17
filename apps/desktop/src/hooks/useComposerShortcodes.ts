import { useCallback, type MutableRefObject } from 'react';
import { planLiveConversion } from '../utils/composerShortcodeTyping';
import { getNativeShortcodeIndex, lookupNativeShortcode } from '../utils/nativeEmojiShortcodes';
import { personalEmojis } from '../utils/personalEmoji/service';
import { resolveExactEmoji, type PersonalCandidate, type ServerCandidate } from '../components/composer/emojiSuggestions';

/** The slice of the composer box (components/composer/RichComposer) this needs. */
export interface ShortcodeEditor {
    getPlain(): string;
    getSelection(): { start: number; end: number };
    replaceRange(start: number, end: number, text: string): void;
}

/**
 * Live `:name:` -> emoji conversion in the composer text box.
 *
 * Call the returned function from the box's change handler with its PLAIN
 * text and caret. When the character just typed is the closing colon of a
 * complete name the viewer can use, it edits the box right there - BEFORE the
 * message is sent - and leaves the caret directly after the result:
 *  - a standard emoji: `:red_heart:` becomes the glyph;
 *  - a server / My Emoji: the box keeps `:name:`, canonicalised, and the same
 *    wire token picking it from the autocomplete registers is registered, so
 *    it sends as that emoji.
 * What counts as "a name the viewer can use" is resolveExactEmoji - the
 * autocomplete's own candidate rule - so another server's emoji, a My Emoji
 * whose picture is not on this device, or an unknown name is left as typed.
 *
 * The edit is its own undo step in the box (RichComposer.replaceRange), so
 * one Ctrl+Z brings the typed `:name:` back; it is deferred one microtask so
 * it never runs inside React's own change handling, and skipped if the box
 * moved meanwhile.
 */
export function useComposerShortcodes(args: {
    serverEmojis: ReadonlyArray<ServerCandidate>;
    myEmojiEntries: ReadonlyArray<PersonalCandidate>;
    emojiTokenMapRef: MutableRefObject<Record<string, string>>;
}) {
    const { serverEmojis, myEmojiEntries, emojiTokenMapRef } = args;
    return useCallback((plain: string, cursor: number, editor: ShortcodeEditor | null): void => {
        if (cursor < 1 || plain[cursor - 1] !== ':') return;
        const plan = planLiveConversion(plain, cursor, typed => resolveExactEmoji(typed, serverEmojis, myEmojiEntries, {
            availablePersonalIds: new Set(personalEmojis().store.ids()),
            nativeLookup: t => lookupNativeShortcode(getNativeShortcodeIndex(), t),
        }));
        if (!plan) return;
        if (plan.pick) emojiTokenMapRef.current[plan.pick.display] = plan.pick.token;
        if (plan.replacement === plain.slice(plan.start, plan.end)) return;
        queueMicrotask(() => {
            // The person kept typing, or moved: leave their text alone.
            if (!editor) return;
            const sel = editor.getSelection();
            if (editor.getPlain() !== plain || sel.start !== cursor || sel.end !== cursor) return;
            editor.replaceRange(plan.start, plan.end, plan.replacement);
        });
    }, [serverEmojis, myEmojiEntries, emojiTokenMapRef]);
}
