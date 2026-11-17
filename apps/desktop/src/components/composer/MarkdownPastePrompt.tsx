/**
 * The one prompt a paste can get (utils/formatting/codePaste.ts pastePromptFor):
 *  - Markdown from elsewhere: "Paste as formatted text?" (markdownPaste.ts);
 *  - source code / a log / a trace: "Paste as a code block?" (codePaste.ts).
 * The paste has ALREADY
 * gone in as typed; Format swaps that exact range for the converted text (as
 * an undoable edit), Keep as plain just dismisses. Escape = keep as plain.
 *
 * It never takes focus (the person is mid-typing); it announces itself
 * politely and its buttons are ordinary tab stops.
 */
import React from 'react';
import { SquareCode, WandSparkles } from 'lucide-react';
import { useEscape } from '../../hooks/useEscape';
import '../../styles/formatting.css';

export interface MarkdownPastePromptProps {
    onFormat: () => void;
    onKeep: () => void;
    /** Which offer this is (default Markdown). */
    kind?: 'markdown' | 'code';
    /** Code: the detected fence language, shown when known. */
    lang?: string | null;
}

export const MarkdownPastePrompt: React.FC<MarkdownPastePromptProps> = ({ onFormat, onKeep, kind = 'markdown', lang }) => {
    useEscape(() => { onKeep(); });
    const code = kind === 'code';
    return (
        <div className="fmt-paste" role="group" aria-label={code ? 'Pasted code' : 'Pasted Markdown'} data-md-paste-prompt="" data-kind={kind}>
            {code
                ? <SquareCode size={16} strokeWidth={2.2} className="fmt-paste-ico" aria-hidden="true" />
                : <WandSparkles size={16} strokeWidth={2.2} className="fmt-paste-ico" aria-hidden="true" />}
            <span className="fmt-paste-text" aria-live="polite">
                {code ? 'Paste as a code block?' : 'Paste as formatted text?'}
                <small>
                    {code
                        ? `That looked like ${lang ? `${lang} ` : ''}code. A code block keeps it monospaced, highlighted and exact.`
                        : 'That looked like Markdown. We can convert it to chat formatting.'}
                </small>
            </span>
            <button type="button" className="fmt-paste-btn fmt-paste-btn--go" onMouseDown={(e) => e.preventDefault()} onClick={onFormat}>Format</button>
            <button type="button" className="fmt-paste-btn" onMouseDown={(e) => e.preventDefault()} onClick={onKeep}>Keep as plain</button>
        </div>
    );
};

export default MarkdownPastePrompt;
