/**
 * audio_capture_linux.cc — PipeWire per-application audio capture (Linux)
 *
 * The Linux counterpart of audio_capture.cc (WASAPI) and audio_capture_mac.mm
 * (ScreenCaptureKit). Built as the SAME addon name (`audio_capture`) with the
 * SAME JS surface, so electron/main.ts, the preload bridge and the renderer's
 * native-audio path run unchanged:
 *
 *   isSupported(): boolean
 *       true only when libpipewire-0.3 loads, the PipeWire daemon accepts a
 *       connection AND an audio sink exists (i.e. PipeWire really is this
 *       desktop's audio server, not just a screen-capture daemon). Cached for a
 *       few seconds; never a blocking connect per call.
 *   getPidFromSourceId(sourceId: string): number | null
 *       'window:<xid>:<n>' on X11 -> the window's _NET_WM_PID (libX11 loaded at
 *       run time). Screens, Wayland/portal windows and anything unparseable ->
 *       null (the renderer then says so instead of sending silence).
 *   startCapture(pid, mode: 'include' | 'exclude', callback): void
 *       exclude : every application's audio EXCEPT the process tree rooted at
 *                 `pid` (full-screen share, pid = Cipherline -> no call echo).
 *       include : audio of the process tree rooted at `pid` ONLY.
 *       callback receives, on the Node main thread, one of
 *         { sampleRate: 48000, channels: 2, data: Buffer }  float32 interleaved, 10 ms
 *         { processExited: true }                           include-target quit (terminal)
 *         { failed: true, reason, message }                 could not start / died (terminal)
 *       app     : audio of ONE application only, picked from listApps() (Wayland window shares, where
 *                 the window's pid is not known). `pid` is Cipherline's own pid and is still EXCLUDED
 *                 (call audio is never offered or captured); the 4th argument is the app's key.
 *                 Streams the app opens later are linked as they appear. { processExited } is sent
 *                 once every process the app was seen as is gone and none of its streams remain.
 *   listApps(ownPid): Array<{ key, name, binary, streams }>
 *       the applications that have a playback stream right now, one entry per application
 *       (application.process.binary + application.name), with the tree of `ownPid` left out.
 *       Synchronous (one short PipeWire round trip); [] when PipeWire is unavailable.
 *   stopCapture(): void   (idempotent; safe with nothing running)
 *
 * HOW (and why this is not Chromium's loopback): we create ONE capture
 * pw_stream that is deliberately NOT auto-connected, watch the PipeWire
 * registry for every playback stream node (media.class "Stream/Output/Audio"),
 * and for each one whose owning process is allowed by the mode we create
 * link-factory links from that node's output ports to our stream's input ports.
 * Nothing is moved, rerouted or muted: the application keeps playing to the
 * user's speakers exactly as before, we just also listen to it. Streams that
 * appear later are linked as they appear; streams that go away are forgotten.
 * Chromium/Electron play audio from a CHILD utility process, so "belongs to
 * pid" means "pid is that process or any ancestor of it is" (/proc/<pid>/stat).
 *
 * PipeWire is loaded with dlopen("libpipewire-0.3.so.0") at run time and is NOT
 * linked: if it is missing (PulseAudio-only desktops, Ubuntu 22.04, minimal
 * containers) the addon still loads — window_geometry / share_power /
 * hdr_capture keep working — and isSupported() is false. The PipeWire/SPA
 * HEADERS (MIT) are vendored under third_party/pipewire so the build is
 * hermetic; only inline header code and function-pointer types are used from
 * them (verify: `nm -D --undefined-only audio_capture.node | grep pw_` is empty).
 *
 * Privacy: nothing about WHAT is playing is logged — no stream, application or
 * media names. Debug output (CIPHERLINE_AUDIO_DEBUG=1) carries counts only.
 *
 * Raw N-API (node_api.h), like the other addons — no node-addon-api.
 */

#include <node_api.h>

#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <spa/param/audio/format-utils.h>
#include <spa/utils/dict.h>
#include <spa/utils/hook.h>
#include <pipewire/pipewire.h>

// ────────────────────────────────────────────────────────────────────────────
// Debug logging — counts only, off unless asked for
// ────────────────────────────────────────────────────────────────────────────

static bool DebugOn() {
    static int v = -1;
    if (v < 0) { const char* e = getenv("CIPHERLINE_AUDIO_DEBUG"); v = (e && *e && *e != '0') ? 1 : 0; }
    return v == 1;
}
#define DBG(...) do { if (DebugOn()) { fprintf(stderr, "[audio_capture_linux] " __VA_ARGS__); fputc('\n', stderr); } } while (0)

// ────────────────────────────────────────────────────────────────────────────
// libpipewire, resolved at run time
// ────────────────────────────────────────────────────────────────────────────

#define PW_SYMBOLS(X) \
    X(pw_init) \
    X(pw_thread_loop_new) X(pw_thread_loop_destroy) X(pw_thread_loop_start) X(pw_thread_loop_stop) \
    X(pw_thread_loop_lock) X(pw_thread_loop_unlock) X(pw_thread_loop_signal) \
    X(pw_thread_loop_timed_wait) X(pw_thread_loop_get_loop) \
    X(pw_context_new) X(pw_context_destroy) X(pw_context_connect) \
    X(pw_core_disconnect) X(pw_proxy_destroy) X(pw_proxy_get_id) \
    X(pw_properties_new) X(pw_properties_set) X(pw_properties_free) \
    X(pw_stream_new) X(pw_stream_destroy) X(pw_stream_add_listener) X(pw_stream_connect) \
    X(pw_stream_dequeue_buffer) X(pw_stream_queue_buffer) X(pw_stream_get_node_id)

// Function-pointer types, taken from the vendored headers' own declarations (never called directly).
#define X(n) using T_##n = decltype(&n);
PW_SYMBOLS(X)
#undef X

struct PwApi {
#define X(n) T_##n n = nullptr;
    PW_SYMBOLS(X)
#undef X
    void* lib = nullptr;
    bool ok = false;
};

static PwApi g_pw;

static void LoadPipeWire() {
    static std::once_flag once;
    std::call_once(once, [] {
        void* lib = dlopen("libpipewire-0.3.so.0", RTLD_NOW | RTLD_LOCAL);
        if (!lib) { DBG("libpipewire-0.3.so.0 not available"); return; }
        bool all = true;
#define X(n) g_pw.n = reinterpret_cast<T_##n>(dlsym(lib, #n)); if (!g_pw.n) all = false;
        PW_SYMBOLS(X)
#undef X
        if (!all) { DBG("libpipewire is missing symbols we need"); dlclose(lib); PwApi blank; g_pw = blank; return; }
        g_pw.lib = lib;
        g_pw.pw_init(nullptr, nullptr);
        g_pw.ok = true;
    });
}

// ────────────────────────────────────────────────────────────────────────────
// Process tree: "does `pid` belong to the tree rooted at `root`?"
// Chromium/Electron spread audio across helper processes (the audio service
// is a child of the browser process), so "the app" is the whole tree.
// ────────────────────────────────────────────────────────────────────────────

static pid_t ParentOf(pid_t pid) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
    FILE* f = fopen(path, "r");
    if (!f) return -1;
    char buf[1024];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = 0;
    // "pid (comm) S ppid ..." — comm may contain spaces and ')', so anchor on the LAST ')'.
    const char* rp = strrchr(buf, ')');
    if (!rp) return -1;
    char state = 0;
    long ppid = -1;
    if (sscanf(rp + 1, " %c %ld", &state, &ppid) != 2) return -1;
    return (pid_t)ppid;
}

static bool InTree(pid_t pid, pid_t root) {
    for (int depth = 0; depth < 64 && pid > 0; depth++) {
        if (pid == root) return true;
        pid_t parent = ParentOf(pid);
        if (parent <= 0) return false;
        pid = parent;
    }
    return false;
}

// Basename of a process's executable ("" when unreadable). Used only as a SAFETY NET for exclude
// mode: if a playback stream cannot be tied to our process tree (a pid seen from another PID
// namespace is the usual way), a stream from the very same executable is still ours.
static std::string ExeBase(pid_t pid) {
    char link[64];
    snprintf(link, sizeof(link), "/proc/%d/exe", (int)pid);
    char buf[512];
    ssize_t n = readlink(link, buf, sizeof(buf) - 1);
    if (n <= 0) return std::string();
    buf[n] = 0;
    std::string p(buf);
    const std::string deleted = " (deleted)";
    if (p.size() > deleted.size() && p.compare(p.size() - deleted.size(), deleted.size(), deleted) == 0)
        p.erase(p.size() - deleted.size());
    const size_t slash = p.find_last_of('/');
    return slash == std::string::npos ? p : p.substr(slash + 1);
}

// ────────────────────────────────────────────────────────────────────────────
// Chunk handed from the PipeWire thread to the Node main thread
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

static constexpr uint32_t kRate = 48000;
static constexpr uint32_t kChannels = 2;
static constexpr size_t kChunkFrames = 480;   // 10 ms

// The process ids a PipeWire client can be attributed to. Two sources, because neither alone is enough:
//   sec  - pipewire.sec.pid, read by the daemon from the socket (kernel-attested). For a native PipeWire
//          client it is the app; for a PulseAudio client it is the pulse BRIDGE (pipewire-pulse), whose
//          per-app streams are the ones Chromium/Electron use.
//   claimed - application.process.id, which the app itself reports (libpulse and libpipewire both do).
// A stream belongs to a tree if ANY of its pids does. A client that lies about its pid can only hide
// or add its own audio, never anyone else's.
//
// A client's application.* properties are filled in AFTER it is announced (pipewire-pulse sets the
// pulse app's pid via a core update), and the registry's `global` event carries only the properties
// at announcement. So the clients that own playback streams are bound, and their `info` events are
// what we read; a stream is not judged until its client's info has arrived (infoSeen).
struct ClientPids {
    pid_t sec = -1;
    pid_t claimed = -1;
    std::string binary;    // application.process.binary
    std::string appName;   // application.name
    bool infoSeen = false;
};

struct Session;
struct ClientProxy {
    Session* s = nullptr;
    uint32_t id = 0;
    struct pw_client* proxy = nullptr;
    struct spa_hook hook {};
};

// One graph node that plays audio (a Stream/Output/Audio node).
struct NodeInfo {
    uint32_t id = 0;
    pid_t pid = -1;          // -1 = unknown
    uint32_t clientId = 0;   // 0 = none
    std::string binary;      // application.process.binary
    std::string appName;     // application.name
    bool selected = false;   // decided once the pid is known
    bool decided = false;
};

struct PortInfo {
    uint32_t id = 0;
    uint32_t nodeId = 0;
    bool isOut = false;
    uint32_t portIndex = 0;
    std::string channel;     // "FL", "FR", "MONO", ...
};

// One capture session. Every async completion checks `alive` under the lock, so a
// late callback from a loop that was already stopped (or replaced by a newer
// startCapture) can never reach a released threadsafe function.
struct Session {
    std::mutex m;
    napi_threadsafe_function tsfn = nullptr;   // guarded by m
    bool alive = true;                         // guarded by m
    bool terminalSent = false;                 // guarded by m

    pid_t rootPid = 0;
    bool exclude = true;
    std::string rootExe;     // exclude + app modes: the excluded process's executable name

    // app mode: capture ONE application (identity key from AppKey()); rootPid is still excluded.
    bool appMode = false;
    std::string appKey;
    // listApps(): watch the registry only (no capture stream), answer when the graph has settled.
    bool listOnly = false;
    int syncSeq = -1, syncStage = 0;
    bool syncDone = false;
    // app mode: the processes the app has been seen as (for quit detection) and how many of its
    // playback streams exist right now. Written on the loop thread, read by the watcher.
    std::mutex pm;
    std::set<pid_t> appPids;
    std::atomic<int> appStreams{0};

    // PipeWire objects. Created under the thread-loop lock in Begin(); destroyed
    // in Close(). The graph state below is touched ONLY on the loop thread (or
    // under the loop lock).
    struct pw_thread_loop* loop = nullptr;
    struct pw_context* context = nullptr;
    struct pw_core* core = nullptr;
    struct pw_registry* registry = nullptr;
    struct pw_stream* stream = nullptr;
    struct spa_hook coreListener {};
    struct spa_hook registryListener {};
    struct spa_hook streamListener {};
    bool coreHooked = false, registryHooked = false;

    uint32_t ourNode = SPA_ID_INVALID;
    std::map<uint32_t, NodeInfo> nodes;
    std::map<uint32_t, PortInfo> ports;
    std::map<uint32_t, ClientPids> clients;
    std::map<uint32_t, std::unique_ptr<ClientProxy>> clientProxies;
    std::map<std::pair<uint32_t, uint32_t>, struct pw_proxy*> links;   // (out port, in port)
    std::set<std::pair<uint32_t, uint32_t>> failedLinks;               // do not retry
    uint32_t linkErrors = 0;
    uint64_t chunksSent = 0;

    // stream format as negotiated
    bool formatOk = false;
    std::vector<float> acc;

    // include mode: poll the root pid for exit
    std::thread watcher;
    std::mutex wm;
    std::condition_variable wcv;
    bool watcherStop = false;
};

static std::mutex g_currentMutex;
static std::shared_ptr<Session> g_current;

static void Emit(Session* s, Chunk* c, bool terminal) {
    std::lock_guard<std::mutex> l(s->m);
    if (!s->alive || !s->tsfn || (terminal && s->terminalSent)) { delete c; return; }
    if (terminal) s->terminalSent = true;
    if (napi_call_threadsafe_function(s->tsfn, c, napi_tsfn_nonblocking) != napi_ok) delete c;
}

static void EmitFailed(Session* s, const char* reason, const std::string& message) {
    Chunk* c = new Chunk();
    c->kind = ChunkKind::Failed;
    c->reason = reason;
    c->message = message;
    Emit(s, c, true);
}

// ────────────────────────────────────────────────────────────────────────────
// Channel mapping: source output port -> our input port(s).
// Mono (and centre) go to BOTH sides; left-ish to FL, right-ish to FR;
// LFE is dropped; unknown channels alternate by position.
// ────────────────────────────────────────────────────────────────────────────

// Bit 0 = our FL, bit 1 = our FR.
static int DestMask(const std::string& ch, uint32_t index, size_t total) {
    if (ch == "FL" || ch == "RL" || ch == "SL" || ch == "FLC" || ch == "TFL" || ch == "TRL" || ch == "TSL") return 1;
    if (ch == "FR" || ch == "RR" || ch == "SR" || ch == "FRC" || ch == "TFR" || ch == "TRR" || ch == "TSR") return 2;
    if (ch == "MONO" || ch == "FC" || ch == "RC" || ch == "TFC" || ch == "TC" || ch == "TRC") return 3;
    if (ch == "LFE" || ch == "LFE2") return 0;
    if (total <= 1) return 3;
    return (index % 2 == 0) ? 1 : 2;
}

// ────────────────────────────────────────────────────────────────────────────
// Reconcile: make the set of links match "every selected playback node's output
// ports -> our input ports". Runs on the loop thread on every graph change.
// ────────────────────────────────────────────────────────────────────────────

static void DestroyLink(Session* s, std::map<std::pair<uint32_t, uint32_t>, struct pw_proxy*>::iterator it) {
    if (it->second) g_pw.pw_proxy_destroy(it->second);
    s->links.erase(it);
}

// app mode: remember the processes the picked app has been seen as, so a quit can be told from a
// pause. Only pids that are real in OUR pid namespace (their executable is readable) count, and never
// the kernel-attested pid of a pulse client (that is the pipewire-pulse bridge, which never quits).
static void NoteAppPids(Session* s, const NodeInfo& node, const ClientPids* cp) {
    const pid_t cand[2] = { node.pid, cp ? cp->claimed : (pid_t)-1 };
    std::lock_guard<std::mutex> l(s->pm);
    for (pid_t p : cand)
        if (p > 0 && !ExeBase(p).empty()) s->appPids.insert(p);
}

// Is this playback stream part of the process tree rooted at the session's pid? One rule for every
// mode, so "ours" means the same thing whether we are excluding it (whole-screen share), selecting
// it (X11 window) or keeping it out of an app pick. `exeNet` adds the same-executable safety net.
static bool InRootTree(const Session* s, const NodeInfo& node, const ClientPids* cp, bool exeNet) {
    bool in = node.pid > 0 && InTree(node.pid, s->rootPid);
    if (!in && cp) in = (cp->claimed > 0 && InTree(cp->claimed, s->rootPid)) || (cp->sec > 0 && InTree(cp->sec, s->rootPid));
    if (!in && exeNet && !s->rootExe.empty() &&
        (node.binary == s->rootExe || (cp && cp->binary == s->rootExe))) in = true;
    return in;
}

// The application a playback stream belongs to, as "<binary>|<application.name>" (either half may be
// empty; both empty = unknown, key ""). The stream's own properties win, its client's fill the gaps
// (pipewire-pulse sets them on the client). `name` is what a person would call it.
static std::string AppKey(const NodeInfo& node, const ClientPids* cp, std::string* name, std::string* binary) {
    const std::string bin = !node.binary.empty() ? node.binary : (cp ? cp->binary : std::string());
    const std::string nm = !node.appName.empty() ? node.appName : (cp ? cp->appName : std::string());
    if (name) *name = !nm.empty() ? nm : bin;
    if (binary) *binary = bin;
    if (bin.empty() && nm.empty()) return std::string();
    return bin + "|" + nm;
}

static void Reconcile(Session* s) {
    if (!s->core || s->ourNode == SPA_ID_INVALID) return;

    // Our own input ports, by destination channel.
    uint32_t inPort[2] = { SPA_ID_INVALID, SPA_ID_INVALID };
    std::vector<const PortInfo*> ours;
    for (auto& kv : s->ports) {
        const PortInfo& p = kv.second;
        if (p.nodeId == s->ourNode && !p.isOut) ours.push_back(&p);
    }
    for (const PortInfo* p : ours) {
        if (p->channel == "FL") inPort[0] = p->id;
        else if (p->channel == "FR") inPort[1] = p->id;
    }
    if (inPort[0] == SPA_ID_INVALID || inPort[1] == SPA_ID_INVALID) {
        // Ports without channel names: fall back to their order.
        std::vector<const PortInfo*> sorted = ours;
        for (size_t i = 0; i < sorted.size(); i++)
            for (size_t j = i + 1; j < sorted.size(); j++)
                if (sorted[j]->portIndex < sorted[i]->portIndex) std::swap(sorted[i], sorted[j]);
        if (sorted.size() >= 2) { inPort[0] = sorted[0]->id; inPort[1] = sorted[1]->id; }
        else if (sorted.size() == 1) { inPort[0] = inPort[1] = sorted[0]->id; }
    }
    if (inPort[0] == SPA_ID_INVALID || inPort[1] == SPA_ID_INVALID) return;   // our ports are not up yet

    std::set<std::pair<uint32_t, uint32_t>> desired;
    for (auto& nkv : s->nodes) {
        NodeInfo& node = nkv.second;
        if (node.id == s->ourNode) continue;
        if (!node.decided) {
            const ClientPids* cp = nullptr;
            if (node.clientId) {
                auto c = s->clients.find(node.clientId);
                if (c != s->clients.end() && c->second.infoSeen) cp = &c->second;
                else continue;   // its client's properties have not arrived yet: decide when they do (never guess)
            }
            // Safety net (exclude and app): the same executable as the excluded process is ours too.
            const bool in = InRootTree(s, node, cp, s->exclude || s->appMode);
            const bool known = node.pid > 0 || (cp && (cp->claimed > 0 || cp->sec > 0));
            if (s->appMode) {
                // app: the picked application's streams, and never anything of ours.
                node.selected = !in && AppKey(node, cp, nullptr, nullptr) == s->appKey;
                if (node.selected) NoteAppPids(s, node, cp);
            } else {
                // exclude: everything not provably ours. include: only what is provably theirs.
                node.selected = s->exclude ? !in : (in && known);
            }
            node.decided = true;
            DBG("decided a playback stream: pidKnown=%d inTree=%d linked=%d", (int)known, (int)in, (int)node.selected);
        }
        if (!node.selected) continue;

        std::vector<const PortInfo*> outs;
        for (auto& pkv : s->ports)
            if (pkv.second.nodeId == node.id && pkv.second.isOut) outs.push_back(&pkv.second);
        for (size_t i = 0; i < outs.size(); i++) {
            const int mask = DestMask(outs[i]->channel, outs[i]->portIndex, outs.size());
            for (int d = 0; d < 2; d++)
                if (mask & (1 << d)) desired.insert({ outs[i]->id, inPort[d] });
        }
    }

    if (s->appMode) {
        int n = 0;
        for (auto& nkv : s->nodes) if (nkv.second.selected) n++;
        s->appStreams.store(n);
    }

    // Drop links that are no longer wanted.
    for (auto it = s->links.begin(); it != s->links.end();) {
        if (!desired.count(it->first)) { auto cur = it++; DestroyLink(s, cur); }
        else ++it;
    }
    // Add the missing ones.
    for (const auto& want : desired) {
        if (s->links.count(want) || s->failedLinks.count(want)) continue;
        const PortInfo& out = s->ports[want.first];
        struct pw_properties* props = g_pw.pw_properties_new(nullptr, nullptr);
        if (!props) continue;
        char v[32];
        snprintf(v, sizeof(v), "%u", out.nodeId);        g_pw.pw_properties_set(props, PW_KEY_LINK_OUTPUT_NODE, v);
        snprintf(v, sizeof(v), "%u", want.first);        g_pw.pw_properties_set(props, PW_KEY_LINK_OUTPUT_PORT, v);
        snprintf(v, sizeof(v), "%u", s->ourNode);        g_pw.pw_properties_set(props, PW_KEY_LINK_INPUT_NODE, v);
        snprintf(v, sizeof(v), "%u", want.second);       g_pw.pw_properties_set(props, PW_KEY_LINK_INPUT_PORT, v);
        // The link belongs to this client: it disappears when we do, never lingers.
        g_pw.pw_properties_set(props, PW_KEY_OBJECT_LINGER, "false");
        struct pw_proxy* link = (struct pw_proxy*)pw_core_create_object(
            s->core, "link-factory", PW_TYPE_INTERFACE_Link, PW_VERSION_LINK, &props->dict, 0);
        g_pw.pw_properties_free(props);
        if (!link) { s->failedLinks.insert(want); s->linkErrors++; continue; }
        s->links[want] = link;
    }
    DBG("reconcile: nodes=%zu ports=%zu links=%zu linkErrors=%u", s->nodes.size(), s->ports.size(), s->links.size(), s->linkErrors);
}

// ────────────────────────────────────────────────────────────────────────────
// Registry events (loop thread)
// ────────────────────────────────────────────────────────────────────────────

static pid_t ParsePid(const char* v) {
    if (!v || !*v) return -1;
    char* end = nullptr;
    long n = strtol(v, &end, 10);
    return (end && *end == 0 && n > 0 && n < 0x7fffffff) ? (pid_t)n : -1;
}

static uint32_t ParseId(const char* v) {
    if (!v || !*v) return SPA_ID_INVALID;
    char* end = nullptr;
    unsigned long n = strtoul(v, &end, 10);
    return (end && *end == 0 && n < 0xffffffffUL) ? (uint32_t)n : SPA_ID_INVALID;
}

static void OnClientInfo(void* data, const struct pw_client_info* info) {
    ClientProxy* cp = static_cast<ClientProxy*>(data);
    Session* s = cp->s;
    ClientPids& c = s->clients[cp->id];
    const pid_t oldSec = c.sec, oldClaimed = c.claimed;
    if (info && info->props) {
        c.sec = ParsePid(spa_dict_lookup(info->props, "pipewire.sec.pid"));
        c.claimed = ParsePid(spa_dict_lookup(info->props, PW_KEY_APP_PROCESS_ID));
        const char* bin = spa_dict_lookup(info->props, PW_KEY_APP_PROCESS_BINARY);
        c.binary = bin ? bin : "";
        const char* an = spa_dict_lookup(info->props, PW_KEY_APP_NAME);
        c.appName = an ? an : "";
    }
    c.infoSeen = true;
    if (c.sec != oldSec || c.claimed != oldClaimed || s->appMode) {
        // New attribution: judge this client's streams again.
        for (auto& kv : s->nodes) if (kv.second.clientId == cp->id) kv.second.decided = false;
    }
    Reconcile(s);
}

static const struct pw_client_events kClientEvents = [] {
    struct pw_client_events e;
    memset(&e, 0, sizeof(e));
    e.version = PW_VERSION_CLIENT_EVENTS;
    e.info = OnClientInfo;
    return e;
}();

static void EnsureClientBound(Session* s, uint32_t clientId) {
    if (!clientId || s->clientProxies.count(clientId) || !s->registry) return;
    std::unique_ptr<ClientProxy> cp(new ClientProxy());
    cp->s = s;
    cp->id = clientId;
    cp->proxy = static_cast<struct pw_client*>(
        pw_registry_bind(s->registry, clientId, PW_TYPE_INTERFACE_Client, PW_VERSION_CLIENT, 0));
    if (!cp->proxy) { s->clients[clientId].infoSeen = true; return; }   // cannot see it: judge by the stream's own pid
    pw_client_add_listener(cp->proxy, &cp->hook, &kClientEvents, cp.get());
    s->clientProxies[clientId] = std::move(cp);
}

static void DropClient(Session* s, uint32_t clientId) {
    auto it = s->clientProxies.find(clientId);
    if (it == s->clientProxies.end()) return;
    spa_hook_remove(&it->second->hook);
    g_pw.pw_proxy_destroy(reinterpret_cast<struct pw_proxy*>(it->second->proxy));
    s->clientProxies.erase(it);
}

static void OnRegistryGlobal(void* data, uint32_t id, uint32_t /*permissions*/, const char* type,
                             uint32_t /*version*/, const struct spa_dict* props) {
    Session* s = static_cast<Session*>(data);
    if (!props || !type) return;

    if (strcmp(type, PW_TYPE_INTERFACE_Node) == 0) {
        const char* cls = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
        if (!cls || strcmp(cls, "Stream/Output/Audio") != 0) return;
        NodeInfo n;
        n.id = id;
        n.pid = ParsePid(spa_dict_lookup(props, PW_KEY_APP_PROCESS_ID));
        const uint32_t cid = ParseId(spa_dict_lookup(props, PW_KEY_CLIENT_ID));
        n.clientId = (cid == SPA_ID_INVALID) ? 0 : cid;
        const char* bin = spa_dict_lookup(props, PW_KEY_APP_PROCESS_BINARY);
        n.binary = bin ? bin : "";
        const char* an = spa_dict_lookup(props, PW_KEY_APP_NAME);
        n.appName = an ? an : "";
        s->nodes[id] = n;
        EnsureClientBound(s, n.clientId);
    } else if (strcmp(type, PW_TYPE_INTERFACE_Port) == 0) {
        const uint32_t nodeId = ParseId(spa_dict_lookup(props, PW_KEY_NODE_ID));
        const char* dir = spa_dict_lookup(props, PW_KEY_PORT_DIRECTION);
        if (nodeId == SPA_ID_INVALID || !dir) return;
        const char* dsp = spa_dict_lookup(props, PW_KEY_FORMAT_DSP);
        if (dsp && !strstr(dsp, "audio")) return;                       // midi / control port
        const char* mon = spa_dict_lookup(props, PW_KEY_PORT_MONITOR);
        if (mon && strcmp(mon, "true") == 0) return;
        PortInfo p;
        p.id = id;
        p.nodeId = nodeId;
        p.isOut = strcmp(dir, "out") == 0;
        const uint32_t idx = ParseId(spa_dict_lookup(props, PW_KEY_PORT_ID));
        p.portIndex = (idx == SPA_ID_INVALID) ? 0 : idx;
        const char* ch = spa_dict_lookup(props, PW_KEY_AUDIO_CHANNEL);
        if (ch) p.channel = ch;
        else {
            const char* nm = spa_dict_lookup(props, PW_KEY_PORT_NAME);
            const char* us = nm ? strrchr(nm, '_') : nullptr;
            if (us) p.channel = us + 1;
        }
        s->ports[id] = p;
    } else {
        return;
    }
    Reconcile(s);
}

static void OnRegistryGlobalRemove(void* data, uint32_t id) {
    Session* s = static_cast<Session*>(data);
    bool changed = false;
    if (s->nodes.erase(id)) changed = true;
    if (s->clients.erase(id) || s->clientProxies.count(id)) DropClient(s, id);
    if (s->ports.erase(id)) {
        changed = true;
        for (auto it = s->links.begin(); it != s->links.end();) {
            if (it->first.first == id || it->first.second == id) { auto cur = it++; DestroyLink(s, cur); }
            else ++it;
        }
        for (auto it = s->failedLinks.begin(); it != s->failedLinks.end();) {
            if (it->first == id || it->second == id) it = s->failedLinks.erase(it); else ++it;
        }
    }
    if (changed) Reconcile(s);
}

// listApps(): two round trips with the daemon - the first delivers the registry, the second what
// the clients we bound because of it told us (their application.* properties).
static void OnCoreDone(void* data, uint32_t id, int seq) {
    Session* s = static_cast<Session*>(data);
    if (!s->listOnly || id != PW_ID_CORE || seq != s->syncSeq) return;
    if (++s->syncStage < 2) {
        s->syncSeq = pw_core_sync(s->core, PW_ID_CORE, 0);
        return;
    }
    s->syncDone = true;
    g_pw.pw_thread_loop_signal(s->loop, false);
}

static void OnCoreError(void* data, uint32_t id, int seq, int res, const char* /*message*/) {
    Session* s = static_cast<Session*>(data);
    if (id == PW_ID_CORE && res == -EPIPE) {
        // The daemon went away. Terminal.
        EmitFailed(s, "unavailable", "the PipeWire connection was lost");
        return;
    }
    // A client we asked to read could not be bound (permissions): judge its streams by their own pid.
    for (auto& kv : s->clientProxies) {
        if (g_pw.pw_proxy_get_id(reinterpret_cast<struct pw_proxy*>(kv.second->proxy)) == id) {
            s->clients[kv.first].infoSeen = true;
            for (auto& n : s->nodes) if (n.second.clientId == kv.first) n.second.decided = false;
            Reconcile(s);
            return;
        }
    }
    // A link we asked for was refused (e.g. a sandboxed client without link permission).
    for (auto it = s->links.begin(); it != s->links.end(); ++it) {
        if (it->second && g_pw.pw_proxy_get_id(it->second) == id) {
            s->failedLinks.insert(it->first);
            s->linkErrors++;
            DBG("a link was refused (res=%d seq=%d)", res, seq);
            DestroyLink(s, it);
            return;
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Stream events (loop thread)
// ────────────────────────────────────────────────────────────────────────────

static void OnStreamStateChanged(void* data, enum pw_stream_state /*old*/, enum pw_stream_state state, const char* error) {
    Session* s = static_cast<Session*>(data);
    DBG("capture stream state=%d", (int)state);
    if (state == PW_STREAM_STATE_ERROR) {
        EmitFailed(s, "error", error ? error : "stream error");
        return;
    }
    if (state >= PW_STREAM_STATE_PAUSED && s->ourNode == SPA_ID_INVALID && s->stream) {
        s->ourNode = g_pw.pw_stream_get_node_id(s->stream);
        Reconcile(s);
    }
}

static void OnStreamParamChanged(void* data, uint32_t id, const struct spa_pod* param) {
    Session* s = static_cast<Session*>(data);
    if (!param || id != SPA_PARAM_Format) return;
    struct spa_audio_info info;
    if (spa_format_parse(param, &info.media_type, &info.media_subtype) < 0) return;
    if (info.media_type != SPA_MEDIA_TYPE_audio || info.media_subtype != SPA_MEDIA_SUBTYPE_raw) return;
    struct spa_audio_info_raw raw;
    memset(&raw, 0, sizeof(raw));
    if (spa_format_audio_raw_parse(param, &raw) < 0) return;
    s->formatOk = raw.format == SPA_AUDIO_FORMAT_F32 && raw.rate == kRate && raw.channels == kChannels;
    if (!s->formatOk) DBG("unexpected negotiated format rate=%u ch=%u", raw.rate, raw.channels);
}

static void OnStreamProcess(void* data) {
    Session* s = static_cast<Session*>(data);
    struct pw_buffer* b = g_pw.pw_stream_dequeue_buffer(s->stream);
    if (!b) return;
    struct spa_buffer* buf = b->buffer;
    if (buf && buf->n_datas > 0 && s->formatOk) {
        struct spa_data* d = &buf->datas[0];
        if (d->data && d->chunk && d->chunk->size >= sizeof(float) * kChannels) {
            const uint32_t off = d->chunk->offset % (d->maxsize ? d->maxsize : 1);
            uint32_t size = d->chunk->size;
            if (off + size > d->maxsize) size = d->maxsize > off ? d->maxsize - off : 0;
            const float* src = reinterpret_cast<const float*>(static_cast<const uint8_t*>(d->data) + off);
            const size_t samples = (size / sizeof(float)) / kChannels * kChannels;
            s->acc.insert(s->acc.end(), src, src + samples);
        }
    }
    g_pw.pw_stream_queue_buffer(s->stream, b);

    const size_t chunkSamples = kChunkFrames * kChannels;
    size_t used = 0;
    while (s->acc.size() - used >= chunkSamples) {
        Chunk* c = new Chunk();
        c->sampleRate = kRate;
        c->channels = kChannels;
        c->samples.assign(s->acc.begin() + used, s->acc.begin() + used + chunkSamples);
        used += chunkSamples;
        s->chunksSent++;
        Emit(s, c, false);
    }
    if (used) s->acc.erase(s->acc.begin(), s->acc.begin() + used);
    // A runaway backlog means nobody is consuming; keep the newest 100 ms and move on.
    if (s->acc.size() > chunkSamples * 20) s->acc.erase(s->acc.begin(), s->acc.end() - chunkSamples * 10);
}

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
// Session start / stop
// ────────────────────────────────────────────────────────────────────────────

static const struct pw_core_events kCoreEvents = [] {
    struct pw_core_events e;
    memset(&e, 0, sizeof(e));
    e.version = PW_VERSION_CORE_EVENTS;
    e.error = OnCoreError;
    e.done = OnCoreDone;
    return e;
}();

static const struct pw_registry_events kRegistryEvents = [] {
    struct pw_registry_events e;
    memset(&e, 0, sizeof(e));
    e.version = PW_VERSION_REGISTRY_EVENTS;
    e.global = OnRegistryGlobal;
    e.global_remove = OnRegistryGlobalRemove;
    return e;
}();

static const struct pw_stream_events kStreamEvents = [] {
    struct pw_stream_events e;
    memset(&e, 0, sizeof(e));
    e.version = PW_VERSION_STREAM_EVENTS;
    e.state_changed = OnStreamStateChanged;
    e.param_changed = OnStreamParamChanged;
    e.process = OnStreamProcess;
    return e;
}();

// Tear a session down: stop delivering, release the tsfn, stop the loop, free PipeWire.
// Blocks only for the loop thread's join. Never call from the loop thread.
static void CloseSession(const std::shared_ptr<Session>& sp) {
    Session* s = sp.get();
    {
        std::lock_guard<std::mutex> l(s->m);
        if (!s->alive) return;
        s->alive = false;
        if (s->tsfn) {
            napi_release_threadsafe_function(s->tsfn, napi_tsfn_release);
            s->tsfn = nullptr;
        }
    }
    {
        std::lock_guard<std::mutex> l(s->wm);
        s->watcherStop = true;
    }
    s->wcv.notify_all();
    if (s->watcher.joinable()) s->watcher.join();

    if (s->loop) {
        g_pw.pw_thread_loop_lock(s->loop);
        for (auto& kv : s->links) if (kv.second) g_pw.pw_proxy_destroy(kv.second);
        s->links.clear();
        for (auto it = s->clientProxies.begin(); it != s->clientProxies.end();) {
            spa_hook_remove(&it->second->hook);
            g_pw.pw_proxy_destroy(reinterpret_cast<struct pw_proxy*>(it->second->proxy));
            it = s->clientProxies.erase(it);
        }
        if (s->registry) {
            if (s->registryHooked) spa_hook_remove(&s->registryListener);
            g_pw.pw_proxy_destroy(reinterpret_cast<struct pw_proxy*>(s->registry));
            s->registry = nullptr;
        }
        if (s->stream) { g_pw.pw_stream_destroy(s->stream); s->stream = nullptr; }
        if (s->core) {
            if (s->coreHooked) spa_hook_remove(&s->coreListener);
            g_pw.pw_core_disconnect(s->core);
            s->core = nullptr;
        }
        g_pw.pw_thread_loop_unlock(s->loop);
        g_pw.pw_thread_loop_stop(s->loop);
        if (s->context) { g_pw.pw_context_destroy(s->context); s->context = nullptr; }
        g_pw.pw_thread_loop_destroy(s->loop);
        s->loop = nullptr;
    }
    DBG("session closed (chunks=%llu)", (unsigned long long)s->chunksSent);
}

// Returns an error string, or nullptr on success.
static bool SocketPresent();
static const char* BeginSession(const std::shared_ptr<Session>& sp) {
    Session* s = sp.get();
    if (!g_pw.ok) return "PipeWire is not available";
    if (!SocketPresent()) return "there is no PipeWire daemon to connect to";

    s->loop = g_pw.pw_thread_loop_new("cipherline-share-audio", nullptr);
    if (!s->loop) return "could not create the PipeWire loop";
    s->context = g_pw.pw_context_new(g_pw.pw_thread_loop_get_loop(s->loop), nullptr, 0);
    if (!s->context) return "could not create the PipeWire context";
    if (g_pw.pw_thread_loop_start(s->loop) < 0) return "could not start the PipeWire loop";

    g_pw.pw_thread_loop_lock(s->loop);
    const char* err = nullptr;
    do {
        s->core = g_pw.pw_context_connect(s->context, nullptr, 0);
        if (!s->core) { err = "could not connect to the PipeWire daemon"; break; }
        pw_core_add_listener(s->core, &s->coreListener, &kCoreEvents, s);
        s->coreHooked = true;

        // listApps(): only the graph is wanted, so no capture stream (and no node of ours in it).
        if (s->listOnly) {
            s->registry = pw_core_get_registry(s->core, PW_VERSION_REGISTRY, 0);
            if (!s->registry) { err = "could not read the PipeWire registry"; break; }
            pw_registry_add_listener(s->registry, &s->registryListener, &kRegistryEvents, s);
            s->registryHooked = true;
            s->syncSeq = pw_core_sync(s->core, PW_ID_CORE, 0);
            break;
        }

        struct pw_properties* props = g_pw.pw_properties_new(
            PW_KEY_MEDIA_TYPE, "Audio",
            PW_KEY_MEDIA_CATEGORY, "Capture",
            PW_KEY_NODE_NAME, "cipherline-share-audio",
            PW_KEY_NODE_DESCRIPTION, "Cipherline screen share audio",
            PW_KEY_APP_NAME, "Cipherline",
            // Not auto-connected, not re-routed by the session manager: we link it ourselves.
            PW_KEY_NODE_AUTOCONNECT, "false",
            PW_KEY_NODE_DONT_RECONNECT, "true",
            nullptr);
        s->stream = g_pw.pw_stream_new(s->core, "Cipherline screen share audio", props);
        if (!s->stream) { err = "could not create the capture stream"; break; }
        g_pw.pw_stream_add_listener(s->stream, &s->streamListener, &kStreamEvents, s);

        uint8_t podBuf[1024];
        struct spa_pod_builder b = SPA_POD_BUILDER_INIT(podBuf, sizeof(podBuf));
        struct spa_audio_info_raw info;
        memset(&info, 0, sizeof(info));
        info.format = SPA_AUDIO_FORMAT_F32;
        info.rate = kRate;
        info.channels = kChannels;
        info.position[0] = SPA_AUDIO_CHANNEL_FL;
        info.position[1] = SPA_AUDIO_CHANNEL_FR;
        const struct spa_pod* params[1];
        params[0] = spa_format_audio_raw_build(&b, SPA_PARAM_EnumFormat, &info);
        // No PW_STREAM_FLAG_AUTOCONNECT on purpose. Not RT_PROCESS either: process() runs on the
        // loop thread, where taking the tsfn lock is fine.
        if (g_pw.pw_stream_connect(s->stream, PW_DIRECTION_INPUT, PW_ID_ANY,
                                   (enum pw_stream_flags)(PW_STREAM_FLAG_MAP_BUFFERS), params, 1) < 0) {
            err = "could not start the capture stream";
            break;
        }

        s->registry = pw_core_get_registry(s->core, PW_VERSION_REGISTRY, 0);
        if (!s->registry) { err = "could not read the PipeWire registry"; break; }
        pw_registry_add_listener(s->registry, &s->registryListener, &kRegistryEvents, s);
        s->registryHooked = true;
    } while (0);
    g_pw.pw_thread_loop_unlock(s->loop);
    return err;
}

// ────────────────────────────────────────────────────────────────────────────
// isSupported(): the library loads, the daemon answers, and an audio sink exists.
// ────────────────────────────────────────────────────────────────────────────

struct ProbeState {
    struct pw_thread_loop* loop = nullptr;
    bool done = false;
    bool sawSink = false;
    int syncSeq = -1;
    struct spa_hook coreListener {};
    struct spa_hook registryListener {};
};

static void ProbeGlobal(void* data, uint32_t, uint32_t, const char* type, uint32_t, const struct spa_dict* props) {
    ProbeState* p = static_cast<ProbeState*>(data);
    if (!props || !type || strcmp(type, PW_TYPE_INTERFACE_Node) != 0) return;
    const char* cls = spa_dict_lookup(props, PW_KEY_MEDIA_CLASS);
    if (cls && strncmp(cls, "Audio/Sink", 10) == 0) p->sawSink = true;
}

static void ProbeDone(void* data, uint32_t id, int seq) {
    ProbeState* p = static_cast<ProbeState*>(data);
    if (id == PW_ID_CORE && seq == p->syncSeq) {
        p->done = true;
        g_pw.pw_thread_loop_signal(p->loop, false);
    }
}

// Is there a PipeWire socket to connect to at all? Checked first so a machine that has the library
// (it is a dependency of Chromium's screen capture) but no daemon never builds a PipeWire context,
// which would log its missing-config complaints to stderr on every probe.
static bool SocketPresent() {
    const char* remote = getenv("PIPEWIRE_REMOTE");
    if (!remote || !*remote) remote = "pipewire-0";
    std::string path;
    if (remote[0] == '/') {
        path = remote;
    } else {
        const char* dir = getenv("PIPEWIRE_RUNTIME_DIR");
        if (!dir || !*dir) dir = getenv("XDG_RUNTIME_DIR");
        if (!dir || !*dir) return false;
        path = std::string(dir) + "/" + remote;
    }
    return access(path.c_str(), F_OK) == 0;
}

static bool ProbePipeWire() {
    LoadPipeWire();
    if (!g_pw.ok) return false;
    if (!SocketPresent()) { DBG("probe: no PipeWire socket"); return false; }

    ProbeState st;
    struct pw_thread_loop* loop = g_pw.pw_thread_loop_new("cipherline-audio-probe", nullptr);
    if (!loop) return false;
    st.loop = loop;
    struct pw_context* ctx = g_pw.pw_context_new(g_pw.pw_thread_loop_get_loop(loop), nullptr, 0);
    bool ok = false;
    if (ctx && g_pw.pw_thread_loop_start(loop) >= 0) {
        g_pw.pw_thread_loop_lock(loop);
        struct pw_core* core = g_pw.pw_context_connect(ctx, nullptr, 0);
        if (core) {
            static const struct pw_core_events coreEvents = [] {
                struct pw_core_events e; memset(&e, 0, sizeof(e));
                e.version = PW_VERSION_CORE_EVENTS; e.done = ProbeDone; return e; }();
            static const struct pw_registry_events regEvents = [] {
                struct pw_registry_events e; memset(&e, 0, sizeof(e));
                e.version = PW_VERSION_REGISTRY_EVENTS; e.global = ProbeGlobal; return e; }();
            pw_core_add_listener(core, &st.coreListener, &coreEvents, &st);
            struct pw_registry* reg = pw_core_get_registry(core, PW_VERSION_REGISTRY, 0);
            if (reg) pw_registry_add_listener(reg, &st.registryListener, &regEvents, &st);
            st.syncSeq = pw_core_sync(core, PW_ID_CORE, 0);
            // The registry's globals are delivered before the sync's done event.
            for (int i = 0; i < 2 && !st.done; i++) g_pw.pw_thread_loop_timed_wait(loop, 1);
            ok = st.done && st.sawSink;
            DBG("probe: answered=%d sink=%d", (int)st.done, (int)st.sawSink);
            if (reg) { spa_hook_remove(&st.registryListener); g_pw.pw_proxy_destroy(reinterpret_cast<struct pw_proxy*>(reg)); }
            spa_hook_remove(&st.coreListener);
            g_pw.pw_core_disconnect(core);
        } else {
            DBG("probe: no PipeWire daemon");
        }
        g_pw.pw_thread_loop_unlock(loop);
        g_pw.pw_thread_loop_stop(loop);
    }
    if (ctx) g_pw.pw_context_destroy(ctx);
    g_pw.pw_thread_loop_destroy(loop);
    return ok;
}

static bool IsSupported() {
    static std::mutex m;
    static bool have = false;
    static bool value = false;
    static time_t at = 0;
    std::lock_guard<std::mutex> l(m);
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    // A "yes" is trusted for 10 s, a "no" for 3 s (so a daemon that has just started is noticed soon).
    if (have && ts.tv_sec - at < (value ? 10 : 3)) return value;
    value = ProbePipeWire();
    have = true;
    at = ts.tv_sec;
    return value;
}

// ────────────────────────────────────────────────────────────────────────────
// X11: _NET_WM_PID of a window source (libX11 loaded at run time, no headers)
// ────────────────────────────────────────────────────────────────────────────

namespace x11 {
typedef struct _XDisplay Display;
typedef unsigned long Window;
typedef unsigned long Atom;
struct XErrorEvent;   // opaque: our handler ignores it
typedef int (*ErrorHandler)(Display*, XErrorEvent*);

static Display* (*XOpenDisplay)(const char*) = nullptr;
static int (*XCloseDisplay)(Display*) = nullptr;
static Atom (*XInternAtom)(Display*, const char*, int) = nullptr;
static Window (*XDefaultRootWindow)(Display*) = nullptr;
static int (*XGetWindowProperty)(Display*, Window, Atom, long, long, int, Atom, Atom*, int*,
                                 unsigned long*, unsigned long*, unsigned char**) = nullptr;
static int (*XFree)(void*) = nullptr;
static ErrorHandler (*XSetErrorHandler)(ErrorHandler) = nullptr;
static int (*XSync)(Display*, int) = nullptr;

static const Atom kXA_CARDINAL = 6;
static const Atom kXA_WINDOW = 33;

static bool Load() {
    static std::once_flag once;
    static bool ok = false;
    std::call_once(once, [] {
        void* lib = dlopen("libX11.so.6", RTLD_NOW | RTLD_LOCAL);
        if (!lib) return;
#define SYM(n) n = reinterpret_cast<decltype(n)>(dlsym(lib, #n)); if (!n) return;
        SYM(XOpenDisplay) SYM(XCloseDisplay) SYM(XInternAtom) SYM(XDefaultRootWindow)
        SYM(XGetWindowProperty) SYM(XFree) SYM(XSetErrorHandler) SYM(XSync)
#undef SYM
        ok = true;
    });
    return ok;
}

static int IgnoreErrors(Display*, XErrorEvent*) { return 0; }

// 0 when it cannot be told.
static pid_t WindowPid(unsigned long xid) {
    if (!getenv("DISPLAY") || !Load()) return 0;
    Display* dpy = XOpenDisplay(nullptr);
    if (!dpy) return 0;
    // A window that does not exist raises an X protocol error, whose default handler EXITS the
    // process. Swallow errors for the duration of these requests, and restore the previous handler.
    ErrorHandler prev = XSetErrorHandler(IgnoreErrors);
    pid_t result = 0;

    const Window root = XDefaultRootWindow(dpy);
    const Atom netClientList = XInternAtom(dpy, "_NET_CLIENT_LIST", 1);
    bool known = true;
    if (netClientList) {
        // Prefer to only ask about windows the window manager lists; if there is no list, just try.
        Atom type = 0; int fmt = 0; unsigned long n = 0, rest = 0; unsigned char* data = nullptr;
        if (XGetWindowProperty(dpy, root, netClientList, 0, 65536, 0, kXA_WINDOW, &type, &fmt, &n, &rest, &data) == 0
            && data && type == kXA_WINDOW && fmt == 32) {
            known = false;
            const unsigned long* ids = reinterpret_cast<const unsigned long*>(data);
            for (unsigned long i = 0; i < n; i++) if (ids[i] == xid) { known = true; break; }
        }
        if (data) XFree(data);
    }
    if (known) {
        const Atom netWmPid = XInternAtom(dpy, "_NET_WM_PID", 1);
        if (netWmPid) {
            Atom type = 0; int fmt = 0; unsigned long n = 0, rest = 0; unsigned char* data = nullptr;
            if (XGetWindowProperty(dpy, (Window)xid, netWmPid, 0, 1, 0, kXA_CARDINAL, &type, &fmt, &n, &rest, &data) == 0
                && data && type == kXA_CARDINAL && fmt == 32 && n >= 1) {
                const unsigned long v = *reinterpret_cast<const unsigned long*>(data);
                if (v > 0 && v < 0x7fffffffUL) result = (pid_t)v;
            }
            if (data) XFree(data);
        }
    }
    XSync(dpy, 0);
    XSetErrorHandler(prev);
    XCloseDisplay(dpy);
    return result;
}
}  // namespace x11

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

    // 'window:<xid>:<n>' — an X11 window id. Anything else (screens, portal windows) has no pid.
    if (strncmp(buf, "window:", 7) != 0) return NullValue(env);
    char* end = nullptr;
    errno = 0;
    unsigned long long xid = strtoull(buf + 7, &end, 10);
    if (end == buf + 7 || errno != 0 || xid == 0 || xid > 0xFFFFFFFFull) return NullValue(env);

    const pid_t pid = x11::WindowPid((unsigned long)xid);
    if (pid <= 0) return NullValue(env);
    char proc[32];
    snprintf(proc, sizeof(proc), "/proc/%d", (int)pid);
    if (access(proc, F_OK) != 0) return NullValue(env);

    napi_value r;
    napi_create_uint32(env, (uint32_t)pid, &r);
    return r;
}

static napi_value StartCapture(napi_env env, napi_callback_info info) {
    napi_value undef;
    napi_get_undefined(env, &undef);

    size_t argc = 4;
    napi_value args[4];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    if (argc < 3) return undef;

    uint32_t pid = 0;
    napi_get_value_uint32(env, args[0], &pid);
    char modeBuf[16] = {};
    size_t modeLen = 0;
    napi_get_value_string_utf8(env, args[1], modeBuf, sizeof(modeBuf), &modeLen);
    const bool appMode = strcmp(modeBuf, "app") == 0;
    // app mode excludes `pid`'s tree (Cipherline's own) AND selects one application; it is not 'include'.
    const bool exclude = appMode || strcmp(modeBuf, "exclude") == 0;
    std::string appKey;
    if (appMode) {
        // The key must be a non-empty string; a missing / odd one starts nothing (the capture would be silent).
        size_t klen = 0;
        if (argc < 4 || napi_get_value_string_utf8(env, args[3], nullptr, 0, &klen) != napi_ok || klen == 0 || klen > 1024) return undef;
        appKey.resize(klen);
        size_t got = 0;
        if (napi_get_value_string_utf8(env, args[3], &appKey[0], klen + 1, &got) != napi_ok) return undef;
        appKey.resize(got);
    }

    // Replace any capture already running.
    std::shared_ptr<Session> previous;
    {
        std::lock_guard<std::mutex> l(g_currentMutex);
        previous = g_current;
        g_current.reset();
    }
    if (previous) CloseSession(previous);

    auto session = std::make_shared<Session>();
    session->rootPid = (pid_t)pid;
    session->exclude = exclude && !appMode;
    session->appMode = appMode;
    session->appKey = appKey;
    if (exclude) session->rootExe = ExeBase((pid_t)pid);
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

    LoadPipeWire();
    if (pid == 0 || pid > 0x7fffffffu) {
        EmitFailed(session.get(), "error", "invalid process id");
        return undef;
    }
    const char* err = BeginSession(session);
    if (err) {
        EmitFailed(session.get(), g_pw.ok ? "unavailable" : "unsupported", err);
        return undef;
    }

    // include mode: a quit target is not an error PipeWire reports — its streams just disappear.
    // Poll the root so the app can say so (mirrors the other platforms' addons).
    if (!exclude) {
        Session* raw = session.get();
        session->watcher = std::thread([raw] {
            std::unique_lock<std::mutex> lk(raw->wm);
            while (!raw->watcherStop) {
                if (raw->wcv.wait_for(lk, std::chrono::seconds(1), [raw] { return raw->watcherStop; })) break;
                if (kill(raw->rootPid, 0) == -1 && errno == ESRCH) {
                    Chunk* c = new Chunk();
                    c->kind = ChunkKind::Exited;
                    Emit(raw, c, true);
                    break;
                }
            }
        });
    }
    // app mode: the app has no pid we were given. Its streams come and go (a new song, a game
    // restarting its audio), so "no stream" is NOT "quit". It quit when every process we saw it as is
    // gone AND none of its streams remain, on two polls in a row (so a restart that is already
    // linking again is not reported). An app we never saw a usable pid for cannot be reported quit.
    if (appMode) {
        Session* raw = session.get();
        session->watcher = std::thread([raw] {
            std::unique_lock<std::mutex> lk(raw->wm);
            int gone = 0;
            while (!raw->watcherStop) {
                if (raw->wcv.wait_for(lk, std::chrono::seconds(1), [raw] { return raw->watcherStop; })) break;
                bool anySeen = false, anyAlive = false;
                {
                    std::lock_guard<std::mutex> pl(raw->pm);
                    // Dead pids stay in the set (a pid is not reused within a share in practice), so a
                    // quit stays visible across the two polls; a relaunch adds its own, live pid.
                    for (pid_t p : raw->appPids) {
                        anySeen = true;
                        if (!(kill(p, 0) == -1 && errno == ESRCH)) anyAlive = true;
                    }
                }
                gone = (anySeen && !anyAlive && raw->appStreams.load() == 0) ? gone + 1 : 0;
                if (gone >= 2) {
                    Chunk* c = new Chunk();
                    c->kind = ChunkKind::Exited;
                    Emit(raw, c, true);
                    break;
                }
            }
        });
    }
    DBG("capture started exclude=%d app=%d", (int)exclude, (int)appMode);
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

// ────────────────────────────────────────────────────────────────────────────
// listApps(ownPid): who is playing audio right now
// ────────────────────────────────────────────────────────────────────────────

struct AppEntry {
    std::string key, name, binary;
    int streams = 0;
};

// Watch the graph once (the same registry / client-info code a capture uses, minus the capture
// stream) and group its playback streams by application. The tree of `ownPid` is left out.
static std::vector<AppEntry> CollectApps(pid_t ownPid) {
    std::vector<AppEntry> out;
    LoadPipeWire();
    if (!g_pw.ok || ownPid <= 0) return out;
    auto sp = std::make_shared<Session>();
    Session* s = sp.get();
    s->rootPid = ownPid;
    s->exclude = true;
    s->rootExe = ExeBase(ownPid);
    s->listOnly = true;
    if (BeginSession(sp) == nullptr) {
        g_pw.pw_thread_loop_lock(s->loop);
        for (int i = 0; i < 3 && !s->syncDone; i++) g_pw.pw_thread_loop_timed_wait(s->loop, 1);
        std::map<std::string, AppEntry> byKey;
        for (auto& kv : s->nodes) {
            const NodeInfo& node = kv.second;
            const ClientPids* cp = nullptr;
            if (node.clientId) {
                auto c = s->clients.find(node.clientId);
                if (c == s->clients.end() || !c->second.infoSeen) continue;   // never guess whose it is
                cp = &c->second;
            }
            if (InRootTree(s, node, cp, true)) continue;                      // Cipherline's own audio is never offered
            AppEntry e;
            e.key = AppKey(node, cp, &e.name, &e.binary);
            if (e.key.empty()) continue;
            auto it = byKey.find(e.key);
            if (it == byKey.end()) { e.streams = 1; byKey[e.key] = e; }
            else it->second.streams++;
        }
        for (auto& kv : byKey) out.push_back(kv.second);
        g_pw.pw_thread_loop_unlock(s->loop);
    }
    CloseSession(sp);
    DBG("listApps: %zu application(s)", out.size());
    return out;
}

static napi_value ListApps(napi_env env, napi_callback_info info) {
    napi_value arr;
    napi_create_array(env, &arr);
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    uint32_t pid = 0;
    if (argc < 1 || napi_get_value_uint32(env, args[0], &pid) != napi_ok || pid == 0 || pid > 0x7fffffffu) return arr;
    if (!IsSupported()) return arr;
    const std::vector<AppEntry> apps = CollectApps((pid_t)pid);
    uint32_t i = 0;
    for (const AppEntry& a : apps) {
        napi_value o, v;
        napi_create_object(env, &o);
        napi_create_string_utf8(env, a.key.c_str(), NAPI_AUTO_LENGTH, &v);    napi_set_named_property(env, o, "key", v);
        napi_create_string_utf8(env, a.name.c_str(), NAPI_AUTO_LENGTH, &v);   napi_set_named_property(env, o, "name", v);
        napi_create_string_utf8(env, a.binary.c_str(), NAPI_AUTO_LENGTH, &v); napi_set_named_property(env, o, "binary", v);
        napi_create_int32(env, a.streams, &v);                                napi_set_named_property(env, o, "streams", v);
        napi_set_element(env, arr, i++, o);
    }
    return arr;
}

// ────────────────────────────────────────────────────────────────────────────
// Module init
// ────────────────────────────────────────────────────────────────────────────

// window_geometry.cc — display/window geometry for the annotation overlay (no-ops off Windows).
void RegisterWindowGeometry(napi_env env, napi_value exports);
// share_power.cc — process power-throttling opt-out, foreground probe and timer resolution (no-ops off Windows).
void RegisterSharePower(napi_env env, napi_value exports);
// hdr_capture.cc — tone-mapped Desktop Duplication of an HDR display (no-ops off Windows).
void RegisterHdrCapture(napi_env env, napi_value exports);

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

    napi_create_function(env, nullptr, 0, ListApps, nullptr, &fn);
    napi_set_named_property(env, exports, "listApps", fn);

    RegisterWindowGeometry(env, exports);
    RegisterSharePower(env, exports);
    RegisterHdrCapture(env, exports);
    return exports;
}

NAPI_MODULE(audio_capture, Init)
