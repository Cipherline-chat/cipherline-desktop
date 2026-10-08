/**
 * audio_capture_mac.mm — ScreenCaptureKit per-app / system audio capture (macOS)
 *
 * The macOS counterpart of audio_capture.cc (WASAPI). It is built as the SAME
 * addon name (`audio_capture`) with the SAME JS surface, so electron/main.ts,
 * the preload bridge and the renderer's native-audio path (SidebarConference's
 * startNativeWindowAudio) run unchanged on both platforms:
 *
 *   isSupported(): boolean
 *       true on macOS 13+ (ScreenCaptureKit audio). Absent on the Windows
 *       addon, where main.ts treats "loaded" as "supported".
 *   getPidFromSourceId(sourceId: string): number | null
 *       'window:<CGWindowID>:<n>' -> the owning application's PID.
 *       Screens (and anything unparseable) -> null.
 *   startCapture(pid, mode: 'include' | 'exclude', callback): void
 *       include : audio of the application tree rooted at `pid` ONLY
 *                 (single-window share -> that app's sound).
 *       exclude : all system audio EXCEPT the application tree rooted at `pid`
 *                 (full-screen share, pid = Cipherline -> no call echo).
 *       callback receives, on the Node main thread, one of
 *         { sampleRate, channels: 2, data: Buffer }  float32 interleaved PCM
 *         { processExited: true }                    include-target quit (terminal)
 *         { failed: true, reason, message }          could not start / died (terminal)
 *   stopCapture(): void
 *
 * Why a PROCESS TREE and not a single PID: Chromium/Electron apps play sound
 * from a helper (audio service) process, not the main app process. Selecting
 * only the root would capture silence from a browser or Electron app and —
 * worse for exclude — would fail to exclude Cipherline's own call audio.
 *
 * Capture needs the Screen Recording permission (same TCC entry as the video
 * capture); without it ScreenCaptureKit reports -3801 and we surface
 * reason='permission'.
 *
 * Raw N-API (node_api.h), like the Windows addon — no node-addon-api.
 */

#include <node_api.h>

#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreMedia/CoreMedia.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>

#include <libproc.h>
#include <signal.h>
#include <sys/proc_info.h>

#include <atomic>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

// ────────────────────────────────────────────────────────────────────────────
// Chunk handed from the capture queue to the Node main thread
// ────────────────────────────────────────────────────────────────────────────

enum class ChunkKind { Audio, Exited, Failed };

struct Chunk {
    ChunkKind kind = ChunkKind::Audio;
    uint32_t sampleRate = 48000;
    uint32_t channels = 2;
    std::vector<float> samples;   // interleaved, Audio only
    std::string reason;           // Failed only
    std::string message;          // Failed only
};

// One capture session. Every async completion holds a shared_ptr to ITS session
// and checks `alive` under the lock, so a late callback from a stream that was
// already stopped (or replaced by a newer startCapture) can never reach a
// released threadsafe function.
struct Session {
    std::mutex m;
    napi_threadsafe_function tsfn = nullptr;   // guarded by m
    bool alive = true;                         // guarded by m
    bool terminalSent = false;                 // guarded by m
    SCStream* stream = nil;                    // guarded by m
    // SCStream holds its output/delegate weakly. The session owns it for the
    // capture's lifetime and CloseSession drops it (the output points back at
    // the session, so leaving it set would be a retain cycle).
    id output = nil;                           // guarded by m
    dispatch_source_t exitTimer = nil;         // guarded by m
};

static std::mutex g_currentMutex;
static std::shared_ptr<Session> g_current;

static void Emit(const std::shared_ptr<Session>& s, Chunk* c, bool terminal) {
    std::lock_guard<std::mutex> l(s->m);
    if (!s->alive || !s->tsfn || (terminal && s->terminalSent)) { delete c; return; }
    if (terminal) s->terminalSent = true;
    if (napi_call_threadsafe_function(s->tsfn, c, napi_tsfn_nonblocking) != napi_ok) delete c;
}

static void EmitFailed(const std::shared_ptr<Session>& s, const char* reason, const std::string& message) {
    Chunk* c = new Chunk();
    c->kind = ChunkKind::Failed;
    c->reason = reason;
    c->message = message;
    Emit(s, c, true);
}

// Tear a session down: stop delivering, release the tsfn, stop the stream.
// Never blocks (ScreenCaptureKit's stop completion is async and not needed).
static void CloseSession(const std::shared_ptr<Session>& s) {
    SCStream* stream = nil;
    dispatch_source_t timer = nil;
    {
        std::lock_guard<std::mutex> l(s->m);
        if (!s->alive) return;
        s->alive = false;
        if (s->tsfn) {
            napi_release_threadsafe_function(s->tsfn, napi_tsfn_release);
            s->tsfn = nullptr;
        }
        stream = s->stream;
        s->stream = nil;
        s->output = nil;
        timer = s->exitTimer;
        s->exitTimer = nil;
    }
    if (timer) dispatch_source_cancel(timer);
    if (stream) {
        // Keep the stream alive until its stop completes.
        [stream stopCaptureWithCompletionHandler:^(NSError* _Nullable) { (void)stream; }];
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Process tree
// ────────────────────────────────────────────────────────────────────────────

// `root` and every transitive child. Chromium/Electron apps spread their audio
// across helper processes, so "the app" is the whole tree.
static std::set<pid_t> ProcessTree(pid_t root) {
    std::set<pid_t> tree;
    tree.insert(root);

    int count = proc_listallpids(nullptr, 0);
    if (count <= 0) return tree;
    std::vector<pid_t> pids((size_t)count + 64);
    count = proc_listallpids(pids.data(), (int)(pids.size() * sizeof(pid_t)));
    if (count <= 0) return tree;

    std::multimap<pid_t, pid_t> children;   // ppid -> pid
    for (int i = 0; i < count; i++) {
        struct proc_bsdinfo info;
        if (proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)) continue;
        children.emplace((pid_t)info.pbi_ppid, pids[i]);
    }

    std::vector<pid_t> queue{root};
    while (!queue.empty()) {
        pid_t p = queue.back();
        queue.pop_back();
        auto range = children.equal_range(p);
        for (auto it = range.first; it != range.second; ++it) {
            if (tree.insert(it->second).second) queue.push_back(it->second);
        }
    }
    return tree;
}

// ────────────────────────────────────────────────────────────────────────────
// ScreenCaptureKit sample -> interleaved float32 stereo
// ────────────────────────────────────────────────────────────────────────────

static Chunk* ConvertSample(CMSampleBufferRef sb) {
    if (!CMSampleBufferDataIsReady(sb)) return nullptr;
    CMFormatDescriptionRef fd = CMSampleBufferGetFormatDescription(sb);
    if (!fd) return nullptr;
    const AudioStreamBasicDescription* asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd);
    if (!asbd || asbd->mFormatID != kAudioFormatLinearPCM) return nullptr;
    // ScreenCaptureKit delivers 32-bit float. Anything else is dropped rather
    // than guessed at (a wrong sample format is loud noise, not silence).
    if (!(asbd->mFormatFlags & kAudioFormatFlagIsFloat) || asbd->mBitsPerChannel != 32) return nullptr;

    const bool nonInterleaved = (asbd->mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;
    const UInt32 srcChannels = asbd->mChannelsPerFrame;
    const CMItemCount frames = CMSampleBufferGetNumSamples(sb);
    if (srcChannels == 0 || frames <= 0) return nullptr;

    size_t listSize = 0;
    if (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, &listSize, nullptr, 0, nullptr, nullptr, 0, nullptr) != noErr || listSize == 0) {
        return nullptr;
    }
    std::vector<uint8_t> storage(listSize);
    AudioBufferList* abl = reinterpret_cast<AudioBufferList*>(storage.data());
    CMBlockBufferRef block = nullptr;
    if (CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb, nullptr, abl, listSize, nullptr, nullptr,
            kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &block) != noErr) {
        return nullptr;
    }

    Chunk* out = new Chunk();
    out->sampleRate = (uint32_t)asbd->mSampleRate;
    out->channels = 2;
    out->samples.assign((size_t)frames * 2, 0.0f);
    float* dst = out->samples.data();

    bool ok = true;
    if (nonInterleaved) {
        // One mono buffer per channel.
        if (abl->mNumberBuffers < 1) ok = false;
        for (CMItemCount f = 0; ok && f < frames; f++) {
            const float* l = (const float*)abl->mBuffers[0].mData;
            const float* r = abl->mNumberBuffers > 1 ? (const float*)abl->mBuffers[1].mData : l;
            if (!l || !r || (size_t)(f + 1) * sizeof(float) > abl->mBuffers[0].mDataByteSize) { ok = false; break; }
            dst[f * 2]     = l[f];
            dst[f * 2 + 1] = r[f];
        }
    } else {
        // One buffer, channels interleaved.
        if (abl->mNumberBuffers < 1 || !abl->mBuffers[0].mData) ok = false;
        const float* src = ok ? (const float*)abl->mBuffers[0].mData : nullptr;
        if (ok && (size_t)frames * srcChannels * sizeof(float) > abl->mBuffers[0].mDataByteSize) ok = false;
        for (CMItemCount f = 0; ok && f < frames; f++) {
            dst[f * 2]     = src[f * srcChannels];
            dst[f * 2 + 1] = srcChannels > 1 ? src[f * srcChannels + 1] : src[f * srcChannels];
        }
    }
    if (block) CFRelease(block);
    if (!ok) { delete out; return nullptr; }
    return out;
}

// ────────────────────────────────────────────────────────────────────────────
// SCStream output + delegate
// ────────────────────────────────────────────────────────────────────────────

API_AVAILABLE(macos(13.0))
@interface CLAudioOutput : NSObject <SCStreamOutput, SCStreamDelegate> {
    std::shared_ptr<Session> _session;
}
- (instancetype)initWithSession:(std::shared_ptr<Session>)session;
@end

@implementation CLAudioOutput
- (instancetype)initWithSession:(std::shared_ptr<Session>)session {
    if ((self = [super init])) _session = session;
    return self;
}

- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) return;   // the 2x2 video is never used
    Chunk* c = ConvertSample(sampleBuffer);
    if (c) Emit(_session, c, false);
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    // User hit the system "Stop sharing" control, permission was revoked, or the
    // display went away. Terminal: tell the app so it tears the audio track down.
    EmitFailed(_session, "stopped", error ? std::string([[error localizedDescription] UTF8String] ?: "") : "");
}
@end

// ────────────────────────────────────────────────────────────────────────────
// TSFN -> JS (Node main thread)
// ────────────────────────────────────────────────────────────────────────────

static void CallJsCallback(napi_env env, napi_value js_cb, void* /*ctx*/, void* data) {
    Chunk* c = static_cast<Chunk*>(data);
    if (!c) return;
    if (env) {
        napi_value obj;
        napi_create_object(env, &obj);
        napi_value v;
        switch (c->kind) {
            case ChunkKind::Exited:
                napi_get_boolean(env, true, &v);
                napi_set_named_property(env, obj, "processExited", v);
                break;
            case ChunkKind::Failed:
                napi_get_boolean(env, true, &v);
                napi_set_named_property(env, obj, "failed", v);
                napi_create_string_utf8(env, c->reason.c_str(), NAPI_AUTO_LENGTH, &v);
                napi_set_named_property(env, obj, "reason", v);
                napi_create_string_utf8(env, c->message.c_str(), NAPI_AUTO_LENGTH, &v);
                napi_set_named_property(env, obj, "message", v);
                break;
            case ChunkKind::Audio:
                napi_create_uint32(env, c->sampleRate, &v);
                napi_set_named_property(env, obj, "sampleRate", v);
                napi_create_uint32(env, c->channels, &v);
                napi_set_named_property(env, obj, "channels", v);
                napi_create_buffer_copy(env, c->samples.size() * sizeof(float), c->samples.data(), nullptr, &v);
                napi_set_named_property(env, obj, "data", v);
                break;
        }
        napi_value undef;
        napi_get_undefined(env, &undef);
        napi_value args[] = { obj };
        napi_call_function(env, undef, js_cb, 1, args, nullptr);
    }
    delete c;
}

// ────────────────────────────────────────────────────────────────────────────
// Capture start
// ────────────────────────────────────────────────────────────────────────────

static bool IsSupported() {
    if (@available(macOS 13.0, *)) return true;
    return false;
}

API_AVAILABLE(macos(13.0))
// `session` is taken BY VALUE on purpose: the blocks below outlive this call, and
// a block captures a C++ reference as a reference — to a caller's temporary that
// is long gone by the time ScreenCaptureKit invokes the completion handler. By
// value, each block copies the shared_ptr and keeps the session alive.
static void BeginCapture(std::shared_ptr<Session> session, pid_t rootPid, bool exclude) {
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                              onScreenWindowsOnly:NO
                                                completionHandler:^(SCShareableContent* _Nullable content, NSError* _Nullable error) {
        {
            std::lock_guard<std::mutex> l(session->m);
            if (!session->alive) return;
        }
        if (error || !content) {
            // -3801 = SCStreamErrorUserDeclined: Screen Recording not granted.
            const bool denied = error && error.code == -3801;
            EmitFailed(session, denied ? "permission" : "error",
                       error ? std::string([[error localizedDescription] UTF8String] ?: "") : "no shareable content");
            return;
        }

        const std::set<pid_t> tree = ProcessTree(rootPid);
        NSMutableArray<SCRunningApplication*>* apps = [NSMutableArray array];
        for (SCRunningApplication* app in content.applications) {
            if (tree.count((pid_t)app.processID)) [apps addObject:app];
        }
        if (!exclude && apps.count == 0) {
            EmitFailed(session, "no-target", "the shared application is not available to ScreenCaptureKit");
            return;
        }

        // Audio is not tied to a display, but a filter needs one.
        SCDisplay* display = nil;
        const CGDirectDisplayID mainId = CGMainDisplayID();
        for (SCDisplay* d in content.displays) {
            if (d.displayID == mainId) { display = d; break; }
        }
        if (!display) display = content.displays.firstObject;
        if (!display) {
            EmitFailed(session, "error", "no display available");
            return;
        }

        SCContentFilter* filter = exclude
            ? [[SCContentFilter alloc] initWithDisplay:display excludingApplications:apps exceptingWindows:@[]]
            : [[SCContentFilter alloc] initWithDisplay:display includingApplications:apps exceptingWindows:@[]];

        SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
        config.capturesAudio = YES;
        config.sampleRate = 48000;
        config.channelCount = 2;
        // Belt and braces for exclude: the tree above covers helper processes,
        // this covers the case where the root itself was not enumerated.
        config.excludesCurrentProcessAudio = exclude ? YES : NO;
        // The video half is unused — make it as cheap as ScreenCaptureKit allows.
        config.width = 2;
        config.height = 2;
        config.minimumFrameInterval = CMTimeMake(1, 2);
        config.showsCursor = NO;
        config.queueDepth = 3;

        CLAudioOutput* output = [[CLAudioOutput alloc] initWithSession:session];
        SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];

        dispatch_queue_t queue = dispatch_queue_create("chat.cipherline.audio-capture", DISPATCH_QUEUE_SERIAL);
        NSError* addErr = nil;
        if (![stream addStreamOutput:output type:SCStreamOutputTypeAudio sampleHandlerQueue:queue error:&addErr]) {
            EmitFailed(session, "error", addErr ? std::string([[addErr localizedDescription] UTF8String] ?: "") : "addStreamOutput failed");
            return;
        }
        // A no-op screen output stops ScreenCaptureKit logging a dropped-frame
        // error per video frame. Best effort — failure here is harmless.
        [stream addStreamOutput:output type:SCStreamOutputTypeScreen sampleHandlerQueue:queue error:nil];

        {
            std::lock_guard<std::mutex> l(session->m);
            if (!session->alive) return;
            session->stream = stream;
            session->output = output;
        }

        [stream startCaptureWithCompletionHandler:^(NSError* _Nullable startErr) {
            if (startErr) {
                const bool denied = startErr.code == -3801;
                EmitFailed(session, denied ? "permission" : "error",
                           std::string([[startErr localizedDescription] UTF8String] ?: ""));
            }
        }];

        // include mode: a quit target is not an error ScreenCaptureKit reports —
        // the stream just goes silent. Poll the root so the app can say so
        // (mirrors the Windows addon's IsProcessAlive).
        if (!exclude) {
            dispatch_source_t timer = dispatch_source_create(
                DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
            dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
                                      NSEC_PER_SEC, NSEC_PER_SEC / 10);
            dispatch_source_set_event_handler(timer, ^{
                if (kill(rootPid, 0) == -1 && errno == ESRCH) {
                    Chunk* c = new Chunk();
                    c->kind = ChunkKind::Exited;
                    Emit(session, c, true);
                }
            });
            {
                std::lock_guard<std::mutex> l(session->m);
                if (session->alive) session->exitTimer = timer;
                else { dispatch_source_cancel(timer); return; }
            }
            dispatch_resume(timer);
        }
    }];
}

// ────────────────────────────────────────────────────────────────────────────
// N-API surface
// ────────────────────────────────────────────────────────────────────────────

static napi_value NullValue(napi_env env) {
    napi_value r; napi_get_null(env, &r); return r;
}

static napi_value IsSupportedFn(napi_env env, napi_callback_info) {
    napi_value r; napi_get_boolean(env, IsSupported(), &r); return r;
}

static napi_value GetPidFromSourceId(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc < 1) return NullValue(env);

    char buf[128] = {};
    size_t len = 0;
    if (napi_get_value_string_utf8(env, args[0], buf, sizeof(buf), &len) != napi_ok) return NullValue(env);

    // 'window:<CGWindowID>:<n>'
    if (strncmp(buf, "window:", 7) != 0) return NullValue(env);
    char* end = nullptr;
    unsigned long long wid = strtoull(buf + 7, &end, 10);
    if (end == buf + 7 || wid == 0 || wid > 0xFFFFFFFFull) return NullValue(env);

    CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, (CGWindowID)wid);
    if (!list) return NullValue(env);
    pid_t pid = 0;
    if (CFArrayGetCount(list) > 0) {
        CFDictionaryRef d = (CFDictionaryRef)CFArrayGetValueAtIndex(list, 0);
        CFNumberRef n = (CFNumberRef)CFDictionaryGetValue(d, kCGWindowOwnerPID);
        int v = 0;
        if (n && CFNumberGetValue(n, kCFNumberIntType, &v) && v > 0) pid = (pid_t)v;
    }
    CFRelease(list);
    if (pid <= 0) return NullValue(env);

    napi_value r;
    napi_create_uint32(env, (uint32_t)pid, &r);
    return r;
}

static napi_value StartCapture(napi_env env, napi_callback_info info) {
    napi_value undef;
    napi_get_undefined(env, &undef);

    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc < 3) return undef;

    uint32_t pid = 0;
    napi_get_value_uint32(env, args[0], &pid);
    char modeBuf[16] = {};
    size_t modeLen = 0;
    napi_get_value_string_utf8(env, args[1], modeBuf, sizeof(modeBuf), &modeLen);
    const bool exclude = strcmp(modeBuf, "exclude") == 0;

    // Replace any capture already running.
    std::shared_ptr<Session> previous;
    {
        std::lock_guard<std::mutex> l(g_currentMutex);
        previous = g_current;
        g_current.reset();
    }
    if (previous) CloseSession(previous);

    auto session = std::make_shared<Session>();
    napi_value name;
    napi_create_string_utf8(env, "AudioCapture", NAPI_AUTO_LENGTH, &name);
    if (napi_create_threadsafe_function(env, args[2], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                        CallJsCallback, &session->tsfn) != napi_ok) {
        return undef;
    }
    {
        std::lock_guard<std::mutex> l(g_currentMutex);
        g_current = session;
    }

    if (@available(macOS 13.0, *)) {
        BeginCapture(session, (pid_t)pid, exclude);
    } else {
        EmitFailed(session, "unsupported", "System audio capture needs macOS 13 or later");
    }
    return undef;
}

static napi_value StopCapture(napi_env env, napi_callback_info) {
    std::shared_ptr<Session> s;
    {
        std::lock_guard<std::mutex> l(g_currentMutex);
        s = g_current;
        g_current.reset();
    }
    if (s) CloseSession(s);
    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

// window_geometry_mac.mm — the annotation overlay's window geometry, linked
// into this addon so there is one native module to build and ship.
void RegisterWindowGeometry(napi_env env, napi_value exports);

static napi_value Init(napi_env env, napi_value exports) {
    napi_value fn;

    napi_create_function(env, nullptr, 0, IsSupportedFn, nullptr, &fn);
    napi_set_named_property(env, exports, "isSupported", fn);

    napi_create_function(env, nullptr, 0, GetPidFromSourceId, nullptr, &fn);
    napi_set_named_property(env, exports, "getPidFromSourceId", fn);

    napi_create_function(env, nullptr, 0, StartCapture, nullptr, &fn);
    napi_set_named_property(env, exports, "startCapture", fn);

    napi_create_function(env, nullptr, 0, StopCapture, nullptr, &fn);
    napi_set_named_property(env, exports, "stopCapture", fn);

    RegisterWindowGeometry(env, exports);
    return exports;
}

NAPI_MODULE(audio_capture, Init)
