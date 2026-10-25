/**
 * hdr_capture.cc - tone-mapped screen capture of an HDR Windows display,
 * linked into the audio_capture addon (one native module to build).
 *
 * WHY THIS EXISTS. With HDR on, the desktop is composed in scRGB FP16
 * (1.0 = 80 nits; SDR apps' white sits at the user's "SDR content brightness",
 * 2.5-6.0). Chromium's two Windows screen capturers both receive 8-bit BGRA
 * from the OS - webrtc wgc_capture_session.cc creates its frame pool as
 * B8G8R8A8UIntNormalized, and dxgi_output_duplicator.cc uses the legacy
 * IDXGIOutput1::DuplicateOutput, which "always converts the fullscreen
 * surface to a 32-bit BGRA format" (IDXGIOutput5::DuplicateOutput1 docs) - and
 * that conversion clips at scRGB 1.0. Everything brighter than 80 nits, i.e.
 * most of an SDR desktop and every HDR highlight, arrives as 255: the share
 * is "blown out", and the detail is gone before a frame reaches the page. No
 * Chromium 150 switch or feature changes either capturer's format (see
 * electron/capture-flags.ts). So for an HDR screen we capture ourselves:
 *
 *   IDXGIOutput5::DuplicateOutput1({R16G16B16A16_FLOAT, B8G8R8A8_UNORM})
 *     -> pixel shader: scRGB -> SDR-relative -> highlight roll-off -> sRGB
 *        (the TONEMAP-CORE block; reference + tests: src/utils/hdrTonemap.ts)
 *     -> mouse pointer composited on top (Desktop Duplication does not draw it)
 *     -> one of kSlots shared B8G8R8A8 textures (NT handles)
 *   JS (electron/hdr-share.ts) imports each finished slot with Electron's
 *   sharedTexture API, hands it to the renderer as a VideoFrame, and the
 *   renderer writes it into a MediaStreamTrackGenerator that LiveKit publishes
 *   - so E2EE and every sender hook apply as for any other share. No pixel
 *   ever crosses to the CPU.
 *
 * Raw N-API like the rest of the addon. Everything Win32 sits behind
 * `#ifdef _WIN32`; elsewhere every export is a harmless no-op.
 *
 * Exports (RegisterHdrCapture, called from the addon's Init):
 *
 *   hdrGetDisplays() -> Array<{ index, deviceName, hdr, colorSpace,
 *       bitsPerColor, minLuminance, maxLuminance, maxFullFrameLuminance,
 *       sdrWhiteNits, left, top, width, height, rotation, sameAdapterAsDefault }>
 *     One entry per ACTIVE GDI display device; `index` is the
 *     EnumDisplayDevicesW index, which is exactly the N of a desktopCapturer
 *     `screen:N:0` id (webrtc screen_capture_utils.cc GetScreenList). Cheap:
 *     DXGI factory enumeration + QueryDisplayConfig, no duplication.
 *
 *   hdrCaptureStart({ index, width, height, maxFps, sdrWhiteNits?, peakNits?,
 *                     knee?, force? }, onEvent) -> { ok: boolean, error?: string }
 *     Starts ONE capture (a second start stops the first). All D3D/DXGI work
 *     happens on the capture thread, never on the caller's (the main process's
 *     UI thread - see capture-flags.ts for what DXGI on that thread cost us).
 *     `width`/`height` is the output size (scaling happens in the same pass).
 *     sdrWhiteNits/peakNits 0 = read from the display (re-read whenever the
 *     duplication is re-created, so a slider change takes effect then).
 *     Events, on the JS thread:
 *       { type: 'started', generation, width, height, srcWidth, srcHeight, hdr,
 *         inputFormat, sdrWhiteNits, peakNits, knee, handles: Buffer[] }   (once)
 *       { type: 'frame', slot, timestampUs }    slot is BUSY until hdrCaptureRelease(slot)
 *       { type: 'params', hdr, inputFormat, sdrWhiteNits, peakNits }  (after a re-duplication)
 *       { type: 'error', error }                 start failed; nothing else follows
 *       { type: 'ended', reason }                the capture stopped on its own
 *
 *   hdrCaptureRelease(slot, generation) -> void   the consumer is done with that
 *     slot of THAT capture (a late release for an earlier capture is ignored,
 *     so it can never free a slot the current one still has out)
 *   hdrCaptureStop() -> void          idempotent; joins the thread
 *   hdrCaptureStats() -> { running, frames, dropped, repeats, reduplications,
 *       gpuUsAvg, gpuUsMax, waitUsAvg, slotsBusy } | null
 *     gpuUsAvg/Max: GPU time of the tone-map + pointer passes per frame
 *     (D3D11 timestamp queries), the number the owner's harness asks for.
 */

#include <node_api.h>

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// ── tiny COM holder (no WRL dependency) ─────────────────────────────────────
template <typename T>
class Com {
 public:
  Com() = default;
  ~Com() { Reset(); }
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  T* Get() const { return p_; }
  T* operator->() const { return p_; }
  T** Put() { Reset(); return &p_; }
  void Reset() { if (p_) { p_->Release(); p_ = nullptr; } }
  // Take over `other`'s reference.
  void Take(Com& other) { Reset(); p_ = other.p_; other.p_ = nullptr; }
  explicit operator bool() const { return p_ != nullptr; }
  template <typename U>
  HRESULT As(Com<U>& out) const {
    if (!p_) return E_POINTER;
    return p_->QueryInterface(__uuidof(U), reinterpret_cast<void**>(out.Put()));
  }
 private:
  T* p_ = nullptr;
};

// ── constants mirrored from src/utils/hdrTonemap.ts ─────────────────────────
constexpr float kScRgbWhiteNits = 80.0f;
constexpr float kDefaultSdrWhiteNits = 80.0f;
constexpr float kDefaultPeakNits = 1000.0f;
constexpr float kDefaultKnee = 0.8f;
constexpr float kMinPeakOverWhite = 2.0f;
constexpr float kMaxSdrWhiteNits = 1000.0f;
constexpr float kMaxPeakNits = 10000.0f;

constexpr int kSlots = 4;
constexpr DWORD kAcquireTimeoutMs = 100;
constexpr int64_t kIdleRepeatUs = 1000000;  // re-send the last frame after 1 s of a still desktop
constexpr int64_t kGpuWaitTimeoutUs = 250000;

struct ToneParams { float sdrWhiteNits; float peakNits; float knee; };

// hdrTonemap.ts resolveToneParams, line for line.
ToneParams ResolveToneParams(float sdrWhite, float maxLum, float knee) {
  ToneParams p;
  p.sdrWhiteNits = (std::isfinite(sdrWhite) && sdrWhite >= kScRgbWhiteNits)
      ? std::min(sdrWhite, kMaxSdrWhiteNits) : kDefaultSdrWhiteNits;
  const float reported = (std::isfinite(maxLum) && maxLum > 0.0f)
      ? std::min(maxLum, kMaxPeakNits) : kDefaultPeakNits;
  p.peakNits = std::max(reported, p.sdrWhiteNits * kMinPeakOverWhite);
  p.knee = (std::isfinite(knee) && knee >= 0.1f && knee <= 0.95f) ? knee : kDefaultKnee;
  return p;
}

// ── shaders ─────────────────────────────────────────────────────────────────
// The TONEMAP-CORE block is the ONLY place the curve lives on the GPU. It is
// written in the common subset of HLSL and GLSL ES 3.0 (float literals only,
// no `static`, no HLSL-only intrinsics); GLSL compiles it with
//   #define float3 vec3 / float4 vec4 / float2 vec2
// (scripts/hdr-tonemap-harness.mjs extracts it from this file verbatim and
// checks it pixel-for-pixel against src/utils/hdrTonemap.ts).
const char kShaderSource[] = R"HLSL(
cbuffer Params : register(b0) {
  float4 tone;   // 80 / sdrWhite, knee, peak / sdrWhite, 1 / umax^2
  float4 mode;   // x: 1 = scRGB input (tone map), 0 = 8-bit sRGB input (copy)
  float4 rect;   // pointer quad in NDC: left, top, right, bottom
};
Texture2D src : register(t0);
SamplerState smp : register(s0);

struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

// TONEMAP-CORE-BEGIN
float3 clTonemap(float3 scrgb, float4 p) {
  float3 c = max(scrgb, float3(0.0, 0.0, 0.0)) * p.x;
  float m = max(c.r, max(c.g, c.b));
  float y = m;
  if (m > p.y) {
    float u = (m - p.y) / (1.0 - p.y);
    float g = u * (1.0 + u * p.w) / (1.0 + u);
    y = min(p.y + (1.0 - p.y) * g, 1.0);
  }
  float s = 0.0;
  if (m > 0.0) { s = y / m; }
  return min(c * s, float3(1.0, 1.0, 1.0));
}
float clSrgbEncode1(float l) {
  float v = clamp(l, 0.0, 1.0);
  if (v <= 0.0031308) { return v * 12.92; }
  return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
float3 clSrgbEncode(float3 l) {
  return float3(clSrgbEncode1(l.r), clSrgbEncode1(l.g), clSrgbEncode1(l.b));
}
// TONEMAP-CORE-END

VSOut vs_full(uint id : SV_VertexID) {
  VSOut o;
  float2 uv = float2((id << 1) & 2, id & 2);
  o.uv = uv;
  o.pos = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  return o;
}

VSOut vs_quad(uint id : SV_VertexID) {
  VSOut o;
  float2 c = float2(id & 1, id >> 1);
  o.uv = c;
  o.pos = float4(lerp(rect.x, rect.z, c.x), lerp(rect.y, rect.w, c.y), 0.0, 1.0);
  return o;
}

float4 ps_tone(VSOut i) : SV_Target {
  float4 s = src.Sample(smp, i.uv);
  if (mode.x < 0.5) { return float4(s.rgb, 1.0); }
  return float4(clSrgbEncode(clTonemap(s.rgb, tone)), 1.0);
}

float4 ps_tex(VSOut i) : SV_Target {
  return src.Sample(smp, i.uv);
}
)HLSL";

// ── helpers ─────────────────────────────────────────────────────────────────
int64_t NowUs() {
  static LARGE_INTEGER freq = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f; }();
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  return static_cast<int64_t>((t.QuadPart * 1000000.0) / freq.QuadPart);
}

std::string Utf8(const wchar_t* w) {
  if (!w || !*w) return std::string();
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return std::string();
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

std::string Hex(HRESULT hr) {
  char b[16];
  snprintf(b, sizeof(b), "0x%08lx", static_cast<unsigned long>(hr));
  return b;
}

// GDI device name ("\\.\DISPLAY1") of an EnumDisplayDevicesW index, if active.
bool GdiNameForIndex(int index, std::wstring* name) {
  if (index < 0) return false;
  DISPLAY_DEVICEW dd = {};
  dd.cb = sizeof(dd);
  if (!EnumDisplayDevicesW(nullptr, static_cast<DWORD>(index), &dd, 0)) return false;
  if (!(dd.StateFlags & DISPLAY_DEVICE_ACTIVE)) return false;
  *name = dd.DeviceName;
  return true;
}

// DISPLAYCONFIG_SDR_WHITE_LEVEL for a GDI device name; 0 when unknown.
float SdrWhiteNitsFor(const std::wstring& gdiName) {
  for (int attempt = 0; attempt < 4; ++attempt) {
    UINT32 nPath = 0, nMode = 0;
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &nPath, &nMode) != ERROR_SUCCESS) return 0.0f;
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(nPath);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(nMode);
    LONG r = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &nPath, paths.data(), &nMode, modes.data(), nullptr);
    if (r == ERROR_INSUFFICIENT_BUFFER) continue;  // the topology changed between the two calls
    if (r != ERROR_SUCCESS) return 0.0f;
    paths.resize(nPath);
    for (const auto& path : paths) {
      DISPLAYCONFIG_SOURCE_DEVICE_NAME src = {};
      src.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
      src.header.size = sizeof(src);
      src.header.adapterId = path.sourceInfo.adapterId;
      src.header.id = path.sourceInfo.id;
      if (DisplayConfigGetDeviceInfo(&src.header) != ERROR_SUCCESS) continue;
      if (gdiName != src.viewGdiDeviceName) continue;
      // DISPLAYCONFIG_SDR_WHITE_LEVEL / DISPLAYCONFIG_DEVICE_INFO_GET_SDR_WHITE_LEVEL
      // (= 11), mirrored so the build does not depend on the SDK's NTDDI gate.
      struct { DISPLAYCONFIG_DEVICE_INFO_HEADER header; ULONG SDRWhiteLevel; } white = {};
      white.header.type = static_cast<DISPLAYCONFIG_DEVICE_INFO_TYPE>(11);
      white.header.size = sizeof(white);
      white.header.adapterId = path.targetInfo.adapterId;
      white.header.id = path.targetInfo.id;
      if (DisplayConfigGetDeviceInfo(&white.header) != ERROR_SUCCESS) return 0.0f;
      // "1000 = 80 nits" (wingdi.h).
      return static_cast<float>(white.SDRWhiteLevel) * kScRgbWhiteNits / 1000.0f;
    }
    return 0.0f;
  }
  return 0.0f;
}

bool SameLuid(const LUID& a, const LUID& b) { return a.LowPart == b.LowPart && a.HighPart == b.HighPart; }

struct OutputMatch {
  Com<IDXGIAdapter1> adapter;
  Com<IDXGIOutput> output;
  DXGI_OUTPUT_DESC desc = {};
  bool hasDesc1 = false;
  DXGI_OUTPUT_DESC1 desc1 = {};
  bool sameAdapterAsDefault = false;
};

// Find the DXGI output whose DeviceName is `gdiName`.
bool FindOutput(const std::wstring& gdiName, OutputMatch* out, std::string* err) {
  Com<IDXGIFactory1> factory;
  HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.Put()));
  if (FAILED(hr)) { *err = "CreateDXGIFactory1 " + Hex(hr); return false; }
  LUID defaultLuid = {};
  {
    Com<IDXGIAdapter1> a0;
    if (SUCCEEDED(factory->EnumAdapters1(0, a0.Put()))) {
      DXGI_ADAPTER_DESC1 d = {};
      if (SUCCEEDED(a0->GetDesc1(&d))) defaultLuid = d.AdapterLuid;
    }
  }
  for (UINT a = 0;; ++a) {
    Com<IDXGIAdapter1> adapter;
    if (factory->EnumAdapters1(a, adapter.Put()) == DXGI_ERROR_NOT_FOUND) break;
    DXGI_ADAPTER_DESC1 ad = {};
    adapter->GetDesc1(&ad);
    for (UINT o = 0;; ++o) {
      Com<IDXGIOutput> output;
      if (adapter->EnumOutputs(o, output.Put()) == DXGI_ERROR_NOT_FOUND) break;
      DXGI_OUTPUT_DESC d = {};
      if (FAILED(output->GetDesc(&d))) continue;
      if (gdiName != d.DeviceName) continue;
      out->desc = d;
      Com<IDXGIOutput6> o6;
      if (SUCCEEDED(output.As(o6)) && SUCCEEDED(o6->GetDesc1(&out->desc1))) out->hasDesc1 = true;
      out->sameAdapterAsDefault = SameLuid(ad.AdapterLuid, defaultLuid);
      out->adapter.Take(adapter);
      out->output.Take(output);
      return true;
    }
  }
  *err = "output_not_found";
  return false;
}

bool IsHdrColorSpace(const OutputMatch& m) {
  return m.hasDesc1 && m.desc1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020;
}

// ── capture session ─────────────────────────────────────────────────────────
struct StartOptions {
  int index = -1;
  UINT width = 0, height = 0;
  double maxFps = 60.0;
  float sdrWhiteNits = 0.0f, peakNits = 0.0f, knee = 0.0f;
  bool force = false;  // tone-map path even on an SDR display (pipeline test)
};

enum class EvType { Started, Frame, Params, Error, Ended };

struct Event {
  explicit Event(EvType t) : type(t) {}
  EvType type;
  uint32_t generation = 0;
  int slot = -1;
  int64_t timestampUs = 0;
  UINT width = 0, height = 0, srcWidth = 0, srcHeight = 0;
  bool hdr = false;
  std::string inputFormat;
  float sdrWhiteNits = 0, peakNits = 0, knee = 0;
  uintptr_t handles[kSlots] = {};
  std::string text;
};

struct Session {
  StartOptions opts;
  uint32_t generation = 0;
  std::thread thread;
  std::atomic<bool> stop{false};
  std::atomic<bool> running{false};
  napi_threadsafe_function tsfn = nullptr;
  std::atomic<uint32_t> busy{0};  // bit per slot
  std::atomic<uint64_t> frames{0}, dropped{0}, repeats{0}, redups{0};
  std::atomic<uint64_t> gpuUsSum{0}, gpuUsCount{0}, gpuUsMax{0}, waitUsSum{0};
};

std::mutex g_mu;
Session* g_session = nullptr;
uint32_t g_generation = 0;

void Post(Session* s, Event* ev) {
  if (!s->tsfn) { delete ev; return; }
  napi_status st = napi_call_threadsafe_function(s->tsfn, ev, napi_tsfn_nonblocking);
  if (st != napi_ok) {
    if (ev->type == EvType::Frame && ev->slot >= 0) {
      s->busy.fetch_and(~(1u << ev->slot));
      s->dropped++;
    }
    delete ev;
  }
}

class Capturer {
 public:
  explicit Capturer(Session* s) : s_(s) {}
  ~Capturer() { ReleaseAll(); }

  // Runs on the capture thread until stop or a terminal failure.
  void Run() {
    // DuplicateOutput1 fails without per-monitor-v2 DPI awareness on the
    // calling thread. Electron's process is already PMv2; set it explicitly
    // for this thread anyway (resolved at run time: Windows 10 1607+; the
    // handle value is the SDK's DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    // spelled out so the build does not depend on WINVER).
    using SetCtx = HANDLE(WINAPI*)(HANDLE);
    if (auto fn = reinterpret_cast<SetCtx>(reinterpret_cast<void*>(
            GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetThreadDpiAwarenessContext")))) {
      fn(reinterpret_cast<HANDLE>(static_cast<intptr_t>(-4)));
    }
    std::string err;
    if (!Init(&err)) {
      auto* ev = new Event(EvType::Error);
      ev->text = err;
      Post(s_, ev);
      return;
    }
    auto* started = new Event(EvType::Started);
    started->generation = s_->generation;
    started->width = outW_;
    started->height = outH_;
    started->srcWidth = srcW_;
    started->srcHeight = srcH_;
    started->hdr = hdr_;
    started->inputFormat = fp16_ ? "fp16" : "bgra8";
    started->sdrWhiteNits = tone_.sdrWhiteNits;
    started->peakNits = tone_.peakNits;
    started->knee = tone_.knee;
    for (int i = 0; i < kSlots; ++i) started->handles[i] = reinterpret_cast<uintptr_t>(slots_[i].handle);
    Post(s_, started);
    s_->running = true;
    std::string why = Loop();
    s_->running = false;
    if (!s_->stop.load()) {
      auto* ev = new Event(EvType::Ended);
      ev->text = why;
      Post(s_, ev);
    }
  }

 private:
  struct Slot {
    Com<ID3D11Texture2D> tex;
    Com<ID3D11RenderTargetView> rtv;
    HANDLE handle = nullptr;
    int64_t lastUsedUs = 0;
  };

  bool Init(std::string* err) {
    if (!GdiNameForIndex(s_->opts.index, &gdiName_)) { *err = "display_not_active"; return false; }
    if (!FindOutput(gdiName_, &match_, err)) return false;
    // The textures are opened by Chromium's GPU process on ITS device. That
    // device is on the default adapter; a texture created on another adapter
    // cannot be opened there, so a display driven by a second GPU stays on
    // Chromium's own capturer.
    if (!match_.sameAdapterAsDefault) { *err = "cross_adapter"; return false; }

    const D3D_FEATURE_LEVEL levels[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0 };
    HRESULT hr = D3D11CreateDevice(match_.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                   D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels),
                                   D3D11_SDK_VERSION, device_.Put(), nullptr, ctx_.Put());
    if (FAILED(hr)) {
      // 11_1 is rejected outright by an 11_0-only runtime: retry without it.
      hr = D3D11CreateDevice(match_.adapter.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                             D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels + 1, ARRAYSIZE(levels) - 1,
                             D3D11_SDK_VERSION, device_.Put(), nullptr, ctx_.Put());
    }
    if (FAILED(hr)) { *err = "D3D11CreateDevice " + Hex(hr); return false; }
    if (!CreatePipeline(err)) return false;
    if (!Duplicate(err)) return false;
    outW_ = s_->opts.width ? s_->opts.width : srcW_;
    outH_ = s_->opts.height ? s_->opts.height : srcH_;
    if (outW_ < 2 || outH_ < 2 || outW_ > 16384 || outH_ > 16384) { *err = "bad_size"; return false; }
    if (!CreateSlots(err)) return false;
    timer_ = CreateWaitableTimerExW(nullptr, nullptr, 0x00000002 /* CREATE_WAITABLE_TIMER_HIGH_RESOLUTION */, TIMER_ALL_ACCESS);
    if (!timer_) timer_ = CreateWaitableTimerW(nullptr, TRUE, nullptr);
    return true;
  }

  bool Compile(const char* entry, const char* target, ID3DBlob** out, std::string* err) {
    Com<ID3DBlob> errors;
    HRESULT hr = D3DCompile(kShaderSource, sizeof(kShaderSource) - 1, "hdr_capture", nullptr, nullptr,
                            entry, target, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, out, errors.Put());
    if (FAILED(hr)) {
      *err = std::string("shader ") + entry + " " + Hex(hr);
      if (errors) err->append(": ").append(static_cast<const char*>(errors->GetBufferPointer()), std::min<size_t>(errors->GetBufferSize(), 300));
      return false;
    }
    return true;
  }

  bool CreatePipeline(std::string* err) {
    Com<ID3DBlob> vsFull, vsQuad, psTone, psTex;
    if (!Compile("vs_full", "vs_4_0", vsFull.Put(), err)) return false;
    if (!Compile("vs_quad", "vs_4_0", vsQuad.Put(), err)) return false;
    if (!Compile("ps_tone", "ps_4_0", psTone.Put(), err)) return false;
    if (!Compile("ps_tex", "ps_4_0", psTex.Put(), err)) return false;
    HRESULT hr;
    if (FAILED(hr = device_->CreateVertexShader(vsFull->GetBufferPointer(), vsFull->GetBufferSize(), nullptr, vsFull_.Put())) ||
        FAILED(hr = device_->CreateVertexShader(vsQuad->GetBufferPointer(), vsQuad->GetBufferSize(), nullptr, vsQuad_.Put())) ||
        FAILED(hr = device_->CreatePixelShader(psTone->GetBufferPointer(), psTone->GetBufferSize(), nullptr, psTone_.Put())) ||
        FAILED(hr = device_->CreatePixelShader(psTex->GetBufferPointer(), psTex->GetBufferSize(), nullptr, psTex_.Put()))) {
      *err = "create shaders " + Hex(hr);
      return false;
    }
    D3D11_BUFFER_DESC cb = {};
    cb.ByteWidth = 48;
    cb.Usage = D3D11_USAGE_DYNAMIC;
    cb.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    cb.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    if (FAILED(hr = device_->CreateBuffer(&cb, nullptr, cbuf_.Put()))) { *err = "cbuffer " + Hex(hr); return false; }
    D3D11_SAMPLER_DESC sd = {};
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MaxLOD = D3D11_FLOAT32_MAX;
    if (FAILED(hr = device_->CreateSamplerState(&sd, linear_.Put()))) { *err = "sampler " + Hex(hr); return false; }
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
    if (FAILED(hr = device_->CreateSamplerState(&sd, point_.Put()))) { *err = "sampler " + Hex(hr); return false; }
    D3D11_BLEND_DESC bd = {};
    bd.RenderTarget[0].BlendEnable = TRUE;
    bd.RenderTarget[0].SrcBlend = D3D11_BLEND_SRC_ALPHA;
    bd.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    bd.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    bd.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ZERO;
    bd.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_ONE;
    bd.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    if (FAILED(hr = device_->CreateBlendState(&bd, blendAlpha_.Put()))) { *err = "blend " + Hex(hr); return false; }
    // Inverting pointer pixels (XOR masks): out = src*(1-dst) + dst*(1-src),
    // which is exact for the black/white masks Windows cursors use.
    bd.RenderTarget[0].SrcBlend = D3D11_BLEND_INV_DEST_COLOR;
    bd.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_COLOR;
    if (FAILED(hr = device_->CreateBlendState(&bd, blendInvert_.Put()))) { *err = "blend " + Hex(hr); return false; }
    D3D11_QUERY_DESC qd = {};
    qd.Query = D3D11_QUERY_EVENT;
    if (FAILED(hr = device_->CreateQuery(&qd, done_.Put()))) { *err = "query " + Hex(hr); return false; }
    qd.Query = D3D11_QUERY_TIMESTAMP_DISJOINT;
    device_->CreateQuery(&qd, tsDisjoint_.Put());
    qd.Query = D3D11_QUERY_TIMESTAMP;
    device_->CreateQuery(&qd, tsBegin_.Put());
    device_->CreateQuery(&qd, tsEnd_.Put());
    return true;
  }

  // (Re)create the duplication. Fills hdr_, fp16_, srcW_/srcH_ and tone_.
  bool Duplicate(std::string* err) {
    dupl_.Reset();
    // The HDR state may have changed since the last time (that is one way to
    // lose access): describe the output afresh.
    OutputMatch fresh;
    std::string ferr;
    if (FindOutput(gdiName_, &fresh, &ferr)) {
      // A stale IDXGIOutput (the display topology changed) cannot be
      // duplicated: use the fresh one. Same adapter, so the device still fits.
      if (fresh.sameAdapterAsDefault) match_.output.Take(fresh.output);
      match_.hasDesc1 = fresh.hasDesc1;
      match_.desc1 = fresh.desc1;
      match_.desc = fresh.desc;
    }
    hdr_ = IsHdrColorSpace(match_);
    if (!hdr_ && !s_->opts.force) { *err = "not_hdr"; return false; }
    if (match_.desc.Rotation != DXGI_MODE_ROTATION_IDENTITY && match_.desc.Rotation != DXGI_MODE_ROTATION_UNSPECIFIED) {
      *err = "rotated";
      return false;
    }
    HRESULT hr = E_NOINTERFACE;
    Com<IDXGIOutput5> o5;
    if (SUCCEEDED(match_.output.As(o5))) {
      const DXGI_FORMAT formats[] = { DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_B8G8R8A8_UNORM };
      hr = o5->DuplicateOutput1(device_.Get(), 0, ARRAYSIZE(formats), formats, dupl_.Put());
    }
    if (FAILED(hr) && !hdr_) {
      // An SDR display on an OS without DuplicateOutput1 (force mode only).
      Com<IDXGIOutput1> o1;
      if (SUCCEEDED(match_.output.As(o1))) hr = o1->DuplicateOutput(device_.Get(), dupl_.Put());
    }
    if (FAILED(hr) || !dupl_) { *err = "DuplicateOutput1 " + Hex(hr); return false; }
    DXGI_OUTDUPL_DESC dd = {};
    dupl_->GetDesc(&dd);
    srcW_ = dd.ModeDesc.Width;
    srcH_ = dd.ModeDesc.Height;
    fp16_ = dd.ModeDesc.Format == DXGI_FORMAT_R16G16B16A16_FLOAT;
    const float white = s_->opts.sdrWhiteNits > 0 ? s_->opts.sdrWhiteNits : SdrWhiteNitsFor(gdiName_);
    const float peak = s_->opts.peakNits > 0 ? s_->opts.peakNits : (match_.hasDesc1 ? match_.desc1.MaxLuminance : 0.0f);
    tone_ = ResolveToneParams(white, peak, s_->opts.knee > 0 ? s_->opts.knee : kDefaultKnee);
    return true;
  }

  bool CreateSlots(std::string* err) {
    for (int i = 0; i < kSlots; ++i) {
      D3D11_TEXTURE2D_DESC td = {};
      td.Width = outW_;
      td.Height = outH_;
      td.MipLevels = 1;
      td.ArraySize = 1;
      td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_DEFAULT;
      td.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      // NT handle, no keyed mutex: what Electron's sharedTexture import of a
      // `bgra` texture expects (SharedTextureHandle docs).
      td.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
      HRESULT hr = device_->CreateTexture2D(&td, nullptr, slots_[i].tex.Put());
      if (FAILED(hr)) { *err = "slot texture " + Hex(hr); return false; }
      if (FAILED(hr = device_->CreateRenderTargetView(slots_[i].tex.Get(), nullptr, slots_[i].rtv.Put()))) { *err = "slot rtv " + Hex(hr); return false; }
      Com<IDXGIResource1> res;
      if (FAILED(hr = slots_[i].tex.As(res))) { *err = "IDXGIResource1 " + Hex(hr); return false; }
      if (FAILED(hr = res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &slots_[i].handle))) {
        *err = "CreateSharedHandle " + Hex(hr);
        return false;
      }
      // Never hand out undefined contents.
      const float black[4] = { 0, 0, 0, 1 };
      ctx_->ClearRenderTargetView(slots_[i].rtv.Get(), black);
    }
    ctx_->Flush();
    return true;
  }

  void WaitUntil(int64_t dueUs) {
    const int64_t now = NowUs();
    if (dueUs <= now) return;
    const int64_t waitUs = dueUs - now;
    if (timer_) {
      LARGE_INTEGER due;
      due.QuadPart = -waitUs * 10;  // relative, 100 ns units
      if (SetWaitableTimer(timer_, &due, 0, nullptr, nullptr, FALSE)) {
        WaitForSingleObject(timer_, static_cast<DWORD>(waitUs / 1000 + 50));
        return;
      }
    }
    Sleep(static_cast<DWORD>(waitUs / 1000));
  }

  int PickSlot() {
    const uint32_t busy = s_->busy.load();
    int best = -1;
    for (int i = 0; i < kSlots; ++i) {
      if (busy & (1u << i)) continue;
      if (best < 0 || slots_[i].lastUsedUs < slots_[best].lastUsedUs) best = i;
    }
    return best;
  }

  void SetParams(float modeX, const float rect[4]) {
    D3D11_MAPPED_SUBRESOURCE m;
    if (FAILED(ctx_->Map(cbuf_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &m))) return;
    const float xmax = tone_.peakNits / tone_.sdrWhiteNits;
    const float umax = (xmax - tone_.knee) / (1.0f - tone_.knee);
    float data[12] = {
      kScRgbWhiteNits / tone_.sdrWhiteNits, tone_.knee, xmax, 1.0f / (umax * umax),
      modeX, 0, 0, 0,
      rect[0], rect[1], rect[2], rect[3],
    };
    memcpy(m.pData, data, sizeof(data));
    ctx_->Unmap(cbuf_.Get(), 0);
  }

  // Pointer shape -> two BGRA textures: `normal` (straight alpha) and `invert`
  // (white where the screen is to be inverted).
  void UpdatePointerShape(const DXGI_OUTDUPL_POINTER_SHAPE_INFO& info, const std::vector<uint8_t>& buf) {
    ptrNormal_.Reset(); ptrNormalSrv_.Reset(); ptrInvert_.Reset(); ptrInvertSrv_.Reset();
    UINT w = info.Width;
    UINT h = info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME ? info.Height / 2 : info.Height;
    if (!w || !h || w > 512 || h > 512) return;
    std::vector<uint32_t> normal(w * h, 0), invert(w * h, 0);
    bool anyInvert = false;
    for (UINT y = 0; y < h; ++y) {
      for (UINT x = 0; x < w; ++x) {
        uint32_t& n = normal[y * w + x];
        uint32_t& v = invert[y * w + x];
        if (info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
          const uint8_t bit = static_cast<uint8_t>(0x80 >> (x % 8));
          const bool andBit = (buf[y * info.Pitch + x / 8] & bit) != 0;
          const bool xorBit = (buf[(y + h) * info.Pitch + x / 8] & bit) != 0;
          if (!andBit) n = xorBit ? 0xFFFFFFFFu : 0xFF000000u;
          else if (xorBit) { v = 0xFFFFFFFFu; anyInvert = true; }
        } else {
          uint32_t px;
          memcpy(&px, &buf[y * info.Pitch + x * 4], 4);
          if (info.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
            n = px;  // 32-bpp ARGB with its own alpha
          } else {   // MASKED_COLOR: alpha 0 = opaque colour, 0xFF = XOR the colour onto the screen
            if ((px >> 24) == 0) n = px | 0xFF000000u;
            else if (px & 0x00FFFFFFu) { v = px | 0xFF000000u; anyInvert = true; }
          }
        }
      }
    }
    auto make = [&](const std::vector<uint32_t>& data, Com<ID3D11Texture2D>& tex, Com<ID3D11ShaderResourceView>& srv) {
      D3D11_TEXTURE2D_DESC td = {};
      td.Width = w; td.Height = h; td.MipLevels = 1; td.ArraySize = 1;
      td.Format = DXGI_FORMAT_B8G8R8A8_UNORM; td.SampleDesc.Count = 1;
      td.Usage = D3D11_USAGE_IMMUTABLE; td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
      D3D11_SUBRESOURCE_DATA sd = { data.data(), w * 4, 0 };
      if (SUCCEEDED(device_->CreateTexture2D(&td, &sd, tex.Put()))) device_->CreateShaderResourceView(tex.Get(), nullptr, srv.Put());
    };
    make(normal, ptrNormal_, ptrNormalSrv_);
    if (anyInvert) make(invert, ptrInvert_, ptrInvertSrv_);
    ptrW_ = w;
    ptrH_ = h;
  }

  void DrawPointer() {
    if (!ptrVisible_ || !ptrNormalSrv_) return;
    const float sx = static_cast<float>(outW_) / srcW_, sy = static_cast<float>(outH_) / srcH_;
    const float l = ptrX_ * sx, t = ptrY_ * sy, r = (ptrX_ + static_cast<float>(ptrW_)) * sx, b = (ptrY_ + static_cast<float>(ptrH_)) * sy;
    const float rect[4] = { l / outW_ * 2.0f - 1.0f, 1.0f - t / outH_ * 2.0f, r / outW_ * 2.0f - 1.0f, 1.0f - b / outH_ * 2.0f };
    SetParams(0.0f, rect);
    ctx_->VSSetShader(vsQuad_.Get(), nullptr, 0);
    ctx_->PSSetShader(psTex_.Get(), nullptr, 0);
    ID3D11SamplerState* smp = point_.Get();
    ctx_->PSSetSamplers(0, 1, &smp);
    ctx_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP);
    const float factor[4] = { 0, 0, 0, 0 };
    ID3D11ShaderResourceView* srv = ptrNormalSrv_.Get();
    ctx_->PSSetShaderResources(0, 1, &srv);
    ctx_->OMSetBlendState(blendAlpha_.Get(), factor, 0xFFFFFFFF);
    ctx_->Draw(4, 0);
    if (ptrInvertSrv_) {
      srv = ptrInvertSrv_.Get();
      ctx_->PSSetShaderResources(0, 1, &srv);
      ctx_->OMSetBlendState(blendInvert_.Get(), factor, 0xFFFFFFFF);
      ctx_->Draw(4, 0);
    }
    ctx_->OMSetBlendState(nullptr, factor, 0xFFFFFFFF);
  }

  // Tone map `srcTex` into `slot`, pointer on top, and wait for the GPU.
  bool Render(ID3D11Texture2D* srcTex, int slot) {
    Com<ID3D11ShaderResourceView> srv;
    if (FAILED(device_->CreateShaderResourceView(srcTex, nullptr, srv.Put()))) {
      // A duplication surface without SHADER_RESOURCE binding: sample a copy.
      D3D11_TEXTURE2D_DESC d = {};
      srcTex->GetDesc(&d);
      D3D11_TEXTURE2D_DESC have = {};
      if (staging_) staging_->GetDesc(&have);
      if (!staging_ || have.Width != d.Width || have.Height != d.Height || have.Format != d.Format) {
        d.Usage = D3D11_USAGE_DEFAULT;
        d.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        d.CPUAccessFlags = 0;
        d.MiscFlags = 0;
        d.MipLevels = 1;
        d.ArraySize = 1;
        d.SampleDesc.Count = 1;
        d.SampleDesc.Quality = 0;
        if (FAILED(device_->CreateTexture2D(&d, nullptr, staging_.Put()))) return false;
      }
      ctx_->CopyResource(staging_.Get(), srcTex);
      if (FAILED(device_->CreateShaderResourceView(staging_.Get(), nullptr, srv.Put()))) return false;
    }
    const bool timing = tsDisjoint_ && tsBegin_ && tsEnd_;
    if (timing) { ctx_->Begin(tsDisjoint_.Get()); ctx_->End(tsBegin_.Get()); }
    const float noRect[4] = { 0, 0, 0, 0 };
    SetParams(fp16_ ? 1.0f : 0.0f, noRect);
    ID3D11RenderTargetView* rtv = slots_[slot].rtv.Get();
    ctx_->OMSetRenderTargets(1, &rtv, nullptr);
    D3D11_VIEWPORT vp = { 0, 0, static_cast<float>(outW_), static_cast<float>(outH_), 0, 1 };
    ctx_->RSSetViewports(1, &vp);
    ctx_->IASetInputLayout(nullptr);
    ctx_->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx_->VSSetShader(vsFull_.Get(), nullptr, 0);
    ctx_->PSSetShader(psTone_.Get(), nullptr, 0);
    ID3D11Buffer* cb = cbuf_.Get();
    ctx_->VSSetConstantBuffers(0, 1, &cb);
    ctx_->PSSetConstantBuffers(0, 1, &cb);
    ID3D11SamplerState* smp = linear_.Get();
    ctx_->PSSetSamplers(0, 1, &smp);
    ID3D11ShaderResourceView* srvp = srv.Get();
    ctx_->PSSetShaderResources(0, 1, &srvp);
    const float factor[4] = { 0, 0, 0, 0 };
    ctx_->OMSetBlendState(nullptr, factor, 0xFFFFFFFF);
    ctx_->Draw(3, 0);
    DrawPointer();
    ID3D11ShaderResourceView* none = nullptr;
    ctx_->PSSetShaderResources(0, 1, &none);
    ctx_->OMSetRenderTargets(0, nullptr, nullptr);
    if (timing) { ctx_->End(tsEnd_.Get()); ctx_->End(tsDisjoint_.Get()); }
    return WaitGpu(timing);
  }

  // Block until the GPU finished this frame: Chromium reads the texture on
  // another device, and Desktop Duplication's surface must not be released
  // while we still sample it.
  bool WaitGpu(bool timing) {
    ctx_->End(done_.Get());
    ctx_->Flush();
    const int64_t t0 = NowUs();
    BOOL done = FALSE;
    while (ctx_->GetData(done_.Get(), &done, sizeof(done), 0) == S_FALSE) {
      if (NowUs() - t0 > kGpuWaitTimeoutUs) return false;
      SwitchToThread();
    }
    s_->waitUsSum += static_cast<uint64_t>(NowUs() - t0);
    if (timing) {
      D3D11_QUERY_DATA_TIMESTAMP_DISJOINT dj = {};
      UINT64 b = 0, e = 0;
      if (ctx_->GetData(tsDisjoint_.Get(), &dj, sizeof(dj), 0) == S_OK && !dj.Disjoint && dj.Frequency &&
          ctx_->GetData(tsBegin_.Get(), &b, sizeof(b), 0) == S_OK &&
          ctx_->GetData(tsEnd_.Get(), &e, sizeof(e), 0) == S_OK && e >= b) {
        const uint64_t us = static_cast<uint64_t>((e - b) * 1000000.0 / dj.Frequency);
        s_->gpuUsSum += us;
        s_->gpuUsCount++;
        uint64_t prev = s_->gpuUsMax.load();
        while (us > prev && !s_->gpuUsMax.compare_exchange_weak(prev, us)) {}
      }
    }
    return true;
  }

  void Emit(int slot) {
    slots_[slot].lastUsedUs = NowUs();
    lastSlot_ = slot;
    lastEmitUs_ = slots_[slot].lastUsedUs;
    s_->busy.fetch_or(1u << slot);
    s_->frames++;
    auto* ev = new Event(EvType::Frame);
    ev->slot = slot;
    ev->timestampUs = lastEmitUs_;
    Post(s_, ev);
  }

  void PostParams() {
    auto* ev = new Event(EvType::Params);
    ev->hdr = hdr_;
    ev->inputFormat = fp16_ ? "fp16" : "bgra8";
    ev->sdrWhiteNits = tone_.sdrWhiteNits;
    ev->peakNits = tone_.peakNits;
    ev->knee = tone_.knee;
    Post(s_, ev);
  }

  std::string Loop() {
    const int64_t intervalUs = static_cast<int64_t>(1000000.0 / std::max(1.0, std::min(s_->opts.maxFps, 240.0)));
    int64_t nextDue = NowUs();
    std::vector<uint8_t> shapeBuf;
    while (!s_->stop.load()) {
      WaitUntil(nextDue);
      if (s_->stop.load()) break;
      if (!dupl_) {
        // Access was lost (mode change, a fullscreen app switching modes,
        // the secure desktop): retry until it comes back or the display goes.
        std::wstring name;
        if (!GdiNameForIndex(s_->opts.index, &name) || name != gdiName_) return "display_gone";
        std::string err;
        if (!Duplicate(&err)) {
          if (err == "not_hdr" || err == "rotated") return err;  // a different share now: let JS fall back
          nextDue = NowUs() + 250000;
          continue;
        }
        s_->redups++;
        PostParams();
      }
      DXGI_OUTDUPL_FRAME_INFO fi = {};
      Com<IDXGIResource> res;
      HRESULT hr = dupl_->AcquireNextFrame(kAcquireTimeoutMs, &fi, res.Put());
      if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        // A still desktop sends nothing; keep the encoder fed at 1 fps.
        if (lastSlot_ >= 0 && NowUs() - lastEmitUs_ >= kIdleRepeatUs) {
          const int slot = PickSlot();
          if (slot >= 0) {
            ctx_->CopyResource(slots_[slot].tex.Get(), slots_[lastSlot_].tex.Get());
            if (WaitGpu(false)) { s_->repeats++; Emit(slot); }
          }
        }
        continue;
      }
      if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) { dupl_.Reset(); continue; }
      if (FAILED(hr)) { dupl_.Reset(); nextDue = NowUs() + 250000; continue; }

      if (fi.LastMouseUpdateTime.QuadPart != 0) {
        ptrVisible_ = fi.PointerPosition.Visible != FALSE;
        ptrX_ = static_cast<float>(fi.PointerPosition.Position.x);
        ptrY_ = static_cast<float>(fi.PointerPosition.Position.y);
      }
      if (fi.PointerShapeBufferSize > 0) {
        shapeBuf.resize(fi.PointerShapeBufferSize);
        UINT needed = 0;
        DXGI_OUTDUPL_POINTER_SHAPE_INFO si = {};
        if (SUCCEEDED(dupl_->GetFramePointerShape(static_cast<UINT>(shapeBuf.size()), shapeBuf.data(), &needed, &si))) {
          UpdatePointerShape(si, shapeBuf);
        }
      }

      bool lost = false;
      if (fi.LastPresentTime.QuadPart != 0 || fi.LastMouseUpdateTime.QuadPart != 0) {
        const int slot = PickSlot();
        Com<ID3D11Texture2D> tex;
        if (slot < 0) {
          s_->dropped++;  // the consumer still holds every slot
        } else if (SUCCEEDED(res.As(tex))) {
          if (Render(tex.Get(), slot)) Emit(slot);
          else s_->dropped++;
        }
      }
      hr = dupl_->ReleaseFrame();
      if (hr == DXGI_ERROR_ACCESS_LOST) lost = true;
      if (lost) dupl_.Reset();
      nextDue += intervalUs;
      const int64_t now = NowUs();
      if (nextDue < now - intervalUs) nextDue = now;  // fell behind: do not burst
    }
    return "stopped";
  }

  void ReleaseAll() {
    if (dupl_) dupl_.Reset();
    for (auto& s : slots_) {
      if (s.handle) { CloseHandle(s.handle); s.handle = nullptr; }
      s.rtv.Reset();
      s.tex.Reset();
    }
    if (timer_) { CloseHandle(timer_); timer_ = nullptr; }
  }

  Session* s_;
  std::wstring gdiName_;
  OutputMatch match_;
  Com<ID3D11Device> device_;
  Com<ID3D11DeviceContext> ctx_;
  Com<IDXGIOutputDuplication> dupl_;
  Com<ID3D11VertexShader> vsFull_, vsQuad_;
  Com<ID3D11PixelShader> psTone_, psTex_;
  Com<ID3D11Buffer> cbuf_;
  Com<ID3D11SamplerState> linear_, point_;
  Com<ID3D11BlendState> blendAlpha_, blendInvert_;
  Com<ID3D11Query> done_, tsDisjoint_, tsBegin_, tsEnd_;
  Com<ID3D11Texture2D> ptrNormal_, ptrInvert_, staging_;
  Com<ID3D11ShaderResourceView> ptrNormalSrv_, ptrInvertSrv_;
  Slot slots_[kSlots];
  HANDLE timer_ = nullptr;
  UINT srcW_ = 0, srcH_ = 0, outW_ = 0, outH_ = 0;
  bool hdr_ = false, fp16_ = false;
  ToneParams tone_ = { kDefaultSdrWhiteNits, kDefaultPeakNits, kDefaultKnee };
  bool ptrVisible_ = false;
  float ptrX_ = 0, ptrY_ = 0;
  UINT ptrW_ = 0, ptrH_ = 0;
  int lastSlot_ = -1;
  int64_t lastEmitUs_ = 0;
};

// ── N-API plumbing ──────────────────────────────────────────────────────────
void SetStr(napi_env env, napi_value obj, const char* k, const std::string& v) {
  napi_value x; napi_create_string_utf8(env, v.c_str(), v.size(), &x); napi_set_named_property(env, obj, k, x);
}
void SetNum(napi_env env, napi_value obj, const char* k, double v) {
  napi_value x; napi_create_double(env, v, &x); napi_set_named_property(env, obj, k, x);
}
void SetBool(napi_env env, napi_value obj, const char* k, bool v) {
  napi_value x; napi_get_boolean(env, v, &x); napi_set_named_property(env, obj, k, x);
}

void CallJs(napi_env env, napi_value cb, void* /*context*/, void* data) {
  Event* ev = static_cast<Event*>(data);
  if (env && cb) {
    napi_value obj;
    napi_create_object(env, &obj);
    switch (ev->type) {
      case EvType::Started: {
        SetStr(env, obj, "type", "started");
        SetNum(env, obj, "generation", ev->generation);
        SetNum(env, obj, "width", ev->width);
        SetNum(env, obj, "height", ev->height);
        SetNum(env, obj, "srcWidth", ev->srcWidth);
        SetNum(env, obj, "srcHeight", ev->srcHeight);
        SetBool(env, obj, "hdr", ev->hdr);
        SetStr(env, obj, "inputFormat", ev->inputFormat);
        SetNum(env, obj, "sdrWhiteNits", ev->sdrWhiteNits);
        SetNum(env, obj, "peakNits", ev->peakNits);
        SetNum(env, obj, "knee", ev->knee);
        napi_value arr;
        napi_create_array_with_length(env, kSlots, &arr);
        for (uint32_t i = 0; i < kSlots; ++i) {
          // Electron reads `ntHandle` as the handle value in native byte order.
          napi_value buf;
          void* out = nullptr;
          napi_create_buffer_copy(env, sizeof(uintptr_t), &ev->handles[i], &out, &buf);
          napi_set_element(env, arr, i, buf);
        }
        napi_set_named_property(env, obj, "handles", arr);
        break;
      }
      case EvType::Frame:
        SetStr(env, obj, "type", "frame");
        SetNum(env, obj, "slot", ev->slot);
        SetNum(env, obj, "timestampUs", static_cast<double>(ev->timestampUs));
        break;
      case EvType::Params:
        SetStr(env, obj, "type", "params");
        SetBool(env, obj, "hdr", ev->hdr);
        SetStr(env, obj, "inputFormat", ev->inputFormat);
        SetNum(env, obj, "sdrWhiteNits", ev->sdrWhiteNits);
        SetNum(env, obj, "peakNits", ev->peakNits);
        SetNum(env, obj, "knee", ev->knee);
        break;
      case EvType::Error:
        SetStr(env, obj, "type", "error");
        SetStr(env, obj, "error", ev->text);
        break;
      case EvType::Ended:
        SetStr(env, obj, "type", "ended");
        SetStr(env, obj, "reason", ev->text);
        break;
    }
    napi_value global, ignored;
    napi_get_global(env, &global);
    napi_call_function(env, global, cb, 1, &obj, &ignored);
    // A throwing listener must not take the process down.
    bool pending = false;
    napi_is_exception_pending(env, &pending);
    if (pending) { napi_value e; napi_get_and_clear_last_exception(env, &e); }
  } else if (ev->type == EvType::Frame && ev->slot >= 0) {
    // Teardown: nobody will release this slot.
  }
  delete ev;
}

void StopLocked() {
  Session* s = g_session;
  g_session = nullptr;
  if (!s) return;
  s->stop = true;
  if (s->thread.joinable()) s->thread.join();
  if (s->tsfn) {
    napi_release_threadsafe_function(s->tsfn, napi_tsfn_abort);
    s->tsfn = nullptr;
  }
  delete s;
}

bool GetNumProp(napi_env env, napi_value obj, const char* key, double* out) {
  bool has = false;
  if (napi_has_named_property(env, obj, key, &has) != napi_ok || !has) return false;
  napi_value v;
  napi_valuetype t;
  if (napi_get_named_property(env, obj, key, &v) != napi_ok || napi_typeof(env, v, &t) != napi_ok) return false;
  if (t == napi_boolean) { bool b = false; napi_get_value_bool(env, v, &b); *out = b ? 1 : 0; return true; }
  if (t != napi_number) return false;
  return napi_get_value_double(env, v, out) == napi_ok && std::isfinite(*out);
}

napi_value Fail(napi_env env, const char* why) {
  napi_value obj;
  napi_create_object(env, &obj);
  SetBool(env, obj, "ok", false);
  SetStr(env, obj, "error", why);
  return obj;
}

}  // namespace

static napi_value HdrGetDisplays(napi_env env, napi_callback_info /*info*/) {
  napi_value arr;
  napi_create_array(env, &arr);
  uint32_t n = 0;
  for (int index = 0; index < 64; ++index) {
    DISPLAY_DEVICEW dd = {};
    dd.cb = sizeof(dd);
    if (!EnumDisplayDevicesW(nullptr, static_cast<DWORD>(index), &dd, 0)) break;
    if (!(dd.StateFlags & DISPLAY_DEVICE_ACTIVE)) continue;
    napi_value o;
    napi_create_object(env, &o);
    SetNum(env, o, "index", index);
    SetStr(env, o, "deviceName", Utf8(dd.DeviceName));
    OutputMatch m;
    std::string err;
    const bool found = FindOutput(dd.DeviceName, &m, &err);
    SetBool(env, o, "hdr", found && IsHdrColorSpace(m));
    if (found) {
      SetNum(env, o, "left", m.desc.DesktopCoordinates.left);
      SetNum(env, o, "top", m.desc.DesktopCoordinates.top);
      SetNum(env, o, "width", m.desc.DesktopCoordinates.right - m.desc.DesktopCoordinates.left);
      SetNum(env, o, "height", m.desc.DesktopCoordinates.bottom - m.desc.DesktopCoordinates.top);
      SetNum(env, o, "rotation", m.desc.Rotation);
      SetBool(env, o, "sameAdapterAsDefault", m.sameAdapterAsDefault);
      if (m.hasDesc1) {
        SetNum(env, o, "colorSpace", m.desc1.ColorSpace);
        SetNum(env, o, "bitsPerColor", m.desc1.BitsPerColor);
        SetNum(env, o, "minLuminance", m.desc1.MinLuminance);
        SetNum(env, o, "maxLuminance", m.desc1.MaxLuminance);
        SetNum(env, o, "maxFullFrameLuminance", m.desc1.MaxFullFrameLuminance);
      }
    }
    SetNum(env, o, "sdrWhiteNits", SdrWhiteNitsFor(dd.DeviceName));
    napi_set_element(env, arr, n++, o);
  }
  return arr;
}

static napi_value HdrCaptureStart(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype t0 = napi_undefined, t1 = napi_undefined;
  if (argc >= 1) napi_typeof(env, argv[0], &t0);
  if (argc >= 2) napi_typeof(env, argv[1], &t1);
  if (t0 != napi_object || t1 != napi_function) return Fail(env, "bad_arguments");

  StartOptions o;
  double v = 0;
  if (!GetNumProp(env, argv[0], "index", &v) || v < 0 || v > 63 || v != std::floor(v)) return Fail(env, "bad_index");
  o.index = static_cast<int>(v);
  if (GetNumProp(env, argv[0], "width", &v) && v >= 2 && v <= 16384) o.width = static_cast<UINT>(v) & ~1u;
  if (GetNumProp(env, argv[0], "height", &v) && v >= 2 && v <= 16384) o.height = static_cast<UINT>(v) & ~1u;
  if (GetNumProp(env, argv[0], "maxFps", &v) && v >= 1 && v <= 240) o.maxFps = v;
  if (GetNumProp(env, argv[0], "sdrWhiteNits", &v) && v > 0) o.sdrWhiteNits = static_cast<float>(v);
  if (GetNumProp(env, argv[0], "peakNits", &v) && v > 0) o.peakNits = static_cast<float>(v);
  if (GetNumProp(env, argv[0], "knee", &v) && v > 0) o.knee = static_cast<float>(v);
  if (GetNumProp(env, argv[0], "force", &v)) o.force = v != 0;

  std::lock_guard<std::mutex> lock(g_mu);
  StopLocked();
  auto* s = new Session();
  s->opts = o;
  s->generation = ++g_generation;
  napi_value name;
  napi_create_string_utf8(env, "hdr_capture", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[1], nullptr, name, 64, 1, nullptr, nullptr, nullptr, CallJs, &s->tsfn) != napi_ok) {
    delete s;
    return Fail(env, "tsfn");
  }
  // The callback must not keep the process alive on its own.
  napi_unref_threadsafe_function(env, s->tsfn);
  g_session = s;
  s->thread = std::thread([s] {
    // COM is not needed by D3D11/DXGI; the thread stays apartment-free.
    Capturer c(s);
    c.Run();
  });
  napi_value ok;
  napi_create_object(env, &ok);
  SetBool(env, ok, "ok", true);
  return ok;
}

static napi_value HdrCaptureRelease(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  int32_t slot = -1;
  uint32_t generation = 0;
  if (argc >= 1) napi_get_value_int32(env, argv[0], &slot);
  if (argc >= 2) napi_get_value_uint32(env, argv[1], &generation);
  std::lock_guard<std::mutex> lock(g_mu);
  if (g_session && g_session->generation == generation && slot >= 0 && slot < kSlots) {
    g_session->busy.fetch_and(~(1u << slot));
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value HdrCaptureStop(napi_env env, napi_callback_info /*info*/) {
  {
    std::lock_guard<std::mutex> lock(g_mu);
    StopLocked();
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static napi_value HdrCaptureStats(napi_env env, napi_callback_info /*info*/) {
  std::lock_guard<std::mutex> lock(g_mu);
  if (!g_session) { napi_value n; napi_get_null(env, &n); return n; }
  Session* s = g_session;
  napi_value o;
  napi_create_object(env, &o);
  SetBool(env, o, "running", s->running.load());
  SetNum(env, o, "frames", static_cast<double>(s->frames.load()));
  SetNum(env, o, "dropped", static_cast<double>(s->dropped.load()));
  SetNum(env, o, "repeats", static_cast<double>(s->repeats.load()));
  SetNum(env, o, "reduplications", static_cast<double>(s->redups.load()));
  const uint64_t cnt = s->gpuUsCount.load();
  SetNum(env, o, "gpuUsAvg", cnt ? static_cast<double>(s->gpuUsSum.load()) / cnt : 0.0);
  SetNum(env, o, "gpuUsMax", static_cast<double>(s->gpuUsMax.load()));
  const uint64_t fr = s->frames.load();
  SetNum(env, o, "waitUsAvg", fr ? static_cast<double>(s->waitUsSum.load()) / fr : 0.0);
  uint32_t busy = s->busy.load(), nBusy = 0;
  for (int i = 0; i < kSlots; ++i) if (busy & (1u << i)) ++nBusy;
  SetNum(env, o, "slotsBusy", nBusy);
  return o;
}

#else  // !_WIN32

static napi_value HdrGetDisplays(napi_env env, napi_callback_info) {
  napi_value arr; napi_create_array(env, &arr); return arr;
}
static napi_value HdrCaptureStart(napi_env env, napi_callback_info) {
  napi_value o, f, s;
  napi_create_object(env, &o);
  napi_get_boolean(env, false, &f);
  napi_set_named_property(env, o, "ok", f);
  napi_create_string_utf8(env, "unsupported", NAPI_AUTO_LENGTH, &s);
  napi_set_named_property(env, o, "error", s);
  return o;
}
static napi_value HdrCaptureRelease(napi_env env, napi_callback_info) { napi_value u; napi_get_undefined(env, &u); return u; }
static napi_value HdrCaptureStop(napi_env env, napi_callback_info) { napi_value u; napi_get_undefined(env, &u); return u; }
static napi_value HdrCaptureStats(napi_env env, napi_callback_info) { napi_value n; napi_get_null(env, &n); return n; }

#endif  // _WIN32

void RegisterHdrCapture(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, nullptr, 0, HdrGetDisplays, nullptr, &fn);
  napi_set_named_property(env, exports, "hdrGetDisplays", fn);
  napi_create_function(env, nullptr, 0, HdrCaptureStart, nullptr, &fn);
  napi_set_named_property(env, exports, "hdrCaptureStart", fn);
  napi_create_function(env, nullptr, 0, HdrCaptureRelease, nullptr, &fn);
  napi_set_named_property(env, exports, "hdrCaptureRelease", fn);
  napi_create_function(env, nullptr, 0, HdrCaptureStop, nullptr, &fn);
  napi_set_named_property(env, exports, "hdrCaptureStop", fn);
  napi_create_function(env, nullptr, 0, HdrCaptureStats, nullptr, &fn);
  napi_set_named_property(env, exports, "hdrCaptureStats", fn);
}
