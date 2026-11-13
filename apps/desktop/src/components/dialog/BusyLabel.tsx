import React from 'react';
import { Loader2 } from 'lucide-react';
import '../../styles/dialog-server.css';

/**
 * Label for a dialog's primary button while its request runs: the label stays,
 * a small spinner sits in front of it, and the button keeps its size (the
 * host ClButton gets `className="dlg-busy"`, which hands the spinner's width
 * back from the button's side padding; size `sm` only).
 *
 * Use it INSTEAD of ClButton's `loading` in a dialog footer (that swaps the
 * label for three dots and animates the depth sheets, which reads as a
 * different button). The caller's submit handler must ignore a second submit
 * while busy, and the footer hint should say what is happening.
 */
export const BusyLabel: React.FC<{ busy: boolean; children: React.ReactNode }> = ({ busy, children }) => (
    <span className="dlg-busy-label">
        {busy && <Loader2 className="dlg-spin" size={12} strokeWidth={2.6} aria-hidden="true" />}
        <span>{children}</span>
    </span>
);

export default BusyLabel;
