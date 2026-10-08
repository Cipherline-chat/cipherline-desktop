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

installAnnexBCanonicalizer(self as unknown as Parameters<typeof installAnnexBCanonicalizer>[0]);
