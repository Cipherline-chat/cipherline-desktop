/**
 * audio_output_kind.cc - "is the OUTPUT device speakers or headphones?", linked
 * into the audio_capture addon (one native module to build).
 *
 * WHY. Echo cancellation defaults to ON when you are on speakers and OFF on
 * headphones (src/utils/outputKind.ts, echoCancellationAuto). Chromium gives us
 * only a device label for an `audiooutput`, and labels lie ("Speakers (USB
 * Headset)", "Headphones/Speakers (Realtek)"). The operating system KNOWS what
 * the endpoint is, so this asks it.
 *
 * Export (registered by RegisterAudioOutputKind, called from RegisterSharePower
 * so this file needs no edit to the three per-platform addon Init functions):
 *
 *   getAudioOutputEndpoints() -> Array<{
 *       name: string,                // the endpoint's display name (matches Chromium's label)
 *       isDefault: boolean,          // the system default render device (console role)
 *       isCommunications: boolean,   // the default communications device (Windows)
 *       formFactor?: number,         // Windows: EndpointFormFactor 0-10, absent if unreadable
 *       jackSubType?: string,        // Windows: KSNODETYPE GUID of the jack, lowercase, no braces
 *       transport?: string,          // macOS: kAudioDeviceTransportType FourCC ('bltn','usb ','blue','hdmi'...)
 *       dataSource?: string,         // macOS: active data source FourCC ('ispk' = internal speaker, 'hdpn' = headphones)
 *   }>
 *
 * Returns [] on any failure or on Linux (Linux asks PulseAudio / PipeWire from JS,
 * electron/audio-output-facts.ts). It never throws, never writes anything, and
 * reads nothing but the device's own descriptive properties - no audio, no
 * application or user data.
 *
 * Windows: IMMDeviceEnumerator::EnumAudioEndpoints(eRender, ACTIVE), then per
 * endpoint IPropertyStore PKEY_Device_FriendlyName, PKEY_AudioEndpoint_FormFactor
 * and PKEY_AudioEndpoint_JackSubType. Synchronous and short (a handful of
 * property reads); the caller caches the answer and only re-asks on a device change.
 * macOS: CoreAudio AudioObject properties (device list, output stream config,
 * name, transport type, kAudioDevicePropertyDataSource on the output scope).
 */

#include <node_api.h>

#include <stdint.h>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <objbase.h>
#endif

#ifdef __APPLE__
#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace {

struct Endpoint {
    std::string name;
    bool isDefault = false;
    bool isCommunications = false;
    int formFactor = -1;      // Windows
    std::string jackSubType;  // Windows
    std::string transport;    // macOS
    std::string dataSource;   // macOS
};

#ifdef _WIN32

// Declared locally rather than pulling in functiondiscoverykeys_devpkey.h: its
// DEFINE_PROPERTYKEY needs INITGUID (or propsys) to emit storage, and getting that
// wrong is a link error on a machine we cannot test here.
// PKEY_Device_FriendlyName          {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
// PKEY_AudioEndpoint_FormFactor     {1da5d803-d492-4edd-8c23-e0c0ffee7f0e}, 0   (VT_UI4)
// PKEY_AudioEndpoint_JackSubType    {1da5d803-d492-4edd-8c23-e0c0ffee7f0e}, 8   (VT_LPWSTR GUID)
const PROPERTYKEY kPkeyFriendlyName = {{0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};
const PROPERTYKEY kPkeyFormFactor   = {{0x1da5d803, 0xd492, 0x4edd, {0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e}}, 0};
const PROPERTYKEY kPkeyJackSubType  = {{0x1da5d803, 0xd492, 0x4edd, {0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e}}, 8};

// CLSID_MMDeviceEnumerator / IID_IMMDeviceEnumerator spelled out for the same reason
// (no dependency on uuid.lib having the right object); both are stable, documented values.
const CLSID kClsidMMDeviceEnumerator = {0xBCDE0395, 0xE52F, 0x467C, {0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E}};
const IID   kIidMMDeviceEnumerator   = {0xA95664D2, 0x9614, 0x4F35, {0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6}};

std::string WideToUtf8(const wchar_t* w) {
    if (!w) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return std::string();
    std::string s((size_t)n - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
    return s;
}

std::string DeviceId(IMMDevice* d) {
    if (!d) return std::string();
    LPWSTR id = nullptr;
    std::string out;
    if (SUCCEEDED(d->GetId(&id)) && id) out = WideToUtf8(id);
    if (id) CoTaskMemFree(id);
    return out;
}

// "{DFF21CE2-F70F-11D0-B917-00A0C9223196}" -> "dff21ce2-f70f-11d0-b917-00a0c9223196"
std::string NormalizeGuid(const std::string& g) {
    std::string out;
    for (char c : g) {
        if (c == '{' || c == '}') continue;
        out.push_back((char)((c >= 'A' && c <= 'Z') ? c - 'A' + 'a' : c));
    }
    return out;
}

bool Collect(std::vector<Endpoint>& out) {
    // The addon loads after app ready on the main thread, which Chromium already
    // initialised (STA). S_OK / S_FALSE both need a matching CoUninitialize; a
    // RPC_E_CHANGED_MODE thread is already initialised the other way: use COM as-is.
    HRESULT coHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    bool balance = SUCCEEDED(coHr);
    if (FAILED(coHr) && coHr != RPC_E_CHANGED_MODE) return false;

    IMMDeviceEnumerator* en = nullptr;
    IMMDeviceCollection* coll = nullptr;
    bool ok = false;
    do {
        if (FAILED(CoCreateInstance(kClsidMMDeviceEnumerator, nullptr, CLSCTX_ALL, kIidMMDeviceEnumerator, (void**)&en)) || !en) break;

        std::string defId, commId;
        IMMDevice* d = nullptr;
        if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &d)) && d) { defId = DeviceId(d); d->Release(); d = nullptr; }
        if (SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eCommunications, &d)) && d) { commId = DeviceId(d); d->Release(); d = nullptr; }

        if (FAILED(en->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll)) || !coll) break;
        UINT count = 0;
        if (FAILED(coll->GetCount(&count))) break;
        for (UINT i = 0; i < count && i < 64; i++) {
            IMMDevice* dev = nullptr;
            if (FAILED(coll->Item(i, &dev)) || !dev) continue;
            Endpoint ep;
            std::string id = DeviceId(dev);
            ep.isDefault = !id.empty() && id == defId;
            ep.isCommunications = !id.empty() && id == commId;
            IPropertyStore* ps = nullptr;
            if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &ps)) && ps) {
                PROPVARIANT pv;
                PropVariantInit(&pv);
                if (SUCCEEDED(ps->GetValue(kPkeyFriendlyName, &pv)) && pv.vt == VT_LPWSTR) ep.name = WideToUtf8(pv.pwszVal);
                PropVariantClear(&pv);
                PropVariantInit(&pv);
                if (SUCCEEDED(ps->GetValue(kPkeyFormFactor, &pv)) && pv.vt == VT_UI4) ep.formFactor = (int)pv.ulVal;
                PropVariantClear(&pv);
                PropVariantInit(&pv);
                if (SUCCEEDED(ps->GetValue(kPkeyJackSubType, &pv)) && pv.vt == VT_LPWSTR) ep.jackSubType = NormalizeGuid(WideToUtf8(pv.pwszVal));
                PropVariantClear(&pv);
                ps->Release();
            }
            dev->Release();
            if (!ep.name.empty()) out.push_back(ep);
        }
        ok = true;
    } while (false);

    if (coll) coll->Release();
    if (en) en->Release();
    if (balance) CoUninitialize();
    return ok;
}

#elif defined(__APPLE__)

std::string FourCC(UInt32 v) {
    char c[5] = {(char)((v >> 24) & 0xff), (char)((v >> 16) & 0xff), (char)((v >> 8) & 0xff), (char)(v & 0xff), 0};
    for (int i = 0; i < 4; i++) if (c[i] < 0x20 || c[i] > 0x7e) c[i] = '?';
    return std::string(c);
}

bool Collect(std::vector<Endpoint>& out) {
    // 0 == kAudioObjectPropertyElementMain (Master before macOS 12); a literal keeps one source for both SDKs.
    const AudioObjectPropertyElement kElem = 0;

    AudioObjectPropertyAddress devs = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kElem};
    UInt32 size = 0;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &devs, 0, nullptr, &size) != noErr || size == 0) return false;
    std::vector<AudioDeviceID> ids(size / sizeof(AudioDeviceID));
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &devs, 0, nullptr, &size, ids.data()) != noErr) return false;

    AudioDeviceID defOut = kAudioObjectUnknown;
    AudioObjectPropertyAddress defAddr = {kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kElem};
    UInt32 dsz = sizeof(defOut);
    AudioObjectGetPropertyData(kAudioObjectSystemObject, &defAddr, 0, nullptr, &dsz, &defOut);

    for (size_t i = 0; i < ids.size() && out.size() < 64; i++) {
        AudioDeviceID id = ids[i];

        // Has at least one output channel?
        AudioObjectPropertyAddress cfg = {kAudioDevicePropertyStreamConfiguration, kAudioObjectPropertyScopeOutput, kElem};
        UInt32 csz = 0;
        if (AudioObjectGetPropertyDataSize(id, &cfg, 0, nullptr, &csz) != noErr || csz < sizeof(AudioBufferList)) continue;
        std::vector<unsigned char> buf(csz);
        if (AudioObjectGetPropertyData(id, &cfg, 0, nullptr, &csz, buf.data()) != noErr) continue;
        AudioBufferList* abl = reinterpret_cast<AudioBufferList*>(buf.data());
        UInt32 channels = 0;
        for (UInt32 b = 0; b < abl->mNumberBuffers; b++) channels += abl->mBuffers[b].mNumberChannels;
        if (channels == 0) continue;

        Endpoint ep;
        ep.isDefault = (id == defOut);

        AudioObjectPropertyAddress nameAddr = {kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, kElem};
        CFStringRef cf = nullptr;
        UInt32 nsz = sizeof(cf);
        if (AudioObjectGetPropertyData(id, &nameAddr, 0, nullptr, &nsz, &cf) == noErr && cf) {
            char tmp[256];
            if (CFStringGetCString(cf, tmp, sizeof(tmp), kCFStringEncodingUTF8)) ep.name = tmp;
            CFRelease(cf);
        }

        AudioObjectPropertyAddress tr = {kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kElem};
        UInt32 tv = 0, tsz = sizeof(tv);
        if (AudioObjectGetPropertyData(id, &tr, 0, nullptr, &tsz, &tv) == noErr) ep.transport = FourCC(tv);

        // The active data source: a built-in output reports 'ispk' (internal speaker) or
        // 'hdpn' (headphone jack); it is how macOS itself tells them apart.
        AudioObjectPropertyAddress ds = {kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput, kElem};
        if (AudioObjectHasProperty(id, &ds)) {
            UInt32 sv = 0, ssz = sizeof(sv);
            if (AudioObjectGetPropertyData(id, &ds, 0, nullptr, &ssz, &sv) == noErr) ep.dataSource = FourCC(sv);
        }
        if (!ep.name.empty()) out.push_back(ep);
    }
    return true;
}

#else

bool Collect(std::vector<Endpoint>&) { return false; }

#endif

napi_value SetStr(napi_env env, napi_value obj, const char* key, const std::string& v) {
    napi_value s;
    if (napi_create_string_utf8(env, v.c_str(), v.size(), &s) == napi_ok) napi_set_named_property(env, obj, key, s);
    return obj;
}

void SetBool(napi_env env, napi_value obj, const char* key, bool v) {
    napi_value b;
    if (napi_get_boolean(env, v, &b) == napi_ok) napi_set_named_property(env, obj, key, b);
}

napi_value GetAudioOutputEndpoints(napi_env env, napi_callback_info) {
    napi_value arr;
    napi_create_array(env, &arr);
    std::vector<Endpoint> eps;
    // A fault inside a vendor COM object must not take the main process down with it.
    bool ok = false;
    try { ok = Collect(eps); } catch (...) { ok = false; }
    if (!ok) return arr;
    for (size_t i = 0; i < eps.size(); i++) {
        napi_value o;
        napi_create_object(env, &o);
        SetStr(env, o, "name", eps[i].name);
        SetBool(env, o, "isDefault", eps[i].isDefault);
        SetBool(env, o, "isCommunications", eps[i].isCommunications);
        if (eps[i].formFactor >= 0) {
            napi_value n;
            napi_create_int32(env, eps[i].formFactor, &n);
            napi_set_named_property(env, o, "formFactor", n);
        }
        if (!eps[i].jackSubType.empty()) SetStr(env, o, "jackSubType", eps[i].jackSubType);
        if (!eps[i].transport.empty()) SetStr(env, o, "transport", eps[i].transport);
        if (!eps[i].dataSource.empty()) SetStr(env, o, "dataSource", eps[i].dataSource);
        napi_set_element(env, arr, (uint32_t)i, o);
    }
    return arr;
}

}  // namespace

void RegisterAudioOutputKind(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "getAudioOutputEndpoints", NAPI_AUTO_LENGTH, GetAudioOutputEndpoints, nullptr, &fn) == napi_ok) {
        napi_set_named_property(env, exports, "getAudioOutputEndpoints", fn);
    }
}
