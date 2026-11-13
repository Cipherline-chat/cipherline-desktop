/**
 * The call's E2EE worker: LiveKit's own frame-cryptor worker, unchanged, with
 * one stage in front of each SENDER stream that makes an H.264/H.265 frame's
 * Annex-B start codes exactly what the receiver's depacketizer will rebuild —
 * otherwise a 3-byte start code in the clear prefix fails AES-GCM on the
 * receiving side and the frame is silently dropped (keyframe-only video).
 * See utils/e2eeAnnexB.ts. Keys, decryption, data packets: all LiveKit's.
 */

// Importing LiveKit's worker module installs its `onmessage` handler.
import 'livekit-client/e2ee-worker';
import { installAnnexBCanonicalizer } from '../utils/e2eeAnnexB';
import { installNativeInjector } from '../utils/nativeShareWorker';

installAnnexBCanonicalizer(self as unknown as Parameters<typeof installAnnexBCanonicalizer>[0]);
// Native share encoder (CIPHERLINE_NATIVE_SHARE_ENCODER, off by default). Outermost wrapper so its stage runs BEFORE the
// canonicalizer and the cryptor; inert (pure pass-through) unless the page binds a native session with `cl:native-share`.
installNativeInjector(self as unknown as Parameters<typeof installNativeInjector>[0]);
