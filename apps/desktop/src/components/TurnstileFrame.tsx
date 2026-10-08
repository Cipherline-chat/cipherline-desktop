/**
 * Cloudflare Turnstile, hosted. A Turnstile site key only works on the
 * hostnames registered on the widget, and Cloudflare accepts neither IP
 * addresses nor localhost — but the packaged app is served from
 * http://127.0.0.1:42917, so rendering the widget directly here always failed
 * with error 110200 ("Unable to connect to website").
 *
 * This embeds https://cipherline.chat/turnstile-embed.html (apps/website/public)
 * instead — there the widget's hostname IS cipherline.chat — and receives the
 * token over postMessage. Protocol and origin rules are documented in
 * turnstile-embed.js; the message handling is the pure, tested
 * utils/turnstileFrameProtocol.ts.
 */
import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
    TURNSTILE_EMBED_ORIGIN,
    buildTurnstileEmbedUrl,
    parseTurnstileMessage,
} from '../utils/turnstileFrameProtocol';

export interface TurnstileFrameHandle {
    /** Ask the widget for a fresh challenge (or reload the frame if it never came up). */
    reset: () => void;
}

interface Props {
    siteKey: string;
    onSuccess: (token: string) => void;
    onError: () => void;
    onExpire: () => void;
    ref?: React.Ref<TurnstileFrameHandle>;
}

/** The widget is 300x65 in its normal size. */
const WIDTH = 300;
const HEIGHT = 65;
/** The frame never said "ready" in this long: the website is unreachable (offline, blocked). */
const READY_TIMEOUT_MS = 15_000;

export const TurnstileFrame: React.FC<Props> = ({ siteKey, onSuccess, onError, onExpire, ref }) => {
    const frameRef = useRef<HTMLIFrameElement | null>(null);
    const readyRef = useRef(false);
    const [nonce, setNonce] = useState(0);

    // Latest callbacks without re-subscribing the message listener on every render.
    const cbRef = useRef({ onSuccess, onError, onExpire });
    useEffect(() => { cbRef.current = { onSuccess, onError, onExpire }; });

    const src = buildTurnstileEmbedUrl(siteKey, window.location.origin, 'dark');

    useEffect(() => {
        readyRef.current = false;
        const timer = setTimeout(() => { if (!readyRef.current) cbRef.current.onError(); }, READY_TIMEOUT_MS);
        const onMessage = (e: MessageEvent) => {
            if (e.origin !== TURNSTILE_EMBED_ORIGIN || e.source !== frameRef.current?.contentWindow) return;
            const msg = parseTurnstileMessage(e.data);
            if (!msg) return;
            if (msg.type === 'ready') { readyRef.current = true; clearTimeout(timer); }
            else if (msg.type === 'token') cbRef.current.onSuccess(msg.token);
            else if (msg.type === 'expire') cbRef.current.onExpire();
            else cbRef.current.onError();
        };
        window.addEventListener('message', onMessage);
        return () => { clearTimeout(timer); window.removeEventListener('message', onMessage); };
    }, [nonce, src]);

    const reset = useCallback(() => {
        if (readyRef.current) {
            frameRef.current?.contentWindow?.postMessage(
                { source: 'cl-turnstile-parent', type: 'reset' }, TURNSTILE_EMBED_ORIGIN);
        } else {
            setNonce(n => n + 1); // never came up — reload the frame
        }
    }, []);
    useImperativeHandle(ref, () => ({ reset }), [reset]);

    return (
        <iframe
            key={nonce}
            ref={frameRef}
            src={src}
            title="Human check"
            width={WIDTH}
            height={HEIGHT}
            style={{ border: 0, display: 'block', colorScheme: 'normal' }}
        />
    );
};

export default TurnstileFrame;
