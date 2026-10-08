/**
 * audio_capture.cc — Native WASAPI per-process audio capture addon
 *
 * Uses raw N-API (node_api.h) for ABI stability — no node-addon-api C++ wrappers.
 * Windows only. On other platforms all exports return null/undefined stubs.
 *
 * Exports:
 *   getPidFromSourceId(sourceId: string): number | null
 *   startCapture(pid: number, callback: Function): void
 *   stopCapture(): void
 *   + getScreenRectFromDeviceIndex / getWindowInfo / placeOverlayAbove
 *     (window_geometry.cc — annotation overlay geometry)
 *
 * Requires Windows 10 2004 (build 19041+) for AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK.
 */

#include <node_api.h>

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <combaseapi.h>
#include <propidl.h>
#include <ks.h>
#include <ksmedia.h>
#include <tlhelp32.h>

#include <string>
#include <thread>
#include <atomic>
#include <vector>
#include <cstring>
#include <cstdlib>
#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <stdint.h>

// ────────────────────────────────────────────────────────────────────────────
// Manual definitions for ApplicationLoopback (Win 10 2004+ SDK may not be present)
// ────────────────────────────────────────────────────────────────────────────

#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

typedef enum AC_ACTIVATION_TYPE {
    AC_ACTIVATION_TYPE_DEFAULT          = 0,
    AC_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AC_ACTIVATION_TYPE;

typedef enum AC_LOOPBACK_MODE {
    AC_LOOPBACK_INCLUDE = 0,
    AC_LOOPBACK_EXCLUDE = 1
} AC_LOOPBACK_MODE;

typedef struct AC_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    AC_LOOPBACK_MODE ProcessLoopbackMode;
} AC_PROCESS_LOOPBACK_PARAMS;

typedef struct AC_ACTIVATION_PARAMS {
    AC_ACTIVATION_TYPE ActivationType;
    union {
        AC_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
} AC_ACTIVATION_PARAMS;

// ────────────────────────────────────────────────────────────────────────────
// Async activation completion handler
// ────────────────────────────────────────────────────────────────────────────

struct CompletionHandler : public IActivateAudioInterfaceCompletionHandler {
    volatile LONG m_ref    = 1;
    HANDLE        m_done;
    IAudioClient* m_client = nullptr;
    HRESULT       m_hr     = E_FAIL;

    CompletionHandler() { m_done = CreateEvent(nullptr, FALSE, FALSE, nullptr); }
    ~CompletionHandler() { if (m_done) CloseHandle(m_done); }

    HRESULT STDMETHODCALLTYPE ActivateCompleted(
            IActivateAudioInterfaceAsyncOperation* op) override {
        IUnknown* unk = nullptr;
        op->GetActivateResult(&m_hr, &unk);
        if (SUCCEEDED(m_hr) && unk) {
            unk->QueryInterface(__uuidof(IAudioClient), (void**)&m_client);
            unk->Release();
        }
        SetEvent(m_done);
        return S_OK;
    }

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        // IAgileObject is a marker interface (no methods beyond IUnknown) that tells
        // the COM runtime this object is safe to call from any apartment. WASAPI
        // REQUIRES the completion handler to be agile when ActivateAudioInterfaceAsync
        // is called from an MTA thread (which we are — COINIT_MULTITHREADED).
        // Without it, ActivateAudioInterfaceAsync fails synchronously with
        // E_ILLEGAL_METHOD_CALL (0x8000000E) before any WASAPI work happens.
        //
        // Since IAgileObject's vtable is identical to IUnknown's (no new slots),
        // we can safely alias it to our existing IActivateAudioInterfaceCompletionHandler
        // pointer — the first three vtable slots are QueryInterface/AddRef/Release
        // in both interfaces.
        if (riid == __uuidof(IUnknown) ||
                riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
                riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            InterlockedIncrement(&m_ref);
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef()  override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG r = InterlockedDecrement(&m_ref);
        if (!r) delete this;
        return r;
    }
};

// ────────────────────────────────────────────────────────────────────────────
// Diagnostic logging
// ────────────────────────────────────────────────────────────────────────────

#ifdef _WIN32
static void DbgLog(const char* fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    OutputDebugStringA("[CipherlineAudio] ");
    OutputDebugStringA(buf);
    OutputDebugStringA("\n");
}
#else
static void DbgLog(const char*, ...) {}
#endif

// ────────────────────────────────────────────────────────────────────────────
// Process tree walking — critical for Chromium/Electron apps
// ────────────────────────────────────────────────────────────────────────────
//
// For Chromium-based apps (Chrome, Edge, VS Code, Slack, Discord, Electron apps
// including Cipherline itself), the process that OWNS a window is a renderer
// process, but actual audio playback is routed through a SIBLING Audio Service
// utility process. GetWindowThreadProcessId returns the renderer PID, so naively
// targeting that PID with AC_LOOPBACK_INCLUDE captures nothing.
//
// The fix: walk UP the process tree from the renderer to the root of the app
// (the main browser process). AC_LOOPBACK_INCLUDE captures the target PID AND
// ALL DESCENDANT processes, so targeting the root sweeps in every utility process
// the app spawns — including the Audio Service where all audio actually plays.
//
// The walk stops as soon as the parent has a different executable name. That
// correctly handles:
//   - Chromium/Electron:  renderer → parent (same exe) → main (different parent) ✓
//   - VLC / native games: leaf → parent (different, e.g. explorer.exe) — stop at leaf ✓
//
// A depth cap of 8 guards against cycles / PID-reuse edge cases.

#ifdef _WIN32
static std::wstring GetExeNameFromSnapshot(HANDLE snap, DWORD pid) {
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) return std::wstring(pe.szExeFile);
        } while (Process32NextW(snap, &pe));
    }
    return L"";
}

static DWORD GetParentPidFromSnapshot(HANDLE snap, DWORD pid) {
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) return pe.th32ParentProcessID;
        } while (Process32NextW(snap, &pe));
    }
    return 0;
}

static DWORD FindRootProcessForPid(DWORD leafPid) {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) {
        DbgLog("FindRootProcessForPid: snapshot failed, returning leaf=%lu", (unsigned long)leafPid);
        return leafPid;
    }

    DWORD current = leafPid;
    std::wstring currentName = GetExeNameFromSnapshot(snap, current);
    if (currentName.empty()) {
        CloseHandle(snap);
        DbgLog("FindRootProcessForPid: no exe name for pid=%lu", (unsigned long)leafPid);
        return leafPid;
    }

    for (int depth = 0; depth < 8; depth++) {
        DWORD parent = GetParentPidFromSnapshot(snap, current);
        if (parent == 0 || parent == current) break;
        std::wstring parentName = GetExeNameFromSnapshot(snap, parent);
        if (parentName.empty() || _wcsicmp(parentName.c_str(), currentName.c_str()) != 0) break;
        current = parent;
    }

    CloseHandle(snap);
    DbgLog("FindRootProcessForPid: leaf=%lu -> root=%lu", (unsigned long)leafPid, (unsigned long)current);
    return current;
}

// Reliability audit (Phase K): the capture loop below has no way to notice
// that the process it's targeting exited mid-share — WASAPI just keeps
// delivering AUDCLNT_BUFFERFLAGS_SILENT packets on the (still-open) virtual
// loopback device, which looks identical, from inside CaptureThread, to the
// target app having simply gone quiet. That ambiguity used to converge on
// the existing 3-second "no chunks yet" watchdog doing nothing (chunks WERE
// arriving, just silent forever) and the user seeing an unexplained dead
// share. OpenProcess + a zero-timeout WaitForSingleObject is the standard
// liveness check: it returns WAIT_OBJECT_0 once the process has actually
// exited, distinct from "alive but producing nothing right now".
static bool IsProcessAlive(DWORD pid) {
    HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, pid);
    if (!h) {
        // ERROR_INVALID_PARAMETER means no such PID exists (already gone).
        // Any other failure (e.g. access denied) is treated as "can't tell,
        // assume alive" — this check must never falsely end a live capture.
        return GetLastError() != ERROR_INVALID_PARAMETER;
    }
    DWORD waitResult = WaitForSingleObject(h, 0);
    CloseHandle(h);
    return waitResult != WAIT_OBJECT_0;
}
#endif

// ────────────────────────────────────────────────────────────────────────────
// Global capture state
// ────────────────────────────────────────────────────────────────────────────

static std::thread       g_thread;
static std::atomic<bool> g_stop{false};
static napi_threadsafe_function g_tsfn = nullptr;
#ifdef _WIN32
static AC_LOOPBACK_MODE  g_mode = AC_LOOPBACK_INCLUDE;
#endif

// ────────────────────────────────────────────────────────────────────────────
// PCM → float32 conversion helpers
// ────────────────────────────────────────────────────────────────────────────

struct AudioChunk {
    uint32_t sampleRate;
    uint16_t channels;
    std::vector<float> samples;
    // Phase K: set (with sampleRate/channels/samples left at their defaults —
    // there is no audio payload) when IsProcessAlive() detects the captured
    // process has exited. A one-shot, terminal signal: the capture loop sends
    // this once and then exits, it does not keep polling after.
    bool processExited = false;
};

// ────────────────────────────────────────────────────────────────────────────
// TSFN callback — runs on Node.js main thread
// ────────────────────────────────────────────────────────────────────────────

static void CallJsCallback(napi_env env, napi_value js_cb, void* /*ctx*/, void* data)
{
    AudioChunk* chunk = static_cast<AudioChunk*>(data);
    if (!chunk) return;

    if (env) {
        napi_value obj;
        napi_create_object(env, &obj);

        if (chunk->processExited) {
            // Terminal signal, no audio payload — see AudioChunk::processExited.
            napi_value flag_val;
            napi_get_boolean(env, true, &flag_val);
            napi_set_named_property(env, obj, "processExited", flag_val);
        } else {
            napi_value sr_val, ch_val;

            napi_create_uint32(env, chunk->sampleRate, &sr_val);
            napi_set_named_property(env, obj, "sampleRate", sr_val);

            napi_create_uint32(env, chunk->channels, &ch_val);
            napi_set_named_property(env, obj, "channels", ch_val);

            // Send float samples as raw bytes (Buffer) — ~8x faster than boxing as JS numbers
            napi_value buf_val;
            napi_create_buffer_copy(env,
                chunk->samples.size() * sizeof(float),
                chunk->samples.data(),
                nullptr,
                &buf_val);
            napi_set_named_property(env, obj, "data", buf_val);
        }

        napi_value args[] = { obj };
        napi_call_function(env, obj, js_cb, 1, args, nullptr);
    }

    delete chunk;
}

// ────────────────────────────────────────────────────────────────────────────
// Capture thread
// ────────────────────────────────────────────────────────────────────────────

static void CaptureThread(DWORD pid)
{
    DbgLog("CaptureThread: start pid=%lu mode=%s",
           (unsigned long)pid, g_mode == AC_LOOPBACK_EXCLUDE ? "EXCLUDE" : "INCLUDE");

    // COINIT_MULTITHREADED is required here. ActivateAudioInterfaceAsync delivers
    // its completion callback via the calling thread's STA message queue when using
    // COINIT_APARTMENTTHREADED — but this thread has no message pump, so the queue
    // is never drained, WaitForSingleObject times out after 5 seconds, and the
    // capture silently fails. With COINIT_MULTITHREADED (MTA), the completion is
    // dispatched to any available MTA thread, so our WaitForSingleObject unblocks
    // correctly without needing a message loop.
    HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    DbgLog("CoInitializeEx hr=0x%08lx", (unsigned long)coHr);

    AC_ACTIVATION_PARAMS params{};
    params.ActivationType = AC_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = g_mode;

    PROPVARIANT activateProp;
    PropVariantInit(&activateProp);
    activateProp.vt             = VT_BLOB;
    activateProp.blob.cbSize    = sizeof(params);
    activateProp.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    CompletionHandler* handler = new CompletionHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activateProp,
        handler,
        &asyncOp
    );
    DbgLog("ActivateAudioInterfaceAsync hr=0x%08lx", (unsigned long)hr);

    if (FAILED(hr)) {
        DbgLog("ActivateAudioInterfaceAsync FAILED — aborting");
        handler->Release(); CoUninitialize(); return;
    }

    DWORD waitResult = WaitForSingleObject(handler->m_done, 5000);
    DbgLog("WaitForSingleObject -> %lu (0=signaled, 258=TIMEOUT) handler_hr=0x%08lx",
           (unsigned long)waitResult, (unsigned long)handler->m_hr);
    if (asyncOp) asyncOp->Release();

    if (FAILED(handler->m_hr) || !handler->m_client) {
        DbgLog("Activation completion failed or no client — aborting");
        handler->Release(); CoUninitialize(); return;
    }

    IAudioClient* audioClient = handler->m_client;
    handler->m_client = nullptr;
    handler->Release();

    // VAD\Process_Loopback is a virtual device and does NOT implement GetMixFormat
    // (it returns E_NOTIMPL / 0x80004001). Microsoft's own ApplicationLoopback sample
    // skips GetMixFormat and hardcodes a format, relying on AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
    // to convert from whatever the captured sources actually produce.
    //
    // We pick float32 @ 48 kHz stereo — the canonical "high quality" capture format — and
    // Windows resamples/reformats upstream audio into it transparently.
    WAVEFORMATEX captureFormat = {};
    captureFormat.wFormatTag      = WAVE_FORMAT_IEEE_FLOAT;
    captureFormat.nChannels       = 2;
    captureFormat.nSamplesPerSec  = 48000;
    captureFormat.wBitsPerSample  = 32;
    captureFormat.nBlockAlign     = (captureFormat.nChannels * captureFormat.wBitsPerSample) / 8;
    captureFormat.nAvgBytesPerSec = captureFormat.nSamplesPerSec * captureFormat.nBlockAlign;
    captureFormat.cbSize          = 0;

    const uint32_t sampleRate  = captureFormat.nSamplesPerSec;
    const uint16_t channels    = captureFormat.nChannels;
    const uint16_t bitsPerSamp = captureFormat.wBitsPerSample;
    const bool     isFloat32   = true;
    DbgLog("Hardcoded capture format: sr=%u ch=%u bps=%u (float32)",
           sampleRate, channels, bitsPerSamp);

    // AUDCLNT_STREAMFLAGS_LOOPBACK is required — Microsoft's ApplicationLoopback sample
    // uses it with the virtual process-loopback device. The earlier theory that it caused
    // AUDCLNT_E_WRONG_ENDPOINT_TYPE was wrong; the real culprits were the missing
    // IAgileObject on the completion handler and the bogus GetMixFormat call.
    hr = audioClient->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        2000000LL, // 200 ms buffer
        0,
        &captureFormat,
        nullptr
    );
    DbgLog("audioClient->Initialize hr=0x%08lx", (unsigned long)hr);

    if (FAILED(hr)) { audioClient->Release(); CoUninitialize(); return; }

    IAudioCaptureClient* capClient = nullptr;
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient), (void**)&capClient);
    DbgLog("GetService(IAudioCaptureClient) hr=0x%08lx", (unsigned long)hr);
    if (FAILED(hr)) { audioClient->Release(); CoUninitialize(); return; }

    hr = audioClient->Start();
    DbgLog("audioClient->Start hr=0x%08lx  entering capture loop", (unsigned long)hr);

    uint64_t totalChunks = 0;
    uint64_t totalFrames = 0;

    // Phase K: how often to run the OpenProcess/WaitForSingleObject liveness
    // check (see IsProcessAlive above). Every loop iteration would mean two
    // syscalls per 10ms tick for no benefit — a closed app doesn't need to be
    // noticed within milliseconds, just well inside the UI's existing 3s
    // "no chunks" watchdog window.
    const ULONGLONG kLivenessCheckIntervalMs = 2500;
    ULONGLONG lastLivenessCheck = GetTickCount64();

    while (!g_stop.load(std::memory_order_relaxed)) {
        Sleep(10);

        ULONGLONG now = GetTickCount64();
        if (now - lastLivenessCheck >= kLivenessCheckIntervalMs) {
            lastLivenessCheck = now;
            if (!IsProcessAlive(pid)) {
                DbgLog("CaptureThread: target pid=%lu no longer running — ending capture", (unsigned long)pid);
                AudioChunk* exitChunk = new AudioChunk{};
                exitChunk->processExited = true;
                napi_status status = napi_call_threadsafe_function(
                    g_tsfn, exitChunk, napi_tsfn_nonblocking);
                if (status != napi_ok) delete exitChunk;
                goto done;
            }
        }

        UINT32 packetSize = 0;
        hr = capClient->GetNextPacketSize(&packetSize);
        if (FAILED(hr)) break;

        while (packetSize > 0 && !g_stop.load(std::memory_order_relaxed)) {
            BYTE*  data      = nullptr;
            UINT32 numFrames = 0;
            DWORD  flags     = 0;

            hr = capClient->GetBuffer(&data, &numFrames, &flags, nullptr, nullptr);
            if (FAILED(hr)) goto done;

            {
                size_t numSamples = (size_t)numFrames * channels;
                AudioChunk* chunk = new AudioChunk{sampleRate, channels, {}};
                chunk->samples.resize(numSamples);

                bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                if (silent || !data) {
                    std::fill(chunk->samples.begin(), chunk->samples.end(), 0.0f);
                } else if (isFloat32) {
                    const float* src = reinterpret_cast<const float*>(data);
                    std::memcpy(chunk->samples.data(), src, numSamples * sizeof(float));
                } else if (bitsPerSamp == 16) {
                    const int16_t* src = reinterpret_cast<const int16_t*>(data);
                    for (size_t i = 0; i < numSamples; i++)
                        chunk->samples[i] = src[i] / 32768.0f;
                } else if (bitsPerSamp == 32) {
                    const int32_t* src = reinterpret_cast<const int32_t*>(data);
                    for (size_t i = 0; i < numSamples; i++)
                        chunk->samples[i] = src[i] / 2147483648.0f;
                }

                capClient->ReleaseBuffer(numFrames);

                napi_status status = napi_call_threadsafe_function(
                    g_tsfn, chunk, napi_tsfn_nonblocking);
                if (status != napi_ok) {
                    DbgLog("tsfn call FAILED status=%d — exiting", (int)status);
                    delete chunk; goto done;
                }

                totalChunks++;
                totalFrames += numFrames;
                if (totalChunks == 1) {
                    DbgLog("FIRST CHUNK: %u frames (%zu samples) silent=%d",
                           numFrames, numSamples, (int)silent);
                }
                if ((totalChunks % 200) == 0) {
                    DbgLog("chunks=%llu totalFrames=%llu",
                           (unsigned long long)totalChunks, (unsigned long long)totalFrames);
                }
            }

            hr = capClient->GetNextPacketSize(&packetSize);
            if (FAILED(hr)) goto done;
        }
    }

done:
    DbgLog("Capture loop exit: chunks=%llu frames=%llu",
           (unsigned long long)totalChunks, (unsigned long long)totalFrames);
    audioClient->Stop();
    capClient->Release();
    audioClient->Release();
    CoUninitialize();
}

#endif // _WIN32

// ────────────────────────────────────────────────────────────────────────────
// JS-exported functions (raw N-API, no C++ wrapper)
// ────────────────────────────────────────────────────────────────────────────

static napi_value GetPidFromSourceId(napi_env env, napi_callback_info info)
{
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    if (argc < 1) {
        napi_value result; napi_get_null(env, &result); return result;
    }

    char buf[512] = {};
    size_t len = 0;
    if (napi_get_value_string_utf8(env, args[0], buf, sizeof(buf), &len) != napi_ok) {
        napi_value result; napi_get_null(env, &result); return result;
    }

#ifdef _WIN32
    // Expected format: "window:{hwnd_decimal}:{n}"
    std::string sourceId(buf, len);
    if (sourceId.compare(0, 7, "window:") != 0) {
        napi_value result; napi_get_null(env, &result); return result;
    }
    size_t first  = sourceId.find(':');
    size_t second = sourceId.find(':', first + 1);
    if (first == std::string::npos || second == std::string::npos) {
        napi_value result; napi_get_null(env, &result); return result;
    }
    std::string hwndStr = sourceId.substr(first + 1, second - first - 1);
    long long hwndVal = 0;
    try { hwndVal = std::stoll(hwndStr); } catch (...) {
        napi_value result; napi_get_null(env, &result); return result;
    }
    HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwndVal));
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0) {
        napi_value result; napi_get_null(env, &result); return result;
    }

    // Walk up to the root of this app's process tree. For Chromium/Electron apps
    // this moves from the renderer (which has no audio children) to the main
    // browser process, so AC_LOOPBACK_INCLUDE can sweep in the Audio Service
    // utility sibling as a descendant.
    DWORD rootPid = FindRootProcessForPid(pid);

    napi_value result;
    napi_create_uint32(env, (uint32_t)rootPid, &result);
    return result;
#else
    napi_value result; napi_get_null(env, &result); return result;
#endif
}

static napi_value StartCapture(napi_env env, napi_callback_info info)
{
    napi_value result;
    napi_get_undefined(env, &result);

#ifdef _WIN32
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc < 3) {
        DbgLog("StartCapture: argc=%zu (need 3) — aborting", argc);
        return result;
    }

    uint32_t pid = 0;
    napi_get_value_uint32(env, args[0], &pid);

    // args[1] is mode string ("include" or "exclude")
    char modeBuf[16] = {};
    size_t modeLen = 0;
    napi_get_value_string_utf8(env, args[1], modeBuf, sizeof(modeBuf), &modeLen);
    g_mode = (strcmp(modeBuf, "exclude") == 0) ? AC_LOOPBACK_EXCLUDE : AC_LOOPBACK_INCLUDE;
    DbgLog("StartCapture: pid=%u mode='%s' (%s)",
           pid, modeBuf, g_mode == AC_LOOPBACK_EXCLUDE ? "EXCLUDE" : "INCLUDE");

    // Stop any previous capture
    if (g_thread.joinable()) {
        g_stop.store(true);
        g_thread.join();
    }
    if (g_tsfn) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
        g_tsfn = nullptr;
    }
    g_stop.store(false);

    napi_value async_name;
    napi_create_string_utf8(env, "AudioCapture", NAPI_AUTO_LENGTH, &async_name);
    napi_status tsfnStatus = napi_create_threadsafe_function(
        env, args[2], nullptr, async_name,
        0,   // max queue (unlimited)
        1,   // initial thread count
        nullptr, nullptr, nullptr,
        CallJsCallback,
        &g_tsfn
    );
    DbgLog("napi_create_threadsafe_function status=%d tsfn=%p",
           (int)tsfnStatus, (void*)g_tsfn);

    g_thread = std::thread(CaptureThread, (DWORD)pid);
#endif

    return result;
}

static napi_value StopCapture(napi_env env, napi_callback_info /*info*/)
{
    napi_value result;
    napi_get_undefined(env, &result);

#ifdef _WIN32
    g_stop.store(true);
    if (g_thread.joinable()) g_thread.join();
    if (g_tsfn) {
        napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
        g_tsfn = nullptr;
    }
#endif

    return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Module init
// ────────────────────────────────────────────────────────────────────────────

// window_geometry.cc — display/window geometry for the annotation
// overlay (see that file). Linked into this addon so there is one .node file.
void RegisterWindowGeometry(napi_env env, napi_value exports);

static napi_value Init(napi_env env, napi_value exports)
{
    napi_value fn;

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
