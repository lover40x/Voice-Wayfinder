// vw-audio for Windows: full-duplex PCM16 mono 24 kHz audio for the Voice Wayfinder bridge.
// It speaks exactly the protocol of main.swift (the macOS helper).
//
// Frames are 1 byte type, 4 byte little-endian payload length, payload.
// stdin (bridge -> helper):
//   'A' u32 seq + PCM16 samples to play   'F' flush playback now (barge-in)   'Q' quit
// stdout (helper -> bridge):
//   'A' PCM16 mic samples   'P' u32 seq of the last buffer played back   'E' JSON event
//
// Exit codes: 0 quit, 1 error, 2 microphone access denied, 3 audio device changed
// (the bridge starts a fresh helper), 4 echo cancellation could not start (the
// bridge starts again without --voice-processing).
//
// --voice-processing captures through the Windows Voice Capture DSP (the AEC DMO,
// CLSID_CWMAudioAEC) in single-channel AEC mode with noise suppression on: it
// cancels what the default speakers play, so the mic does not hear Claude's own
// voice. Without the flag, the mic is read raw through WASAPI.
// Playback is WASAPI shared mode on the default output device in both cases,
// which is also the device the DSP takes its echo reference from.
//
// Build: node plugin/scripts/build-audio.mjs (MSVC from Visual Studio Build Tools).

#ifndef UNICODE
#define UNICODE
#endif
#define NOMINMAX
#include <windows.h>
#include <objbase.h>
#include <mmsystem.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <avrt.h>
#include <propsys.h>
#include <mediaobj.h>
#include <uuids.h>
#include <wmcodecdsp.h>
#include <mmreg.h>
#include <io.h>
#include <fcntl.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "avrt.lib")
#pragma comment(lib, "msdmo.lib")
#pragma comment(lib, "dmoguids.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "wmcodecdspuuid.lib")
#pragma comment(lib, "uuid.lib")

static const DWORD kRate = 24000;        // the wire format, both directions
static const DWORD kDspRate = 16000;     // what the AEC DSP is asked to put out
static const ULONGLONG kMicSettleMs = 600;

// ---- output -------------------------------------------------------------------

static std::mutex g_outMu;
static HANDLE g_stdout = INVALID_HANDLE_VALUE;
static HANDLE g_exitEvent = nullptr;
static std::atomic<int> g_exitCode{-1};

static void finish(int code) {
  int expected = -1;
  if (g_exitCode.compare_exchange_strong(expected, code)) SetEvent(g_exitEvent);
}

static void writeAll(const void* data, DWORD size) {
  const BYTE* p = static_cast<const BYTE*>(data);
  while (size > 0) {
    DWORD n = 0;
    if (!WriteFile(g_stdout, p, size, &n, nullptr) || n == 0) ExitProcess(0);  // bridge went away
    p += n;
    size -= n;
  }
}

static void sendFrame(char type, const void* payload, uint32_t len) {
  BYTE header[5];
  header[0] = static_cast<BYTE>(type);
  memcpy(header + 1, &len, 4);  // x86/x64/ARM64 Windows are little-endian
  std::lock_guard<std::mutex> lock(g_outMu);
  writeAll(header, 5);
  if (len) writeAll(payload, len);
}

static std::string jsonString(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
    else out += static_cast<char>(c);
  }
  return out + "\"";
}

static void sendJson(const std::string& json) { sendFrame('E', json.data(), static_cast<uint32_t>(json.size())); }

static void sendEvent(const char* type, const std::string& message = "", const char* code = nullptr) {
  std::string json = std::string("{\"type\":") + jsonString(type);
  if (code) json += std::string(",\"code\":") + jsonString(code);
  if (!message.empty()) json += ",\"message\":" + jsonString(message);
  sendJson(json + "}");
}

static std::string utf8(const wchar_t* w) {
  if (!w) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return "";
  std::string s(n - 1, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

static std::string describe(HRESULT hr) {
  char hex[16];
  snprintf(hex, sizeof hex, "0x%08lX", static_cast<unsigned long>(hr));
  wchar_t* text = nullptr;
  FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, hr, 0,
                 reinterpret_cast<wchar_t*>(&text), 0, nullptr);
  std::string msg = utf8(text);
  if (text) LocalFree(text);
  while (!msg.empty() && (msg.back() == '\n' || msg.back() == '\r' || msg.back() == ' ' || msg.back() == '.')) msg.pop_back();
  return msg.empty() ? std::string(hex) : msg + " (" + hex + ")";
}

static bool deviceGone(HRESULT hr) {
  return hr == AUDCLNT_E_DEVICE_INVALIDATED || hr == AUDCLNT_E_SERVICE_NOT_RUNNING || hr == AUDCLNT_E_RESOURCES_INVALIDATED;
}

static void deviceChanged() {
  if (g_exitCode.load() != -1) return;
  sendEvent("device-changed");
  finish(3);
}

template <class T> static void release(T*& p) {
  if (p) { p->Release(); p = nullptr; }
}

static WAVEFORMATEX wireFormat(DWORD rate) {
  WAVEFORMATEX f = {};
  f.wFormatTag = WAVE_FORMAT_PCM;
  f.nChannels = 1;
  f.nSamplesPerSec = rate;
  f.wBitsPerSample = 16;
  f.nBlockAlign = 2;
  f.nAvgBytesPerSec = rate * 2;
  return f;
}

// ---- microphone gate and resampling --------------------------------------------

// Opening the devices (and the DSP) can click: keep the mic closed for a moment
// so the click never reaches voice activity detection.
static std::atomic<ULONGLONG> g_micOpenAt{~0ull};

static void sendMic(const int16_t* samples, size_t count) {
  if (count == 0 || GetTickCount64() < g_micOpenAt.load()) return;
  sendFrame('A', samples, static_cast<uint32_t>(count * 2));
}

/** Linear-interpolation resampler for mono PCM16, keeping its phase across chunks. */
struct Resampler {
  double step;     // input samples per output sample
  double pos = 0;  // position of the next output sample, where 0 is `prev`
  int16_t prev = 0;
  std::vector<int16_t> out;

  Resampler(DWORD from, DWORD to) : step(static_cast<double>(from) / to) {}

  const std::vector<int16_t>& run(const int16_t* in, size_t n) {
    out.clear();
    if (n == 0) return out;
    auto at = [&](size_t i) { return i == 0 ? prev : in[i - 1]; };
    while (pos < static_cast<double>(n)) {
      size_t i = static_cast<size_t>(pos);
      double f = pos - static_cast<double>(i);
      double v = at(i) * (1.0 - f) + at(i + 1) * f;
      out.push_back(static_cast<int16_t>(v < -32768 ? -32768 : v > 32767 ? 32767 : v));
      pos += step;
    }
    pos -= static_cast<double>(n);
    prev = in[n - 1];
    return out;
  }
};

// ---- devices ----------------------------------------------------------------------

static IMMDeviceEnumerator* g_enumerator = nullptr;

/** Position of a device in EnumAudioEndpoints(flow, ACTIVE): the index the AEC DSP expects. */
static int deviceIndex(EDataFlow flow, IMMDevice* device) {
  LPWSTR wanted = nullptr;
  if (FAILED(device->GetId(&wanted))) return -1;
  int found = -1;
  IMMDeviceCollection* all = nullptr;
  UINT count = 0;
  if (SUCCEEDED(g_enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &all)) && SUCCEEDED(all->GetCount(&count))) {
    for (UINT i = 0; i < count && found < 0; i++) {
      IMMDevice* d = nullptr;
      LPWSTR id = nullptr;
      if (SUCCEEDED(all->Item(i, &d)) && SUCCEEDED(d->GetId(&id)) && wcscmp(id, wanted) == 0) found = static_cast<int>(i);
      if (id) CoTaskMemFree(id);
      release(d);
    }
  }
  release(all);
  CoTaskMemFree(wanted);
  return found;
}

/** Restarts the helper when the default speakers or microphone change (headphones in or out). */
class DeviceWatcher : public IMMNotificationClient {
  LONG refs_ = 1;

 public:
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&refs_); }  // static lifetime
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMMNotificationClient)) {
      *out = static_cast<IMMNotificationClient*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE OnDefaultDeviceChanged(EDataFlow, ERole role, LPCWSTR) override {
    if (role == eConsole) deviceChanged();
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE OnDeviceStateChanged(LPCWSTR, DWORD) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE OnDeviceAdded(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE OnDeviceRemoved(LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE OnPropertyValueChanged(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};

static DeviceWatcher g_watcher;

// ---- playback -------------------------------------------------------------------

struct Chunk {
  uint32_t seq;
  std::vector<int16_t> pcm;
  size_t pos = 0;
};
struct Mark {
  uint32_t seq;
  uint64_t endFrame;  // in frames written since the last reset
};

static std::mutex g_playMu;  // guards everything below and the render client calls
static std::deque<Chunk> g_queue;
static std::deque<Mark> g_marks;
static uint64_t g_written = 0;
static UINT64 g_clockBase = 0;
static IAudioClient* g_renderClient = nullptr;
static IAudioRenderClient* g_render = nullptr;
static IAudioClock* g_clock = nullptr;
static UINT64 g_clockFreq = 1;
static UINT32 g_renderFrames = 0;
static HANDLE g_renderEvent = nullptr;

static HRESULT startPlayback(IMMDevice* speakers) {
  HRESULT hr = speakers->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&g_renderClient));
  if (FAILED(hr)) return hr;
  WAVEFORMATEX f = wireFormat(kRate);
  // Windows converts 24 kHz mono to whatever the device mixes at.
  hr = g_renderClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                  AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                  400000 /* 40 ms */, 0, &f, nullptr);
  if (FAILED(hr)) return hr;
  g_renderEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (FAILED(hr = g_renderClient->SetEventHandle(g_renderEvent))) return hr;
  if (FAILED(hr = g_renderClient->GetBufferSize(&g_renderFrames))) return hr;
  if (FAILED(hr = g_renderClient->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(&g_render)))) return hr;
  if (FAILED(hr = g_renderClient->GetService(__uuidof(IAudioClock), reinterpret_cast<void**>(&g_clock)))) return hr;
  if (FAILED(hr = g_clock->GetFrequency(&g_clockFreq)) || g_clockFreq == 0) return FAILED(hr) ? hr : E_FAIL;
  // Prefill with silence, then keep the stream running for good: it stays the
  // echo reference, and the played position keeps moving.
  BYTE* data = nullptr;
  if (SUCCEEDED(g_render->GetBuffer(g_renderFrames, &data))) g_render->ReleaseBuffer(g_renderFrames, AUDCLNT_BUFFERFLAGS_SILENT);
  g_written = g_renderFrames;
  return g_renderClient->Start();
}

/** Fills free space in the device buffer with queued speech (or silence); reports what has played. Holds g_playMu. */
static HRESULT renderStep() {
  UINT32 padding = 0;
  HRESULT hr = g_renderClient->GetCurrentPadding(&padding);
  if (FAILED(hr)) return hr;
  UINT32 room = g_renderFrames - padding;
  if (room > 0) {
    BYTE* data = nullptr;
    if (FAILED(hr = g_render->GetBuffer(room, &data))) return hr;
    int16_t* dst = reinterpret_cast<int16_t*>(data);
    UINT32 filled = 0;
    while (filled < room && !g_queue.empty()) {
      Chunk& c = g_queue.front();
      size_t n = std::min<size_t>(room - filled, c.pcm.size() - c.pos);
      memcpy(dst + filled, c.pcm.data() + c.pos, n * 2);
      filled += static_cast<UINT32>(n);
      c.pos += n;
      if (c.pos >= c.pcm.size()) {
        g_marks.push_back({c.seq, g_written + filled});
        g_queue.pop_front();
      }
    }
    if (filled < room) memset(dst + filled, 0, (room - filled) * 2);
    if (FAILED(hr = g_render->ReleaseBuffer(room, 0))) return hr;
    g_written += room;
  }
  UINT64 position = 0;
  if (SUCCEEDED(g_clock->GetPosition(&position, nullptr)) && position >= g_clockBase) {
    uint64_t played = (position - g_clockBase) * kRate / g_clockFreq;
    while (!g_marks.empty() && g_marks.front().endFrame <= played) {
      uint32_t seq = g_marks.front().seq;
      g_marks.pop_front();
      sendFrame('P', &seq, 4);
    }
  }
  return S_OK;
}

static void renderLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  while (g_exitCode.load() == -1) {
    WaitForSingleObject(g_renderEvent, 200);
    HRESULT hr;
    {
      std::lock_guard<std::mutex> lock(g_playMu);
      hr = renderStep();
    }
    if (FAILED(hr)) {
      if (deviceGone(hr)) deviceChanged();
      else { sendEvent("error", "playback failed: " + describe(hr), "playback"); finish(1); }
      break;
    }
  }
  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

static void play(uint32_t seq, const BYTE* pcm, size_t bytes) {
  size_t count = bytes / 2;
  if (count == 0) return;
  Chunk c{seq, std::vector<int16_t>(count)};
  memcpy(c.pcm.data(), pcm, count * 2);
  std::lock_guard<std::mutex> lock(g_playMu);
  g_queue.push_back(std::move(c));
}

static void flush() {
  {
    std::lock_guard<std::mutex> lock(g_playMu);
    g_queue.clear();
    g_marks.clear();
    // Drop what the device still holds, at once.
    g_renderClient->Stop();
    g_renderClient->Reset();
    g_written = 0;
    g_clockBase = 0;
    g_clock->GetPosition(&g_clockBase, nullptr);
    g_renderClient->Start();
  }
  SetEvent(g_renderEvent);
  sendEvent("flushed");
}

// ---- capture: raw WASAPI ----------------------------------------------------------

static IAudioClient* g_captureClient = nullptr;
static IAudioCaptureClient* g_capture = nullptr;
static HANDLE g_captureEvent = nullptr;

static HRESULT startRawCapture(IMMDevice* mic) {
  HRESULT hr = mic->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&g_captureClient));
  if (FAILED(hr)) return hr;
  WAVEFORMATEX f = wireFormat(kRate);
  hr = g_captureClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                   AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                   1000000 /* 100 ms */, 0, &f, nullptr);
  if (FAILED(hr)) return hr;
  g_captureEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (FAILED(hr = g_captureClient->SetEventHandle(g_captureEvent))) return hr;
  if (FAILED(hr = g_captureClient->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&g_capture)))) return hr;
  return g_captureClient->Start();
}

static void rawCaptureLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  std::vector<int16_t> silence;
  while (g_exitCode.load() == -1) {
    WaitForSingleObject(g_captureEvent, 200);
    UINT32 packet = 0;
    HRESULT hr;
    while (SUCCEEDED(hr = g_capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(hr = g_capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
        silence.assign(frames, 0);
        sendMic(silence.data(), frames);
      } else {
        sendMic(reinterpret_cast<const int16_t*>(data), frames);
      }
      g_capture->ReleaseBuffer(frames);
    }
    if (FAILED(hr)) {
      if (deviceGone(hr)) deviceChanged();
      else { sendEvent("error", "microphone failed: " + describe(hr), "capture"); finish(1); }
      break;
    }
  }
  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

// ---- capture: Voice Capture DSP (echo cancellation + noise suppression) ----------

/** The output buffer the DSP writes processed mic audio into. */
class MediaBuffer : public IMediaBuffer {
  LONG refs_ = 1;
  std::vector<BYTE> data_;
  DWORD length_ = 0;

 public:
  explicit MediaBuffer(DWORD capacity) : data_(capacity) {}
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override { return InterlockedDecrement(&refs_); }  // owned by this program
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IMediaBuffer)) {
      *out = static_cast<IMediaBuffer*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  HRESULT STDMETHODCALLTYPE SetLength(DWORD length) override {
    if (length > data_.size()) return E_INVALIDARG;
    length_ = length;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetMaxLength(DWORD* max) override {
    if (!max) return E_POINTER;
    *max = static_cast<DWORD>(data_.size());
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GetBufferAndLength(BYTE** buffer, DWORD* length) override {
    if (buffer) *buffer = data_.data();
    if (length) *length = length_;
    return S_OK;
  }
};

static IMediaObject* g_dsp = nullptr;
static MediaBuffer g_dspBuffer(kDspRate * 2);  // one second of 16-bit mono
static Resampler g_dspResampler(kDspRate, kRate);

static HRESULT setProp(IPropertyStore* store, const PROPERTYKEY& key, VARTYPE type, LONG value) {
  PROPVARIANT v;
  PropVariantInit(&v);
  v.vt = type;
  if (type == VT_BOOL) v.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  else v.lVal = value;
  HRESULT hr = store->SetValue(key, v);
  PropVariantClear(&v);
  return hr;
}

/** Pulls whatever the DSP has processed and sends it on. */
static HRESULT pumpDsp() {
  DMO_OUTPUT_DATA_BUFFER out = {};
  out.pBuffer = &g_dspBuffer;
  do {
    g_dspBuffer.SetLength(0);
    out.dwStatus = 0;
    DWORD status = 0;
    HRESULT hr = g_dsp->ProcessOutput(0, 1, &out, &status);
#ifdef WMAAECMA_E_NO_ACTIVE_RENDER_STREAM
    if (hr == WMAAECMA_E_NO_ACTIVE_RENDER_STREAM) return S_OK;  // nothing to cancel against yet
#endif
    if (FAILED(hr)) return hr;
    BYTE* data = nullptr;
    DWORD length = 0;
    g_dspBuffer.GetBufferAndLength(&data, &length);
    if (length >= 2) {
      const auto& up = g_dspResampler.run(reinterpret_cast<const int16_t*>(data), length / 2);
      sendMic(up.data(), up.size());
    }
  } while (out.dwStatus & DMO_OUTPUT_DATA_BUFFERF_INCOMPLETE);
  return S_OK;
}

static HRESULT startDsp(IMMDevice* mic, IMMDevice* speakers) {
  HRESULT hr = CoCreateInstance(CLSID_CWMAudioAEC, nullptr, CLSCTX_INPROC_SERVER, __uuidof(IMediaObject), reinterpret_cast<void**>(&g_dsp));
  if (FAILED(hr)) return hr;
  IPropertyStore* props = nullptr;
  if (FAILED(hr = g_dsp->QueryInterface(__uuidof(IPropertyStore), reinterpret_cast<void**>(&props)))) return hr;

  int micIndex = deviceIndex(eCapture, mic);
  int speakerIndex = deviceIndex(eRender, speakers);
  if (micIndex < 0 || speakerIndex < 0) {
    release(props);
    return E_FAIL;
  }
  // The DSP opens the devices itself (source mode) and takes the echo reference
  // from the same speakers the playback stream above plays to.
  hr = setProp(props, MFPKEY_WMAAECMA_SYSTEM_MODE, VT_I4, SINGLE_CHANNEL_AEC);
  if (SUCCEEDED(hr)) hr = setProp(props, MFPKEY_WMAAECMA_DMO_SOURCE_MODE, VT_BOOL, 1);
  if (SUCCEEDED(hr)) hr = setProp(props, MFPKEY_WMAAECMA_DEVICE_INDEXES, VT_I4, static_cast<LONG>((speakerIndex << 16) | (micIndex & 0xFFFF)));
  // Feature mode lets us choose: noise suppression on, automatic gain off (the
  // realtime model's VAD expects a steady level).
  if (SUCCEEDED(hr)) hr = setProp(props, MFPKEY_WMAAECMA_FEATURE_MODE, VT_BOOL, 1);
  if (SUCCEEDED(hr)) hr = setProp(props, MFPKEY_WMAAECMA_FEATR_NS, VT_I4, 1);
  if (SUCCEEDED(hr)) hr = setProp(props, MFPKEY_WMAAECMA_FEATR_AGC, VT_BOOL, 0);
  release(props);
  if (FAILED(hr)) return hr;

  DMO_MEDIA_TYPE type = {};
  if (FAILED(hr = MoInitMediaType(&type, sizeof(WAVEFORMATEX)))) return hr;
  type.majortype = MEDIATYPE_Audio;
  type.subtype = MEDIASUBTYPE_PCM;
  type.lSampleSize = 0;
  type.bFixedSizeSamples = TRUE;
  type.bTemporalCompression = FALSE;
  type.formattype = FORMAT_WaveFormatEx;
  *reinterpret_cast<WAVEFORMATEX*>(type.pbFormat) = wireFormat(kDspRate);
  hr = g_dsp->SetOutputType(0, &type, 0);
  MoFreeMediaType(&type);
  if (FAILED(hr)) return hr;
  if (FAILED(hr = g_dsp->AllocateStreamingResources())) return hr;
  // One pull now, so a DSP that cannot open the devices fails here, before "ready".
  Sleep(50);
  return pumpDsp();
}

static void dspLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD taskIndex = 0;
  HANDLE task = AvSetMmThreadCharacteristicsW(L"Pro Audio", &taskIndex);
  while (g_exitCode.load() == -1) {
    Sleep(10);
    HRESULT hr = pumpDsp();
    if (FAILED(hr)) {
      if (deviceGone(hr)) deviceChanged();
      else { sendEvent("error", "echo-cancelled microphone failed: " + describe(hr), "capture"); finish(1); }
      break;
    }
  }
  if (task) AvRevertMmThreadCharacteristics(task);
  CoUninitialize();
}

// ---- stdin ------------------------------------------------------------------------

static void stdinLoop() {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  std::vector<BYTE> buffer;
  BYTE chunk[65536];
  for (;;) {
    DWORD n = 0;
    if (!ReadFile(in, chunk, sizeof chunk, &n, nullptr) || n == 0) break;  // bridge closed stdin
    buffer.insert(buffer.end(), chunk, chunk + n);
    size_t at = 0;
    while (buffer.size() - at >= 5) {
      uint32_t len = 0;
      memcpy(&len, &buffer[at + 1], 4);
      if (buffer.size() - at < 5ull + len) break;
      char type = static_cast<char>(buffer[at]);
      const BYTE* payload = buffer.data() + at + 5;
      at += 5ull + len;
      if (type == 'A' && len >= 4) {
        uint32_t seq = 0;
        memcpy(&seq, payload, 4);
        play(seq, payload + 4, len - 4);
      } else if (type == 'F') {
        flush();
      } else if (type == 'Q') {
        finish(0);
        return;
      }
    }
    buffer.erase(buffer.begin(), buffer.begin() + static_cast<std::ptrdiff_t>(at));
  }
  finish(0);
}

// ---- main ------------------------------------------------------------------------

static int fail(int code, const char* kind, const std::string& message) {
  sendEvent("error", message, kind);
  return code;
}

int main(int argc, char** argv) {
  bool voiceProcessing = false;
  for (int i = 1; i < argc; i++)
    if (strcmp(argv[i], "--voice-processing") == 0) voiceProcessing = true;

  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
  g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
  g_exitEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

  HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(hr)) return fail(1, "com", "COM failed to start: " + describe(hr));
  hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&g_enumerator));
  if (FAILED(hr)) return fail(1, "devices", "cannot list audio devices: " + describe(hr));

  IMMDevice* speakers = nullptr;
  IMMDevice* mic = nullptr;
  if (FAILED(hr = g_enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &speakers)))
    return fail(1, "no-output", "No speakers or headphones found: " + describe(hr));
  if (FAILED(hr = g_enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &mic)))
    return fail(1, "no-input", "No microphone found: " + describe(hr));

  if (FAILED(hr = startPlayback(speakers))) return fail(1, "engine", "audio playback failed to start: " + describe(hr));

  bool dspOn = false;
  if (voiceProcessing) {
    hr = startDsp(mic, speakers);
    if (FAILED(hr)) {
      // Some device setups refuse the DSP: the bridge starts again without it, and says so.
      std::string why = hr == E_ACCESSDENIED ? "microphone access is off for desktop apps" : describe(hr);
      sendEvent("warning", "Echo cancellation could not start (" + why + "); use headphones so barge-in does not hear Claude.");
      return 4;
    }
    dspOn = true;
  } else if (FAILED(hr = startRawCapture(mic))) {
    if (hr == E_ACCESSDENIED)
      return fail(2, "mic-denied",
                  "Microphone access denied. Turn on Settings > Privacy & security > Microphone > Let desktop apps access your microphone.");
    return fail(1, "engine", "microphone failed to start: " + describe(hr));
  }

  g_enumerator->RegisterEndpointNotificationCallback(&g_watcher);

  g_micOpenAt = GetTickCount64() + kMicSettleMs;
  char ready[160];
  snprintf(ready, sizeof ready, "{\"type\":\"ready\",\"inputRate\":%lu,\"inputChannels\":1,\"voiceProcessing\":%s}",
           static_cast<unsigned long>(dspOn ? kDspRate : kRate), dspOn ? "true" : "false");
  sendJson(ready);

  std::thread(renderLoop).detach();
  std::thread(dspOn ? dspLoop : rawCaptureLoop).detach();
  std::thread(stdinLoop).detach();

  WaitForSingleObject(g_exitEvent, INFINITE);
  int code = g_exitCode.load();
  g_enumerator->UnregisterEndpointNotificationCallback(&g_watcher);
  {
    std::lock_guard<std::mutex> lock(g_playMu);
    g_renderClient->Stop();
  }
  if (g_captureClient) g_captureClient->Stop();
  {
    std::lock_guard<std::mutex> lock(g_outMu);  // let a frame being written finish
  }
  ExitProcess(static_cast<UINT>(code < 0 ? 0 : code));
}
