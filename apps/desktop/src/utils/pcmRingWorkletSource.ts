/**
 * AudioWorklet source for the native screen-share system-audio path
 * (SidebarConference → WASAPI addon chunks → this ring → MediaStreamDestination
 * → the published ScreenShareAudio track). Moved here verbatim from an inline
 * string in SidebarConference so it can be unit-tested, plus ONE behaviour
 * change: latency trim.
 *
 * ── Why the trim (A/V sync, 2026-10) ────────────────────────────────────────
 * The ring was 2 s deep and only ever dropped audio on OVERFLOW. Its latency
 * is "whatever is buffered", and nothing ever brought that back down: any
 * main-thread stall (chunks arrive over IPC → main thread → postMessage) or
 * a capture clock running slightly fast queued audio that then stayed queued
 * for the rest of the share — screen-share audio ratcheting later and later
 * behind the screen video, up to the 2 s ring size. Underruns, the only
 * other correction, go the other way (re-prime, 40 ms).
 *
 * Now the processor tracks the MINIMUM fill over each ~1 s window — the
 * cushion that was never needed, which the render thread's own bursty pulls
 * (a 'playback' latency-hint context renders several quanta back-to-back)
 * can't fake — and if even that minimum exceeds TRIM_ABOVE_MS it drops the
 * oldest frames down to the normal prebuffer. A steady stream is untouched;
 * a stalled-then-flushed one costs a single skip instead of permanent delay.
 */

/** Prebuffer before playback starts (unchanged from the inline original). */
export const PCM_RING_PREBUFFER_MS = 40;
/** Trim when the window's minimum fill is above this … */
export const PCM_RING_TRIM_ABOVE_MS = 80;
/** … back down to this (the prebuffer). */
export const PCM_RING_TRIM_TO_MS = PCM_RING_PREBUFFER_MS;
/** Minimum-fill window, in seconds. */
export const PCM_RING_WINDOW_S = 1;

export const PCM_RING_WORKLET_SOURCE = `
    class PCMRingProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.channels = 2;
            // 2 seconds of headroom at 48 kHz — absorbs IPC jitter comfortably.
            this.ringSize = 48000 * 2;
            this.ring = [new Float32Array(this.ringSize), new Float32Array(this.ringSize)];
            this.writeIdx = 0;
            this.readIdx = 0;
            this.available = 0;
            this.started = false;
            // Keep ~40 ms prebuffered before we start pulling so small bursts of
            // IPC jitter don't cause immediate underruns at the very start.
            this.prebufferFrames = Math.floor(sampleRate * ${PCM_RING_PREBUFFER_MS / 1000});
            // Latency trim (see pcmRingWorkletSource.ts): minimum fill per window.
            this.trimAboveFrames = Math.floor(sampleRate * ${PCM_RING_TRIM_ABOVE_MS / 1000});
            this.trimToFrames = Math.floor(sampleRate * ${PCM_RING_TRIM_TO_MS / 1000});
            this.windowFrames = Math.floor(sampleRate * ${PCM_RING_WINDOW_S});
            this.windowElapsed = 0;
            this.windowMin = Infinity;
            this.trimmedFrames = 0;
            this.trims = 0;

            this.port.onmessage = (e) => {
                const d = e.data;
                if (!d || d.type !== 'pcm') return;
                const interleaved = d.pcm;
                const ch = d.channels || 2;
                const frames = (interleaved.length / ch) | 0;
                if (frames <= 0) return;

                // If we would overflow, drop the oldest frames — bound latency.
                if (this.available + frames > this.ringSize) {
                    const toDrop = (this.available + frames) - this.ringSize;
                    this.readIdx = (this.readIdx + toDrop) % this.ringSize;
                    this.available -= toDrop;
                }

                // De-interleave into per-channel ring slots.
                let w = this.writeIdx;
                for (let f = 0; f < frames; f++) {
                    this.ring[0][w] = interleaved[f * ch];
                    this.ring[1][w] = ch > 1 ? interleaved[f * ch + 1] : interleaved[f * ch];
                    w = (w + 1) % this.ringSize;
                }
                this.writeIdx = w;
                this.available += frames;
            };
        }

        _trackWindow(outFrames) {
            // Fill level at the START of this pull, i.e. before consuming.
            if (this.available < this.windowMin) this.windowMin = this.available;
            this.windowElapsed += outFrames;
            if (this.windowElapsed < this.windowFrames) return;
            if (this.started && this.windowMin > this.trimAboveFrames) {
                const toDrop = this.windowMin - this.trimToFrames;
                this.readIdx = (this.readIdx + toDrop) % this.ringSize;
                this.available -= toDrop;
                this.trimmedFrames += toDrop;
                this.trims++;
                this.port.postMessage({ type: 'trim', droppedMs: (toDrop / sampleRate) * 1000, trims: this.trims });
            }
            this.windowElapsed = 0;
            this.windowMin = Infinity;
        }

        process(_inputs, outputs) {
            const out = outputs[0];
            const outFrames = out[0].length;
            const outChannels = out.length;

            // Gate on prebuffer — silence until we have enough cushion.
            if (!this.started) {
                if (this.available < this.prebufferFrames) {
                    for (let c = 0; c < outChannels; c++) out[c].fill(0);
                    return true;
                }
                this.started = true;
                this.windowElapsed = 0;
                this.windowMin = Infinity;
            }

            this._trackWindow(outFrames);

            if (this.available < outFrames) {
                // Underrun: emit silence for this block, re-arm prebuffer so we
                // rebuild cushion before resuming playback (prevents stutter loops).
                for (let c = 0; c < outChannels; c++) out[c].fill(0);
                this.started = false;
                return true;
            }

            let r = this.readIdx;
            for (let f = 0; f < outFrames; f++) {
                out[0][f] = this.ring[0][r];
                if (outChannels > 1) out[1][f] = this.ring[1][r];
                r = (r + 1) % this.ringSize;
            }
            this.readIdx = r;
            this.available -= outFrames;
            return true;
        }
    }
    registerProcessor('pcm-ring', PCMRingProcessor);
`;
