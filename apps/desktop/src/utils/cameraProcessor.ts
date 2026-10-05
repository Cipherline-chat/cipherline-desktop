/**
 * Cipherline Camera Processor — LiveKit TrackProcessor for video.
 *
 * Applies brightness / contrast / saturation adjustments to the camera track
 * in real-time using a canvas render loop with CSS filter syntax.
 *
 * Pipeline:
 *   Raw camera track → hidden <video> decoder
 *     → requestAnimationFrame loop → CanvasRenderingContext2D.filter → <canvas>
 *     → canvas.captureStream(30) → processedTrack → LiveKit publisher
 *
 * All picture settings are updatable in real-time without restarting.
 */

export interface CameraPictureSettings {
    cameraBrightness: number;  // 0-200, default 100 (CSS %)
    cameraContrast: number;    // 0-200, default 100
    cameraSaturation: number;  // 0-200, default 100
}

export class CipherlineCameraProcessor {
    // LiveKit TrackProcessor interface
    readonly name = 'cipherline-camera-processor';
    processedTrack?: MediaStreamTrack;

    private videoEl?: HTMLVideoElement;
    private canvas?: HTMLCanvasElement;
    private ctx2d?: CanvasRenderingContext2D;
    private animId?: number;
    private _settings: CameraPictureSettings;
    private _onError?: (message: string) => void;

    constructor(settings: CameraPictureSettings, onError?: (message: string) => void) {
        this._settings = { ...settings };
        this._onError = onError;
    }

    // ── LiveKit TrackProcessor interface ──────────────────────────────────

    async init(opts: { track: MediaStreamTrack; kind?: string }) {
        const { track } = opts;
        const trackCfg = track.getSettings();
        const w = trackCfg.width  || 1280;
        const h = trackCfg.height || 720;

        // Hidden video element to decode the incoming camera track.
        // Appended to body so it can autoplay without a user gesture.
        this.videoEl = document.createElement('video');
        this.videoEl.srcObject = new MediaStream([track]);
        this.videoEl.muted = true;
        this.videoEl.autoplay = true;
        this.videoEl.playsInline = true;
        this.videoEl.style.cssText = 'position:fixed;width:1px;height:1px;top:0;left:0;opacity:0;pointer-events:none;';
        document.body.appendChild(this.videoEl);
        // Previously a silent `.catch(() => {})` — a play() rejection here
        // means the hidden decoder <video> never starts, so the render loop's
        // readyState check permanently fails and the "processed" track we
        // publish is just frozen/black forever, with no signal to the user
        // that their camera picture settings broke the whole video track.
        await this.videoEl.play().catch((err) => {
            console.warn('[CameraProcessor] video.play() failed:', err);
            this._onError?.('Camera picture effects failed to start — try turning your camera off and on.');
        });

        // Canvas for frame composition
        this.canvas = document.createElement('canvas');
        this.canvas.width  = w;
        this.canvas.height = h;
        this.ctx2d = this.canvas.getContext('2d') ?? undefined;

        // Grab the output track before starting the loop so LiveKit can
        // subscribe to it immediately.
        this.processedTrack = (this.canvas as HTMLCanvasElement & {
            captureStream(fps?: number): MediaStream;
        }).captureStream(30).getVideoTracks()[0];

        this.startLoop();
        console.log('[CameraProcessor] Initialized', w, 'x', h);
    }

    async restart(opts: { track: MediaStreamTrack; kind?: string }) {
        await this.destroy();
        await this.init(opts);
    }

    async destroy() {
        if (this.animId !== undefined) {
            cancelAnimationFrame(this.animId);
            this.animId = undefined;
        }
        if (this.videoEl) {
            this.videoEl.srcObject = null;
            this.videoEl.remove();
            this.videoEl = undefined;
        }
        this.canvas  = undefined;
        this.ctx2d   = undefined;
        this.processedTrack = undefined;
        console.log('[CameraProcessor] Destroyed');
    }

    // ── Settings update (no restart needed) ──────────────────────────────

    updateSettings(settings: CameraPictureSettings) {
        this._settings = { ...settings };
        // The loop reads _settings on every frame, so it takes effect next tick.
    }

    // ── Render loop ───────────────────────────────────────────────────────

    private buildFilter(): string {
        const { cameraBrightness, cameraContrast, cameraSaturation } = this._settings;
        return `brightness(${cameraBrightness}%) contrast(${cameraContrast}%) saturate(${cameraSaturation}%)`;
    }

    private startLoop() {
        const loop = () => {
            if (this.ctx2d && this.videoEl && this.canvas &&
                this.videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                this.ctx2d.filter = this.buildFilter();
                this.ctx2d.drawImage(this.videoEl, 0, 0, this.canvas.width, this.canvas.height);
            }
            this.animId = requestAnimationFrame(loop);
        };
        this.animId = requestAnimationFrame(loop);
    }
}

/** Returns true if picture settings are at their defaults (no processing needed). */
export function isCameraProcessingNeeded(s: CameraPictureSettings): boolean {
    return s.cameraBrightness !== 100 || s.cameraContrast !== 100 || s.cameraSaturation !== 100;
}
